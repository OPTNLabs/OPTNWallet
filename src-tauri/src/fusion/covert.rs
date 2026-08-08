// CashFusion round — Phase 1.4b: covert connection + submission.
//
// During a round each component (and later each input signature) is submitted on
// its OWN connection to the covert server (FusionBegin's covert_domain/port),
// each over a FRESH Tor circuit. Because the connections are unlinkable at the
// network layer (separate circuits) and the components carry only a blind
// signature (not the player's identity), the server can't tie a submitted
// component back to the player who committed to it — that unlinkability is the
// whole point of the covert phase.
//
// Connections are opened EARLY (in the connect window) and kept alive with pings,
// then used to submit LATER (in the submit window), so connect timing can't be
// correlated with submit timing. This module is the per-connection primitive;
// the multi-connection scheduler with randomized timing sits on top (in the
// round orchestration, wired when the full run_round lands).
//
// Wire: the same magic-framed transport as the main connection (comms.py
// send_pb/recv_pb), carrying CovertMessage (client->server) and CovertResponse.

use std::time::{Duration, Instant};

use futures_util::future::join_all;
use prost::Message;
use rand_core::{OsRng, RngCore};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::task::JoinHandle;

use super::round_cancel::CancelFlag;
use super::{connect_stream, pb, recv_frame, send_frame, FusionStream, Transport};

/// One covert connection to the covert server, kept open across ping + submit.
pub struct CovertConnection {
    stream: FusionStream,
}

impl CovertConnection {
    /// Open a covert connection. Callers give this its own fresh Tor circuit by
    /// passing a `Transport::Tor` (connect_stream uses a new isolation token per
    /// call), which is what makes covert submissions unlinkable.
    pub async fn open(
        host: &str,
        port: u16,
        use_ssl: bool,
        transport: Transport<'_>,
    ) -> Result<Self, String> {
        Ok(Self {
            stream: connect_stream(host, port, use_ssl, transport).await?,
        })
    }

    /// Keepalive so the connection, opened early, survives until submit time.
    pub async fn ping(&mut self) -> Result<(), String> {
        send_ping(&mut self.stream).await
    }

    /// Submit one covert message (a serialized CovertMessage — build it with
    /// session::build_covert_component or build_covert_signature) and require an
    /// OK response.
    pub async fn submit(&mut self, covert_message: &[u8]) -> Result<(), String> {
        submit_on(&mut self.stream, covert_message).await
    }

    async fn close(mut self) {
        let _ = self.stream.shutdown().await;
    }
}

#[derive(Clone)]
enum OwnedTransport {
    Direct,
    Tor { host: String, port: u16 },
}

impl OwnedTransport {
    fn from_borrowed(transport: Transport<'_>) -> Self {
        match transport {
            Transport::Direct => Self::Direct,
            Transport::Tor { host, port } => Self::Tor {
                host: host.to_string(),
                port,
            },
        }
    }

    fn borrowed(&self) -> Transport<'_> {
        match self {
            Self::Direct => Transport::Direct,
            Self::Tor { host, port } => Transport::Tor { host, port: *port },
        }
    }
}

struct CovertChannel {
    connection: CovertConnection,
    action_delay: Duration,
}

/// Pending covert connections started during the privacy warmup. Dropping the
/// schedule aborts every still-pending task, so an early main-channel error
/// cannot leave detached Tor work running in the background.
pub struct CovertSchedule {
    handles: Vec<JoinHandle<Result<CovertChannel, String>>>,
    slot_count: usize,
}

impl CovertSchedule {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        host: &str,
        port: u16,
        use_ssl: bool,
        transport: Transport<'_>,
        slot_count: usize,
        spare_count: usize,
        connect_start: Instant,
        connect_window: Duration,
        action_window: Duration,
        connect_timeout: Duration,
        cancel: &CancelFlag,
    ) -> Self {
        let owned_transport = OwnedTransport::from_borrowed(transport);
        let mut handles = Vec::with_capacity(slot_count.saturating_add(spare_count));

        for _ in 0..slot_count.saturating_add(spare_count) {
            let host = host.to_string();
            let transport = owned_transport.clone();
            let cancel = cancel.clone();
            let connect_at = connect_start + random_duration(connect_window);
            let action_delay = random_duration(action_window);
            handles.push(tokio::spawn(async move {
                wait_until_or_cancel(connect_at, &cancel).await?;
                let open = CovertConnection::open(&host, port, use_ssl, transport.borrowed());
                let connection = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("fusion round cancelled".into()),
                    result = tokio::time::timeout(connect_timeout, open) => {
                        result
                            .map_err(|_| "covert connection timed out".to_string())??
                    }
                };
                Ok(CovertChannel {
                    connection,
                    action_delay,
                })
            }));
        }

        Self {
            handles,
            slot_count,
        }
    }

    /// Resolve the randomized warmup attempts. Up to `spare_count` failures are
    /// tolerated, but every component slot must have a live isolated channel.
    pub async fn finish(
        mut self,
        deadline: Instant,
        cancel: &CancelFlag,
    ) -> Result<CovertPool, String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("covert connections were not ready before component disclosure".into());
        }

        let joined = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("fusion round cancelled".into()),
            result = tokio::time::timeout(remaining, join_all(self.handles.iter_mut())) => {
                result.map_err(|_| "covert connections were too slow".to_string())?
            }
        };

        let mut channels = Vec::new();
        let mut failures = Vec::new();
        for result in joined {
            match result {
                Ok(Ok(channel)) => channels.push(channel),
                Ok(Err(error)) => failures.push(error),
                Err(error) => failures.push(format!("covert connection task failed: {error}")),
            }
        }
        self.handles.clear();

        if channels.len() < self.slot_count {
            return Err(format!(
                "covert connections were too slow ({} ready, {} required; {})",
                channels.len(),
                self.slot_count,
                failures
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "no spare connection remained".into())
            ));
        }

        shuffle_channels(&mut channels);
        let spares = channels.split_off(self.slot_count);
        Ok(CovertPool {
            slots: channels,
            spares,
            retired: Vec::new(),
            close_start: Instant::now(),
        })
    }
}

impl Drop for CovertSchedule {
    fn drop(&mut self) {
        for handle in &self.handles {
            handle.abort();
        }
    }
}

/// Live covert channels. A slot is retained across both submission phases, so
/// a component and its later transaction signature use the same independently
/// delayed Tor circuit, matching Electron Cash's privacy schedule.
pub struct CovertPool {
    slots: Vec<CovertChannel>,
    spares: Vec<CovertChannel>,
    retired: Vec<CovertChannel>,
    close_start: Instant,
}

struct ActionResult {
    index: usize,
    is_spare: bool,
    channel: CovertChannel,
    message: Option<Vec<u8>>,
    result: Result<(), String>,
}

impl CovertPool {
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }

    /// Set the protocol-relative beginning of the randomized close window.
    /// Each channel retains its own action delay, so close timing cannot group
    /// this wallet's otherwise unlinkable covert connections.
    pub fn set_close_start(&mut self, close_start: Instant) {
        self.close_start = close_start;
    }

    /// Submit one message per component slot. `None` sends a keepalive so slots
    /// and spares remain indistinguishable. Failed slots are retried on a spare,
    /// but never beyond the server's acceptance deadline.
    pub async fn submit_phase(
        &mut self,
        phase_start: Instant,
        deadline: Instant,
        submit_timeout: Duration,
        messages: Vec<Option<Vec<u8>>>,
        cancel: &CancelFlag,
    ) -> Result<(), String> {
        if messages.len() != self.slots.len() {
            return Err("covert message count does not match component slots".into());
        }
        if Instant::now() > phase_start {
            return Err("covert submission phase started too slowly".into());
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("covert submission deadline elapsed".into());
        }

        let slot_count = self.slots.len();
        let slots = std::mem::take(&mut self.slots);
        let spares = std::mem::take(&mut self.spares);
        let mut actions = Vec::with_capacity(slots.len() + spares.len());

        for (index, (channel, message)) in slots.into_iter().zip(messages).enumerate() {
            actions.push(run_scheduled_action(
                index,
                false,
                channel,
                message,
                phase_start,
                submit_timeout,
            ));
        }
        for (index, channel) in spares.into_iter().enumerate() {
            actions.push(run_scheduled_action(
                index,
                true,
                channel,
                None,
                phase_start,
                submit_timeout,
            ));
        }

        // Every scheduled operation has its own bounded timeout. Do not wrap
        // the group in a cancelling timeout: cancelling join_all would drop all
        // live sockets at once and reveal that they belong to one participant.
        let results = join_all(actions).await;

        let mut slot_results = Vec::with_capacity(slot_count);
        let mut usable_spares = Vec::new();
        let mut retired_channels = std::mem::take(&mut self.retired);
        for result in results {
            if result.is_spare {
                if result.result.is_ok() {
                    usable_spares.push(result.channel);
                } else {
                    retired_channels.push(result.channel);
                }
            } else {
                slot_results.push(result);
            }
        }
        slot_results.sort_by_key(|result| result.index);

        let mut restored_slots = Vec::with_capacity(slot_count);
        let mut phase_error = None;
        for result in slot_results {
            if result.result.is_ok() {
                restored_slots.push(result.channel);
                continue;
            }

            let mut last_error = result
                .result
                .err()
                .unwrap_or_else(|| "covert channel failed".into());
            let mut replacement = None;
            while let Some(mut spare) = usable_spares.pop() {
                if let Some(message) = result.message.as_deref() {
                    match submit_before_deadline(
                        &mut spare.connection,
                        message,
                        deadline,
                        submit_timeout,
                        cancel,
                    )
                    .await
                    {
                        Ok(()) => {
                            replacement = Some(spare);
                            break;
                        }
                        Err(error) => {
                            last_error = error;
                            retired_channels.push(spare);
                        }
                    }
                } else {
                    replacement = Some(spare);
                    break;
                }
            }

            if let Some(replacement) = replacement {
                retired_channels.push(result.channel);
                restored_slots.push(replacement);
            } else {
                restored_slots.push(result.channel);
                phase_error.get_or_insert_with(|| {
                    format!("covert connections failed and no spare remained: {last_error}")
                });
            }
        }

        self.slots = restored_slots;
        self.spares = usable_spares;
        self.retired = retired_channels;
        match phase_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl Drop for CovertPool {
    fn drop(&mut self) {
        // If a slow/blame round outlived the protocol close window, start a
        // fresh spread now. Sleeping every channel until an already-past
        // instant would collapse all closures into one identifying event.
        let close_start = self.close_start.max(Instant::now());
        let mut channels = std::mem::take(&mut self.slots);
        channels.extend(std::mem::take(&mut self.spares));
        channels.extend(std::mem::take(&mut self.retired));

        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                for channel in channels {
                    let close_at = close_start + channel.action_delay;
                    runtime.spawn(async move {
                        tokio::time::sleep_until(close_at.into()).await;
                        channel.connection.close().await;
                    });
                }
            }
            Err(_) => {
                // A pool normally drops inside Tauri's Tokio runtime. Keep the
                // same privacy property in unusual test/shutdown contexts by
                // moving the sockets to one detached close scheduler.
                let _ = std::thread::Builder::new()
                    .name("cashfusion-covert-close".into())
                    .spawn(move || {
                        channels.sort_by_key(|channel| channel.action_delay);
                        for channel in channels {
                            let delay = (close_start + channel.action_delay)
                                .saturating_duration_since(Instant::now());
                            std::thread::sleep(delay);
                            drop(channel);
                        }
                    });
            }
        }
    }
}

async fn run_scheduled_action(
    index: usize,
    is_spare: bool,
    mut channel: CovertChannel,
    message: Option<Vec<u8>>,
    phase_start: Instant,
    submit_timeout: Duration,
) -> ActionResult {
    let action_at = phase_start + channel.action_delay;
    if action_at > Instant::now() {
        tokio::time::sleep(action_at - Instant::now()).await;
    }
    let operation = async {
        if let Some(message) = message.as_deref() {
            channel.connection.submit(message).await
        } else {
            channel.connection.ping().await
        }
    };
    let result = tokio::time::timeout(submit_timeout, operation)
        .await
        .map_err(|_| "covert submission timed out".to_string())
        .and_then(|result| result);
    ActionResult {
        index,
        is_spare,
        channel,
        message,
        result,
    }
}

async fn submit_before_deadline(
    connection: &mut CovertConnection,
    message: &[u8],
    deadline: Instant,
    submit_timeout: Duration,
    cancel: &CancelFlag,
) -> Result<(), String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("covert retry missed the server deadline".into());
    }
    let timeout = remaining.min(submit_timeout);
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("fusion round cancelled".into()),
        result = tokio::time::timeout(timeout, connection.submit(message)) => {
            result
                .map_err(|_| "covert retry timed out".to_string())?
        }
    }
}

async fn wait_until_or_cancel(at: Instant, cancel: &CancelFlag) -> Result<(), String> {
    let remaining = at.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return cancel.check();
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("fusion round cancelled".into()),
        _ = tokio::time::sleep(remaining) => Ok(()),
    }
}

fn random_duration(window: Duration) -> Duration {
    if window.is_zero() {
        return Duration::ZERO;
    }
    let fraction = rand_trapezoid();
    Duration::from_secs_f64(window.as_secs_f64() * fraction)
}

fn rand_trapezoid() -> f64 {
    let uniform = (OsRng.next_u64() >> 11) as f64 / ((1u64 << 53) as f64);
    let complement = 1.0 - uniform;
    if uniform < 1.0 / 6.0 {
        (0.375 * uniform).sqrt()
    } else if complement < 1.0 / 6.0 {
        1.0 - (0.375 * complement).sqrt()
    } else {
        0.75 * uniform + 0.125
    }
}

fn shuffle_channels(channels: &mut [CovertChannel]) {
    for index in (1..channels.len()).rev() {
        let swap_with = (OsRng.next_u64() as usize) % (index + 1);
        channels.swap(index, swap_with);
    }
}

/// Send a covert keepalive ping (CovertMessage{Ping}). Fire-and-forget.
async fn send_ping<S>(stream: &mut S) -> Result<(), String>
where
    S: AsyncWrite + Unpin,
{
    let msg = pb::CovertMessage {
        msg: Some(pb::covert_message::Msg::Ping(pb::Ping {})),
    };
    send_frame(stream, &msg.encode_to_vec()).await
}

/// Send a pre-serialized CovertMessage and require the server's CovertResponse
/// to be OK; a server Error (or anything else) is surfaced.
async fn submit_on<S>(stream: &mut S, covert_message: &[u8]) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    send_frame(stream, covert_message).await?;
    let raw = recv_frame(stream).await?;
    let resp = pb::CovertResponse::decode(raw.as_slice())
        .map_err(|e| format!("could not decode covert response: {e}"))?;
    match resp.msg {
        Some(pb::covert_response::Msg::Ok(_)) => Ok(()),
        Some(pb::covert_response::Msg::Error(e)) => Err(format!(
            "covert submission rejected: {}",
            e.message.unwrap_or_default()
        )),
        None => Err("empty covert response".into()),
    }
}

/// Serialize a `CovertTransactionSignature` (an input's signature) as a
/// CovertMessage for the signing phase (1.5).
pub fn build_covert_signature(
    round_pubkey: &[u8],
    which_input: u32,
    txsignature: &[u8],
) -> Vec<u8> {
    let msg = pb::CovertMessage {
        msg: Some(pb::covert_message::Msg::Signature(
            pb::CovertTransactionSignature {
                round_pubkey: Some(round_pubkey.to_vec()),
                which_input,
                txsignature: txsignature.to_vec(),
            },
        )),
    };
    msg.encode_to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_response() -> Vec<u8> {
        pb::CovertResponse {
            msg: Some(pb::covert_response::Msg::Ok(pb::Ok {})),
        }
        .encode_to_vec()
    }
    fn err_response(m: &str) -> Vec<u8> {
        pb::CovertResponse {
            msg: Some(pb::covert_response::Msg::Error(pb::Error {
                message: Some(m.into()),
            })),
        }
        .encode_to_vec()
    }

    #[test]
    fn submit_sends_covert_message_and_accepts_ok() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let covert = super::super::session::build_covert_component(
                &[0x02u8; 33],
                &[0x11u8; 64],
                &[1, 2, 3],
            );
            let covert_clone = covert.clone();

            let server_task = tokio::spawn(async move {
                let raw = recv_frame(&mut server).await.unwrap();
                // The server must receive exactly the CovertMessage we submitted.
                assert_eq!(raw, covert_clone);
                let m = pb::CovertMessage::decode(raw.as_slice()).unwrap();
                assert!(matches!(m.msg, Some(pb::covert_message::Msg::Component(_))));
                send_frame(&mut server, &ok_response()).await.unwrap();
            });

            submit_on(&mut client, &covert).await.unwrap();
            server_task.await.unwrap();
        });
    }

    #[test]
    fn submit_surfaces_a_server_error() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let server_task = tokio::spawn(async move {
                let _ = recv_frame(&mut server).await.unwrap();
                send_frame(&mut server, &err_response("bad component"))
                    .await
                    .unwrap();
            });
            let err = submit_on(&mut client, b"anything").await.unwrap_err();
            server_task.await.unwrap();
            assert!(err.contains("bad component"), "unexpected: {err}");
        });
    }

    #[test]
    fn ping_is_a_covert_ping_message() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(1024);
            let server_task = tokio::spawn(async move {
                let raw = recv_frame(&mut server).await.unwrap();
                let m = pb::CovertMessage::decode(raw.as_slice()).unwrap();
                assert!(matches!(m.msg, Some(pb::covert_message::Msg::Ping(_))));
            });
            send_ping(&mut client).await.unwrap();
            server_task.await.unwrap();
        });
    }

    #[test]
    fn covert_signature_round_trips() {
        let raw = build_covert_signature(&[0x03u8; 33], 5, &[0xaa; 64]);
        let m = pb::CovertMessage::decode(raw.as_slice()).unwrap();
        match m.msg {
            Some(pb::covert_message::Msg::Signature(s)) => {
                assert_eq!(s.which_input, 5);
                assert_eq!(s.txsignature, vec![0xaa; 64]);
            }
            _ => panic!("expected a CovertTransactionSignature"),
        }
    }
}

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

use prost::Message;
use tokio::io::{AsyncRead, AsyncWrite};

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
        Ok(Self { stream: connect_stream(host, port, use_ssl, transport).await? })
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
        Some(pb::covert_response::Msg::Error(e)) => {
            Err(format!("covert submission rejected: {}", e.message.unwrap_or_default()))
        }
        None => Err("empty covert response".into()),
    }
}

/// Serialize a `CovertTransactionSignature` (an input's signature) as a
/// CovertMessage for the signing phase (1.5).
pub fn build_covert_signature(round_pubkey: &[u8], which_input: u32, txsignature: &[u8]) -> Vec<u8> {
    let msg = pb::CovertMessage {
        msg: Some(pb::covert_message::Msg::Signature(pb::CovertTransactionSignature {
            round_pubkey: Some(round_pubkey.to_vec()),
            which_input,
            txsignature: txsignature.to_vec(),
        })),
    };
    msg.encode_to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_response() -> Vec<u8> {
        pb::CovertResponse { msg: Some(pb::covert_response::Msg::Ok(pb::Ok {})) }.encode_to_vec()
    }
    fn err_response(m: &str) -> Vec<u8> {
        pb::CovertResponse {
            msg: Some(pb::covert_response::Msg::Error(pb::Error { message: Some(m.into()) })),
        }
        .encode_to_vec()
    }

    #[test]
    fn submit_sends_covert_message_and_accepts_ok() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let covert = super::super::session::build_covert_component(&[0x02u8; 33], &[0x11u8; 64], &[1, 2, 3]);
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
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let server_task = tokio::spawn(async move {
                let _ = recv_frame(&mut server).await.unwrap();
                send_frame(&mut server, &err_response("bad component")).await.unwrap();
            });
            let err = submit_on(&mut client, b"anything").await.unwrap_err();
            server_task.await.unwrap();
            assert!(err.contains("bad component"), "unexpected: {err}");
        });
    }

    #[test]
    fn ping_is_a_covert_ping_message() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
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

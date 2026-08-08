// CashFusion round — Phase 1, milestone 1.1: setup + pool join + tier status.
//
// This is the first step past the read-only `server_status` handshake: it
// actually JOINS the server's waiting pool and streams back the live tier
// occupancy (how many players are queued at each fusion tier), plus the
// `FusionBegin` signal the server sends once a tier has enough players to start.
//
// It deliberately stops there — it does NOT yet build components, commit, run
// the covert phase, sign, or broadcast. Those need the blind-signature and
// Pedersen-commitment crypto and the covert Tor connections, which are the
// subsequent milestones (1.2–1.7) and are security-critical enough not to rush.
//
// Message flow implemented here (all from proto/fusion.proto, Electron Cash):
//   client  ClientHello  -> server ServerHello
//   client  JoinPools    -> server TierStatusUpdate (repeated) ... FusionBegin
//
// Wire constants (magic, framing, VERSION) and the connection/TLS/Tor legs are
// reused from the parent module so status and round dial identically.

use std::time::{Duration, Instant};

use prost::Message;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{
    connect_stream, pb, recv_frame, recv_frame_unbounded, send_frame, FusionServerStatus,
    Transport, VERSION,
};

/// Live status of one fusion tier (a tier is the per-player output size in sats).
#[derive(Debug, Clone, serde::Serialize)]
pub struct FusionTierStatus {
    pub tier: u64,
    pub players: Option<u32>,
    pub min_players: Option<u32>,
    pub max_players: Option<u32>,
    pub time_remaining: Option<u32>,
}

/// The server's signal that a tier is starting a round: where the covert
/// submission connections must go (a separate host/port, reached over its own
/// Tor circuits in the covert phase — milestone 1.4).
#[derive(Debug, Clone, serde::Serialize)]
pub struct FusionBeginInfo {
    pub tier: u64,
    pub covert_domain: String,
    pub covert_port: u32,
    pub covert_ssl: bool,
    pub server_time: u64,
}

/// Result of joining the pool and watching it for up to the caller's window.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FusionJoinResult {
    /// Parameters from the initial ServerHello.
    pub server: FusionServerStatus,
    /// Most recent per-tier occupancy the server reported while we waited.
    pub tiers: Vec<FusionTierStatus>,
    /// Present if a tier reached its start threshold within the window.
    pub began: Option<FusionBeginInfo>,
}

/// Connect, join the given tiers, and watch pool occupancy for up to `wait`.
/// Returns as soon as the server sends `FusionBegin`, or when `wait` elapses
/// with the latest tier statuses seen. Holds no wallet keys and commits nothing.
pub async fn join_pool_status(
    host: &str,
    port: u16,
    use_ssl: bool,
    transport: Transport<'_>,
    tiers: Vec<u64>,
    genesis_hash: Option<Vec<u8>>,
    wait: Duration,
) -> Result<FusionJoinResult, String> {
    let mut stream = connect_stream(host, port, use_ssl, transport).await?;
    run_join(&mut stream, tiers, genesis_hash, wait).await
}

/// The join flow over an established stream. Split out so it can be driven by an
/// in-memory duplex in tests, with no network.
async fn run_join<S>(
    stream: &mut S,
    tiers: Vec<u64>,
    genesis_hash: Option<Vec<u8>>,
    wait: Duration,
) -> Result<FusionJoinResult, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // ClientHello -> ServerHello
    let hello = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Clienthello(pb::ClientHello {
            version: VERSION.to_vec(),
            genesis_hash,
        })),
    };
    send_frame(stream, &hello.encode_to_vec()).await?;

    let server = match decode_server(&recv_frame(stream).await?)? {
        pb::server_message::Msg::Serverhello(h) => FusionServerStatus {
            tiers: h.tiers,
            num_components: h.num_components,
            component_feerate: h.component_feerate,
            min_excess_fee: h.min_excess_fee,
            max_excess_fee: h.max_excess_fee,
            donation_address: h.donation_address,
        },
        pb::server_message::Msg::Error(e) => {
            return Err(format!(
                "server rejected us: {}",
                e.message.unwrap_or_default()
            ))
        }
        _ => return Err("unexpected reply — expected ServerHello".into()),
    };

    // JoinPools. No pool tags yet: tags exist to stop the server fusing us with
    // ourselves across multiple connections, which only matters once we open the
    // covert connections in a later milestone. A single-connection join needs
    // none.
    let join = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Joinpools(pb::JoinPools {
            tiers: tiers.clone(),
            tags: vec![],
        })),
    };
    send_frame(stream, &join.encode_to_vec()).await?;

    // Watch the pool until FusionBegin or the window closes.
    let deadline = Instant::now() + wait;
    let mut latest: Vec<FusionTierStatus> = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(FusionJoinResult {
                server,
                tiers: latest,
                began: None,
            });
        }

        let frame = match tokio::time::timeout(remaining, recv_frame_unbounded(stream)).await {
            Err(_) => {
                return Ok(FusionJoinResult {
                    server,
                    tiers: latest,
                    began: None,
                })
            }
            Ok(r) => r?,
        };

        match decode_server(&frame)? {
            pb::server_message::Msg::Tierstatusupdate(u) => {
                latest = u
                    .statuses
                    .into_iter()
                    .map(|(tier, s)| FusionTierStatus {
                        tier,
                        players: s.players,
                        min_players: s.min_players,
                        max_players: s.max_players,
                        time_remaining: s.time_remaining,
                    })
                    .collect();
                latest.sort_by_key(|t| t.tier);
            }
            pb::server_message::Msg::Fusionbegin(b) => {
                return Ok(FusionJoinResult {
                    server,
                    tiers: latest,
                    began: Some(FusionBeginInfo {
                        tier: b.tier,
                        covert_domain: String::from_utf8_lossy(&b.covert_domain).into_owned(),
                        covert_port: b.covert_port,
                        covert_ssl: b.covert_ssl.unwrap_or(false),
                        server_time: b.server_time,
                    }),
                });
            }
            pb::server_message::Msg::Error(e) => {
                return Err(format!("server error: {}", e.message.unwrap_or_default()))
            }
            // Other messages (e.g. StartRound) belong to later milestones; while
            // only joining, anything else is simply not expected yet.
            _ => {}
        }
    }
}

fn decode_server(bytes: &[u8]) -> Result<pb::server_message::Msg, String> {
    pb::ServerMessage::decode(bytes)
        .map_err(|e| format!("could not decode server message: {e}"))?
        .msg
        .ok_or_else(|| "empty server message".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_hello() -> pb::ServerMessage {
        pb::ServerMessage {
            msg: Some(pb::server_message::Msg::Serverhello(pb::ServerHello {
                tiers: vec![10_000, 100_000],
                num_components: 23,
                component_feerate: 1_000,
                min_excess_fee: 10,
                max_excess_fee: 10_000,
                donation_address: None,
            })),
        }
    }

    #[test]
    fn join_reads_tier_status_then_fusion_begin() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(8192);

            let server_task = tokio::spawn(async move {
                // ClientHello in
                let raw = recv_frame(&mut server).await.unwrap();
                let m = pb::ClientMessage::decode(raw.as_slice()).unwrap();
                assert!(matches!(
                    m.msg,
                    Some(pb::client_message::Msg::Clienthello(_))
                ));
                send_frame(&mut server, &server_hello().encode_to_vec())
                    .await
                    .unwrap();

                // JoinPools in — assert the tiers we asked for arrive verbatim.
                let raw = recv_frame(&mut server).await.unwrap();
                let m = pb::ClientMessage::decode(raw.as_slice()).unwrap();
                match m.msg {
                    Some(pb::client_message::Msg::Joinpools(j)) => {
                        assert_eq!(j.tiers, vec![10_000, 100_000]);
                        assert!(j.tags.is_empty());
                    }
                    _ => panic!("expected JoinPools"),
                }

                // A tier status update, then FusionBegin.
                let mut statuses = std::collections::HashMap::new();
                statuses.insert(
                    10_000u64,
                    pb::tier_status_update::TierStatus {
                        players: Some(3),
                        min_players: Some(2),
                        max_players: Some(10),
                        time_remaining: Some(15),
                    },
                );
                let upd = pb::ServerMessage {
                    msg: Some(pb::server_message::Msg::Tierstatusupdate(
                        pb::TierStatusUpdate { statuses },
                    )),
                };
                send_frame(&mut server, &upd.encode_to_vec()).await.unwrap();

                let begin = pb::ServerMessage {
                    msg: Some(pb::server_message::Msg::Fusionbegin(pb::FusionBegin {
                        tier: 10_000,
                        covert_domain: b"covert.example".to_vec(),
                        covert_port: 8888,
                        covert_ssl: Some(true),
                        server_time: 1_700_000_000,
                    })),
                };
                send_frame(&mut server, &begin.encode_to_vec())
                    .await
                    .unwrap();
            });

            let res = run_join(
                &mut client,
                vec![10_000, 100_000],
                None,
                Duration::from_secs(5),
            )
            .await
            .unwrap();
            server_task.await.unwrap();

            assert_eq!(res.server.num_components, 23);
            assert_eq!(res.tiers.len(), 1);
            assert_eq!(res.tiers[0].tier, 10_000);
            assert_eq!(res.tiers[0].players, Some(3));
            let began = res.began.expect("should have begun");
            assert_eq!(began.tier, 10_000);
            assert_eq!(began.covert_domain, "covert.example");
            assert_eq!(began.covert_port, 8888);
            assert!(began.covert_ssl);
        });
    }

    #[test]
    fn join_returns_latest_status_when_window_closes_without_begin() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(8192);

            let server_task = tokio::spawn(async move {
                let _ = recv_frame(&mut server).await.unwrap();
                send_frame(&mut server, &server_hello().encode_to_vec())
                    .await
                    .unwrap();
                let _ = recv_frame(&mut server).await.unwrap(); // JoinPools
                let mut statuses = std::collections::HashMap::new();
                statuses.insert(
                    100_000u64,
                    pb::tier_status_update::TierStatus {
                        players: Some(1),
                        min_players: Some(2),
                        max_players: Some(10),
                        time_remaining: None,
                    },
                );
                let upd = pb::ServerMessage {
                    msg: Some(pb::server_message::Msg::Tierstatusupdate(
                        pb::TierStatusUpdate { statuses },
                    )),
                };
                send_frame(&mut server, &upd.encode_to_vec()).await.unwrap();
                // Then go quiet — the client's wait window should expire.
                tokio::time::sleep(Duration::from_secs(2)).await;
            });

            let res = run_join(&mut client, vec![100_000], None, Duration::from_millis(400))
                .await
                .unwrap();
            server_task.abort();

            assert!(res.began.is_none());
            assert_eq!(res.tiers.len(), 1);
            assert_eq!(res.tiers[0].players, Some(1));
        });
    }
}

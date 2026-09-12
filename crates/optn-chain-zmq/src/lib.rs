#![forbid(unsafe_code)]

//! Direct BCHN ZeroMQ notifications as a provider-neutral event source.
//!
//! ZMQ is deliberately not a wallet sync backend and never produces proof by
//! itself. Every notification carries its BCHN sequence number; detected gaps
//! are surfaced to `optn-runtime` so the consumer can recover via RPC/P2P before
//! advancing authoritative state.

use optn_core::header_hash::sha256d;
use optn_runtime::chain::{
    Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, ChainEventSource,
    Endpoint, EndpointKind, ProviderHealth, SourceId,
};
use optn_runtime::events::{
    ChainEventEnvelope, ChainEventError, ChainEventKind, ChainEventStream, EventFuture,
    SequenceTracker,
};
use tokio::sync::Mutex;
use zeromq::{Socket, SocketRecv};

const TOPICS: &[&str] = &[
    "rawtx",
    "hashtx",
    "rawblock",
    "hashblock",
    "rawds",
    "hashds",
];

#[derive(Debug, Clone)]
pub struct BchnZmqConfig {
    pub source_id: SourceId,
    pub endpoint: Endpoint,
}

pub struct BchnZmqEventSource {
    config: BchnZmqConfig,
    socket: Mutex<zeromq::SubSocket>,
    sequences: Mutex<SequenceTracker>,
    capabilities: CapabilitySet,
}

impl BchnZmqEventSource {
    pub async fn connect(config: BchnZmqConfig) -> Result<Self, ChainEventError> {
        if config.endpoint.kind != EndpointKind::BchnZmq {
            return Err(ChainEventError::InvalidMessage(
                "BCHN ZMQ source requires a BCHN ZMQ endpoint".into(),
            ));
        }
        let host = config.endpoint.host.trim();
        let port = config.endpoint.port.ok_or_else(|| {
            ChainEventError::InvalidMessage("BCHN ZMQ endpoint requires a port".into())
        })?;
        if host.is_empty() {
            return Err(ChainEventError::InvalidMessage(
                "BCHN ZMQ endpoint host is empty".into(),
            ));
        }

        let address = format!("tcp://{host}:{port}");
        let mut socket = zeromq::SubSocket::new();
        socket
            .connect(&address)
            .await
            .map_err(|error| ChainEventError::Transport(error.to_string()))?;
        for topic in TOPICS {
            socket
                .subscribe(topic)
                .await
                .map_err(|error| ChainEventError::Transport(error.to_string()))?;
        }

        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::ZmqEvents,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        for capability in [
            Capability::RawMempoolEvents,
            Capability::RawBlockEvents,
            Capability::DoubleSpendProofs,
        ] {
            capabilities.record(
                capability,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ExplicitConfiguration,
            );
        }

        Ok(Self {
            config,
            socket: Mutex::new(socket),
            sequences: Mutex::new(SequenceTracker::default()),
            capabilities,
        })
    }

    async fn receive(&self) -> Result<ChainEventEnvelope, ChainEventError> {
        let message = self
            .socket
            .lock()
            .await
            .recv()
            .await
            .map_err(|error| ChainEventError::Transport(error.to_string()))?;
        if message.len() < 2 {
            return Err(ChainEventError::InvalidMessage(
                "BCHN ZMQ notification requires topic and body frames".into(),
            ));
        }

        let topic = std::str::from_utf8(
            message
                .get(0)
                .ok_or_else(|| ChainEventError::InvalidMessage("missing topic frame".into()))?,
        )
        .map_err(|_| ChainEventError::InvalidMessage("ZMQ topic is not UTF-8".into()))?
        .to_owned();
        let body = message
            .get(1)
            .ok_or_else(|| ChainEventError::InvalidMessage("missing body frame".into()))?
            .to_vec();

        let sequence = match message.get(2) {
            Some(frame) => {
                let bytes: [u8; 4] = frame.as_ref().try_into().map_err(|_| {
                    ChainEventError::InvalidMessage(
                        "BCHN ZMQ sequence frame must be four bytes".into(),
                    )
                })?;
                Some(u32::from_le_bytes(bytes))
            }
            None => None,
        };
        let gap = match sequence {
            Some(actual) => self.sequences.lock().await.observe(&topic, actual),
            None => None,
        };

        let event = parse_event(&topic, &body)?;
        Ok(ChainEventEnvelope {
            source: self.config.source_id.clone(),
            endpoint: Some(self.config.endpoint.clone()),
            topic,
            sequence,
            gap,
            event,
        })
    }
}

impl ChainEventSource for BchnZmqEventSource {
    fn source_id(&self) -> &SourceId {
        &self.config.source_id
    }

    fn capabilities(&self) -> &CapabilitySet {
        &self.capabilities
    }

    fn health(&self) -> ProviderHealth {
        ProviderHealth::Healthy
    }
}

impl ChainEventStream for BchnZmqEventSource {
    fn source_id(&self) -> &SourceId {
        &self.config.source_id
    }

    fn endpoint(&self) -> Option<&Endpoint> {
        Some(&self.config.endpoint)
    }

    fn next_event<'a>(&'a self) -> EventFuture<'a, ChainEventEnvelope> {
        Box::pin(async move { self.receive().await })
    }
}

fn parse_event(topic: &str, body: &[u8]) -> Result<ChainEventKind, ChainEventError> {
    match topic {
        "rawtx" => Ok(ChainEventKind::TransactionSeen {
            txid: sha256d(body),
            raw: Some(body.to_vec()),
        }),
        "hashtx" => Ok(ChainEventKind::TransactionSeen {
            txid: parse_hash(body, "hashtx")?,
            raw: None,
        }),
        "rawblock" => {
            let header = body.get(..80).ok_or_else(|| {
                ChainEventError::InvalidMessage("rawblock is shorter than an 80-byte header".into())
            })?;
            Ok(ChainEventKind::BlockSeen {
                hash: sha256d(header),
                raw: Some(body.to_vec()),
            })
        }
        "hashblock" => Ok(ChainEventKind::BlockSeen {
            hash: parse_hash(body, "hashblock")?,
            raw: None,
        }),
        "rawds" => Ok(ChainEventKind::DoubleSpendProofSeen {
            proof_hash: None,
            raw: Some(body.to_vec()),
        }),
        "hashds" => Ok(ChainEventKind::DoubleSpendProofSeen {
            proof_hash: Some(parse_hash(body, "hashds")?),
            raw: None,
        }),
        other => Err(ChainEventError::InvalidMessage(format!(
            "unsupported BCHN ZMQ topic {other}"
        ))),
    }
}

fn parse_hash(body: &[u8], topic: &str) -> Result<[u8; 32], ChainEventError> {
    body.try_into().map_err(|_| {
        ChainEventError::InvalidMessage(format!(
            "{topic} body must be exactly 32 hash bytes, got {}",
            body.len()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_transaction_event_hashes_exact_payload() {
        let raw = [1u8, 2, 3, 4];
        assert_eq!(
            parse_event("rawtx", &raw).unwrap(),
            ChainEventKind::TransactionSeen {
                txid: sha256d(&raw),
                raw: Some(raw.to_vec()),
            }
        );
    }

    #[test]
    fn raw_block_requires_and_hashes_header_only() {
        assert!(parse_event("rawblock", &[0; 79]).is_err());
        let block = [7u8; 100];
        assert_eq!(
            parse_event("rawblock", &block).unwrap(),
            ChainEventKind::BlockSeen {
                hash: sha256d(&block[..80]),
                raw: Some(block.to_vec()),
            }
        );
    }

    #[test]
    fn hash_topics_preserve_bchn_uint256_wire_bytes() {
        let hash = [9u8; 32];
        assert_eq!(
            parse_event("hashtx", &hash).unwrap(),
            ChainEventKind::TransactionSeen {
                txid: hash,
                raw: None,
            }
        );
    }
}

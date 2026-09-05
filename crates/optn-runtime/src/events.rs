//! Provider-neutral chain event stream contract.
//!
//! Events are wake-ups/observations, never proof by themselves. Sequence gaps
//! are preserved in the envelope so a consumer can recover through a query
//! provider before advancing authoritative state.

use crate::chain::{Endpoint, Hash32, SourceId};
use std::{future::Future, pin::Pin};

pub type EventFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ChainEventError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainEventKind {
    TransactionSeen {
        txid: Hash32,
        raw: Option<Vec<u8>>,
    },
    BlockSeen {
        hash: Hash32,
        raw: Option<Vec<u8>>,
    },
    DoubleSpendProofSeen {
        proof_hash: Option<Hash32>,
        raw: Option<Vec<u8>>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SequenceGap {
    pub topic: String,
    pub expected: u32,
    pub actual: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainEventEnvelope {
    pub source: SourceId,
    pub endpoint: Option<Endpoint>,
    pub topic: String,
    pub sequence: Option<u32>,
    pub gap: Option<SequenceGap>,
    pub event: ChainEventKind,
}

impl ChainEventEnvelope {
    /// A notification with a detected gap can still be useful as a wake-up, but
    /// it must not be treated as a complete event history.
    pub const fn requires_recovery(&self) -> bool {
        self.gap.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainEventError {
    Offline,
    Timeout,
    InvalidMessage(String),
    Transport(String),
}

pub trait ChainEventStream: Send + Sync {
    fn source_id(&self) -> &SourceId;
    fn endpoint(&self) -> Option<&Endpoint>;
    fn next_event<'a>(&'a self) -> EventFuture<'a, ChainEventEnvelope>;
}

#[derive(Debug, Clone, Default)]
pub struct SequenceTracker {
    last: std::collections::BTreeMap<String, u32>,
}

impl SequenceTracker {
    pub fn observe(&mut self, topic: &str, actual: u32) -> Option<SequenceGap> {
        let previous = self.last.insert(topic.to_owned(), actual);
        let expected = previous.map(|value| value.wrapping_add(1));
        match expected {
            Some(expected) if expected != actual => Some(SequenceGap {
                topic: topic.to_owned(),
                expected,
                actual,
            }),
            _ => None,
        }
    }

    pub fn reset_topic(&mut self, topic: &str) {
        self.last.remove(topic);
    }

    pub fn clear(&mut self) {
        self.last.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_gap_is_detected_per_topic() {
        let mut tracker = SequenceTracker::default();
        assert_eq!(tracker.observe("rawtx", 7), None);
        assert_eq!(tracker.observe("rawblock", 19), None);
        assert_eq!(tracker.observe("rawtx", 8), None);
        assert_eq!(
            tracker.observe("rawblock", 21),
            Some(SequenceGap {
                topic: "rawblock".into(),
                expected: 20,
                actual: 21,
            })
        );
    }

    #[test]
    fn sequence_wrap_is_not_a_false_gap() {
        let mut tracker = SequenceTracker::default();
        tracker.observe("hashtx", u32::MAX);
        assert_eq!(tracker.observe("hashtx", 0), None);
    }
}

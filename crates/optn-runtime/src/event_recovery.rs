//! Recovery gate for lossy chain event streams.
//!
//! ZMQ/Electrum/P2P notifications are wake-ups, not authoritative history. When
//! a provider reports a sequence gap, the runtime must complete a query-based
//! recovery before the event is eligible to mutate authoritative state.

use crate::events::{ChainEventEnvelope, SequenceGap};
use std::{future::Future, pin::Pin};

pub type RecoveryFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

pub trait GapRecovery: Send + Sync {
    fn recover<'a>(
        &'a self,
        gap: &'a SequenceGap,
        event: &'a ChainEventEnvelope,
    ) -> RecoveryFuture<'a>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// No gap existed; the event may proceed to normal evidence/reconciliation.
    Ready(ChainEventEnvelope),
    /// A gap existed and the query-based recovery completed first.
    Recovered(ChainEventEnvelope),
    /// Recovery failed. Keep the event as a wake-up only and do not advance
    /// authoritative state from it.
    Held {
        event: ChainEventEnvelope,
        reason: String,
    },
}

pub struct EventRecoveryGate<R> {
    recoverer: R,
}

impl<R> EventRecoveryGate<R>
where
    R: GapRecovery,
{
    pub const fn new(recoverer: R) -> Self {
        Self { recoverer }
    }

    pub async fn process(&self, event: ChainEventEnvelope) -> RecoveryDecision {
        let Some(gap) = event.gap.clone() else {
            return RecoveryDecision::Ready(event);
        };

        match self.recoverer.recover(&gap, &event).await {
            Ok(()) => RecoveryDecision::Recovered(event),
            Err(reason) => RecoveryDecision::Held { event, reason },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::SourceId;
    use crate::events::{ChainEventKind, SequenceGap};

    struct MockRecovery(Result<(), String>);
    impl GapRecovery for MockRecovery {
        fn recover<'a>(
            &'a self,
            _gap: &'a SequenceGap,
            _event: &'a ChainEventEnvelope,
        ) -> RecoveryFuture<'a> {
            let result = self.0.clone();
            Box::pin(async move { result })
        }
    }

    fn event(gap: Option<SequenceGap>) -> ChainEventEnvelope {
        ChainEventEnvelope {
            source: SourceId::new("node"),
            endpoint: None,
            topic: "rawtx".into(),
            sequence: Some(9),
            gap,
            event: ChainEventKind::TransactionSeen {
                txid: [1; 32],
                raw: None,
            },
        }
    }

    #[tokio::test]
    async fn continuous_event_needs_no_recovery() {
        let gate = EventRecoveryGate::new(MockRecovery(Err("must not run".into())));
        assert!(matches!(
            gate.process(event(None)).await,
            RecoveryDecision::Ready(_)
        ));
    }

    #[tokio::test]
    async fn gap_is_recovered_before_event_is_ready() {
        let gap = SequenceGap {
            topic: "rawtx".into(),
            expected: 8,
            actual: 9,
        };
        let gate = EventRecoveryGate::new(MockRecovery(Ok(())));
        assert!(matches!(
            gate.process(event(Some(gap))).await,
            RecoveryDecision::Recovered(_)
        ));
    }

    #[tokio::test]
    async fn failed_recovery_holds_event() {
        let gap = SequenceGap {
            topic: "rawtx".into(),
            expected: 8,
            actual: 9,
        };
        let gate = EventRecoveryGate::new(MockRecovery(Err("refresh failed".into())));
        assert!(matches!(
            gate.process(event(Some(gap))).await,
            RecoveryDecision::Held { .. }
        ));
    }
}

//! What the round state machines ask of their host, and the time they are
//! given.
//!
//! The machines never sleep and never touch a socket. Every entry point takes
//! a [`Clock`]; each returns the [`Action`]s to perform; [`Timers`] tells the
//! host when to call back. The same machine runs in-memory in tests and over
//! Nostr and Tor in the host.

use super::blame::BlameReport;
use super::wire::{Body, RoundMessage};

/// The time an entry point runs at: a monotonic millisecond count for
/// deadlines and the wall clock for message timestamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clock {
    pub ms: u64,
    pub unix: u64,
}

/// Something the host must do on a machine's behalf.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Gift-wrap `message` to `to`. A component (`Body::is_anonymous`) goes
    /// under a throwaway key on its own connection; everything else under
    /// the round key.
    Send { to: String, message: RoundMessage },
    /// Coordinator only: broadcast the fully signed CoinJoin and report the
    /// outcome with `on_broadcast`.
    Broadcast { tx_hex: String, txid: String },
    /// Participant: broadcast the verified final transaction after this
    /// delay, so a coordinator whose connection died cannot strand it. Its
    /// outcome does not matter to the round.
    Rebroadcast { tx_hex: String, after_ms: u64 },
    /// A verified protocol fault. The host may set the accused round key
    /// aside for this attempt only; it is not a ban.
    Blame(BlameReport),
    /// Progress for the holder.
    Status(String),
    /// Round phase for the holder (2 register, 3 onion, 5 sign, 6 signed,
    /// 7 broadcast).
    Phase(u8),
}

/// Collects a call's actions.
#[derive(Debug, Default)]
pub struct Out {
    pub actions: Vec<Action>,
}

impl Out {
    pub fn send(&mut self, to: &str, session: &str, body: Body, clock: Clock) {
        self.actions.push(Action::Send {
            to: to.to_owned(),
            message: RoundMessage::new(session, body, clock.unix),
        });
    }

    pub fn status(&mut self, text: impl Into<String>) {
        self.actions.push(Action::Status(text.into()));
    }

    pub fn phase(&mut self, phase: u8) {
        self.actions.push(Action::Phase(phase));
    }

    pub fn take(&mut self) -> Vec<Action> {
        std::mem::take(&mut self.actions)
    }
}

/// A repeating or one-shot deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timer {
    pub due: u64,
    pub every: Option<u64>,
    /// Firings left for a bounded repeat; `None` repeats until cancelled.
    pub left: Option<u32>,
}

impl Timer {
    pub fn once(due: u64) -> Self {
        Self {
            due,
            every: None,
            left: None,
        }
    }

    pub fn repeat(clock: Clock, every: u64, max: Option<u32>) -> Self {
        Self {
            due: clock.ms + every,
            every: Some(every),
            left: max,
        }
    }

    /// Whether it fires now. A repeating timer re-arms itself; a bounded one
    /// disarms after its last firing, so it fires exactly `max` times.
    pub fn fire(slot: &mut Option<Timer>, now: u64) -> bool {
        let Some(timer) = slot.as_mut() else {
            return false;
        };
        if timer.due > now {
            return false;
        }
        match timer.every {
            None => *slot = None,
            Some(every) => {
                timer.due = now + every;
                if let Some(left) = timer.left.as_mut() {
                    *left = left.saturating_sub(1);
                    if *left == 0 {
                        *slot = None;
                    }
                }
            }
        }
        true
    }
}

/// The earliest of a machine's armed timers.
pub fn earliest<'a>(timers: impl IntoIterator<Item = &'a Option<Timer>>) -> Option<u64> {
    timers.into_iter().flatten().map(|timer| timer.due).min()
}

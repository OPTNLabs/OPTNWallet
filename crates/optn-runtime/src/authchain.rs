//! Walking a token identity's chain to its authhead, and knowing when you have
//! not.
//!
//! The walk itself is easy: from the authbase, follow whatever spends output 0,
//! again and again, until nothing has. Everything hard is about the last step.
//! A wallet asks "has anything spent this?" and a server says no — but "no" and
//! "I could not tell you" arrive looking almost the same, and treating the
//! second as the first is how a wallet ends up showing withdrawn metadata as
//! current, or a superseded name for a token that has since been renamed.
//!
//! So this refuses to collapse them. [`IdentityStatus::Unknown`] is a distinct
//! answer and can never produce an authhead, no matter how many sources return
//! it. Only [`IdentityStatus::Unspent`] can, and it carries the evidence behind
//! the claim so the caller can decide whether a server's word is enough here.
//!
//! Discovery and acceptance are also separate. A source proposing a successor
//! is discovery; the successor is accepted only once its inputs are checked to
//! actually spend the identity output. That check is what makes the ancestry
//! shortcuts safe to use: a heuristic may nominate a candidate cheaply, and
//! nominating the wrong one costs nothing, because the chain rule is applied
//! before anything is believed.
//!
//! This module never dials. It says what it needs next and judges what it is
//! given, which keeps source and transport policy where it belongs — an
//! Electrum-only shortcut cannot leak into a BIP37-only wallet from in here,
//! because there is nothing in here that could call one.

use optn_core::bcmr::{continues_authchain, identity_output_state, IdentityOutputState};

use crate::chain::{Evidence, Hash32};

/// How far a resolution may walk before reporting back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthchainBudget {
    /// Hops from the authbase. A long-lived identity updates often.
    pub max_hops: u32,
    /// How many sources must agree on a successor before it is taken.
    ///
    /// One is the ordinary setting: the first adequately validated answer
    /// wins, which is fine because validation is the chain rule rather than a
    /// popularity contest. Raising it asks several eligible sources per hop and
    /// makes a disagreement visible instead of resolving it by whichever reply
    /// arrived first — worth it when the sources are not equally trusted.
    pub agreements_per_hop: u32,
}

impl Default for AuthchainBudget {
    fn default() -> Self {
        Self {
            max_hops: 1_000,
            agreements_per_hop: 1,
        }
    }
}

/// One transaction on the chain, as a source described it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainTransaction {
    pub txid: Hash32,
    /// The outpoints it spends, so continuation can be checked rather than
    /// assumed.
    pub inputs: Vec<(Hash32, u32)>,
    /// Its output locking scripts, in order. Index 0 is the identity output.
    pub outputs: Vec<Vec<u8>>,
    pub block_height: Option<u32>,
}

/// Why a source could not say whether an identity output is spent.
///
/// Every one of these means "ask again or ask elsewhere". None of them means
/// the output is unspent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnknownReason {
    /// The request timed out.
    Timeout,
    /// No eligible source offers the capability this needs.
    CapabilityUnavailable,
    /// The source answered, but only for part of the range it was asked about.
    IncompleteHistory,
    /// The source failed in some other way.
    SourceError(String),
}

/// What a source said about an identity output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityStatus {
    /// Something spends it, and here is that transaction.
    ///
    /// A claim, not a conclusion: its inputs are checked before it is
    /// accepted as the successor.
    SpentBy(ChainTransaction),
    /// Nothing spends it, and this is what backs that.
    ///
    /// The evidence travels with the answer because it decides what the
    /// result is worth. An Electrum server saying an output is unspent is a
    /// server assertion; it is not the same claim as one backed by a proof,
    /// and a wallet that records both identically cannot later tell a holder
    /// which it relied on.
    Unspent { evidence: Evidence },
    /// The source could not tell. Never an authhead.
    Unknown(UnknownReason),
}

/// Why a resolution stopped without an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncompleteReason {
    /// The hop budget ran out. Resumable from where it stopped.
    BudgetExhausted,
    /// Nothing eligible could answer.
    CapabilityUnavailable,
    Timeout,
    /// A source answered partially.
    IncompleteHistory,
    SourceError(String),
    /// The caller stopped it.
    Cancelled,
}

/// A resolved identity, and how firmly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAuthhead {
    pub authhead: Hash32,
    pub hops: u32,
    pub block_height: Option<u32>,
    /// The identity output's own scripts, so a publication can be read from
    /// this transaction and no other.
    pub outputs: Vec<Vec<u8>>,
    /// What backed the claim that the identity output is unspent.
    ///
    /// This is the weakest link in the whole result: every hop before it was
    /// checked against the chain rule, and this one was taken on a source's
    /// word unless the evidence says otherwise.
    pub evidence: Evidence,
}

/// What a resolution concluded, or why it did not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthchainStep {
    /// Ask a source about this transaction's identity output.
    Query { txid: Hash32 },
    /// The authhead was reached and every hop validated.
    Resolved(ResolvedAuthhead),
    /// The identity output is `OP_RETURN`: deliberately ended.
    ///
    /// Different from "quiet". Nobody can continue this chain, so a client may
    /// stop asking and say so plainly.
    Burned {
        authhead: Hash32,
        hops: u32,
        block_height: Option<u32>,
    },
    /// Stopped without reaching an unspent identity output.
    ///
    /// Never an authhead, and never an empty identity.
    Incomplete {
        reached: Hash32,
        hops: u32,
        reason: IncompleteReason,
    },
    /// A source proposed a successor that does not spend the identity output.
    InvalidEvidence { at: Hash32, detail: String },
    /// Eligible sources named different successors for the same output.
    ///
    /// One of them is lying or looking at a different chain. Picking the first
    /// would make the answer depend on which reply arrived first.
    ConflictingEvidence { at: Hash32, candidates: Vec<Hash32> },
}

/// A walk from an authbase toward its authhead.
#[derive(Debug, Clone)]
pub struct AuthchainResolution {
    current: Hash32,
    current_outputs: Vec<Vec<u8>>,
    current_height: Option<u32>,
    hops: u32,
    budget: AuthchainBudget,
    /// The successor proposed for the current transaction, held until enough
    /// sources have agreed on it.
    candidate: Option<ChainTransaction>,
    /// How many sources have named that same successor.
    agreements: u32,
    finished: bool,
}

impl AuthchainResolution {
    /// Begin at the authbase.
    ///
    /// For a token this is the transaction that created the category, which
    /// the wallet already knows from the category id rather than from any
    /// source's say-so.
    pub fn begin(authbase: Hash32, budget: AuthchainBudget) -> Self {
        Self {
            current: authbase,
            current_outputs: Vec::new(),
            current_height: None,
            hops: 0,
            budget,
            candidate: None,
            agreements: 0,
            finished: false,
        }
    }

    /// The transaction whose identity output needs an answer.
    pub const fn current(&self) -> Hash32 {
        self.current
    }

    pub const fn hops(&self) -> u32 {
        self.hops
    }

    pub const fn is_finished(&self) -> bool {
        self.finished
    }

    /// What to ask next.
    pub fn next_step(&self) -> AuthchainStep {
        if self.hops >= self.budget.max_hops {
            return AuthchainStep::Incomplete {
                reached: self.current,
                hops: self.hops,
                reason: IncompleteReason::BudgetExhausted,
            };
        }
        AuthchainStep::Query { txid: self.current }
    }

    /// Stop, keeping where the walk got to.
    pub fn cancel(&mut self) -> AuthchainStep {
        self.finished = true;
        AuthchainStep::Incomplete {
            reached: self.current,
            hops: self.hops,
            reason: IncompleteReason::Cancelled,
        }
    }

    /// Judge one source's answer about the current identity output.
    ///
    /// Several answers may be supplied for the same transaction, from
    /// different sources; agreeing ones are idempotent and disagreeing ones
    /// are reported rather than resolved by arrival order.
    pub fn accept(&mut self, status: IdentityStatus) -> AuthchainStep {
        if self.finished {
            return AuthchainStep::Incomplete {
                reached: self.current,
                hops: self.hops,
                reason: IncompleteReason::Cancelled,
            };
        }
        if self.hops >= self.budget.max_hops {
            self.finished = true;
            return AuthchainStep::Incomplete {
                reached: self.current,
                hops: self.hops,
                reason: IncompleteReason::BudgetExhausted,
            };
        }

        match status {
            IdentityStatus::Unknown(reason) => {
                // The whole point. A source that cannot answer has not told us
                // the output is unspent, and no number of them ever will.
                self.finished = true;
                AuthchainStep::Incomplete {
                    reached: self.current,
                    hops: self.hops,
                    reason: match reason {
                        UnknownReason::Timeout => IncompleteReason::Timeout,
                        UnknownReason::CapabilityUnavailable => {
                            IncompleteReason::CapabilityUnavailable
                        }
                        UnknownReason::IncompleteHistory => IncompleteReason::IncompleteHistory,
                        UnknownReason::SourceError(detail) => IncompleteReason::SourceError(detail),
                    },
                }
            }
            IdentityStatus::Unspent { evidence } => {
                // One source sees a successor and another does not. Often just
                // a lagging server rather than a lie, but either way this is
                // not the moment to declare an authhead.
                if let Some(candidate) = &self.candidate {
                    let candidates = vec![candidate.txid];
                    self.finished = true;
                    return AuthchainStep::ConflictingEvidence {
                        at: self.current,
                        candidates,
                    };
                }
                self.finished = true;
                // A burned identity output is also unspent, and saying only
                // "resolved" would hide that nobody can ever update it again.
                match identity_output_state(self.current_outputs.first().map(Vec::as_slice)) {
                    IdentityOutputState::Burned => AuthchainStep::Burned {
                        authhead: self.current,
                        hops: self.hops,
                        block_height: self.current_height,
                    },
                    _ => AuthchainStep::Resolved(ResolvedAuthhead {
                        authhead: self.current,
                        hops: self.hops,
                        block_height: self.current_height,
                        outputs: self.current_outputs.clone(),
                        evidence,
                    }),
                }
            }
            IdentityStatus::SpentBy(transaction) => {
                // Acceptance, not discovery: a proposed successor has to
                // actually spend this identity output.
                if !continues_authchain(&transaction.inputs, self.current) {
                    self.finished = true;
                    return AuthchainStep::InvalidEvidence {
                        at: self.current,
                        detail: format!(
                            "proposed successor {} does not spend output 0 of {}",
                            display(&transaction.txid),
                            display(&self.current)
                        ),
                    };
                }
                match &self.candidate {
                    Some(existing) if existing.txid != transaction.txid => {
                        let candidates = vec![existing.txid, transaction.txid];
                        self.finished = true;
                        return AuthchainStep::ConflictingEvidence {
                            at: self.current,
                            candidates,
                        };
                    }
                    Some(_) => self.agreements += 1,
                    None => {
                        self.candidate = Some(transaction);
                        self.agreements = 1;
                    }
                }
                if self.agreements < self.budget.agreements_per_hop.max(1) {
                    // Ask another eligible source about the same output.
                    return AuthchainStep::Query { txid: self.current };
                }
                let accepted = self.candidate.take().expect("a candidate was recorded");
                self.current = accepted.txid;
                self.current_outputs = accepted.outputs;
                self.current_height = accepted.block_height;
                self.hops += 1;
                self.agreements = 0;
                self.next_step()
            }
        }
    }
}

fn display(hash: &Hash32) -> String {
    hash.iter()
        .rev()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::bcmr::{parse_publication, publication_in, PUBLICATION_PREFIX};

    fn txid(byte: u8) -> Hash32 {
        [byte; 32]
    }

    fn p2pkh() -> Vec<u8> {
        vec![0x76, 0xa9, 0x14]
    }

    fn burn() -> Vec<u8> {
        vec![0x6a, 0x04, 1, 2, 3, 4]
    }

    fn publication(hash: [u8; 32]) -> Vec<u8> {
        let mut script = PUBLICATION_PREFIX.to_vec();
        script.push(32);
        script.extend_from_slice(&hash);
        script.push(11);
        script.extend_from_slice(b"example.com");
        script
    }

    fn spends(parent: Hash32, txid: Hash32, outputs: Vec<Vec<u8>>) -> ChainTransaction {
        ChainTransaction {
            txid,
            inputs: vec![(parent, 0)],
            outputs,
            block_height: Some(100),
        }
    }

    #[test]
    fn a_single_hop_resolves_to_the_successor() {
        let base = txid(1);
        let head = txid(2);
        let mut walk = AuthchainResolution::begin(base, AuthchainBudget::default());
        assert_eq!(walk.next_step(), AuthchainStep::Query { txid: base });

        assert_eq!(
            walk.accept(IdentityStatus::SpentBy(spends(
                base,
                head,
                vec![p2pkh(), publication([7; 32])]
            ))),
            AuthchainStep::Query { txid: head }
        );
        let resolved = walk.accept(IdentityStatus::Unspent {
            evidence: Evidence::ServerAssertion,
        });
        let AuthchainStep::Resolved(head_result) = resolved else {
            panic!("expected a resolution: {resolved:?}");
        };
        assert_eq!(head_result.authhead, head);
        assert_eq!(head_result.hops, 1);
        // The publication is read from the authhead's own outputs.
        let found = publication_in(head_result.outputs.iter().map(Vec::as_slice))
            .expect("the authhead publishes");
        assert_eq!(found.content_hash, [7; 32]);
    }

    #[test]
    fn a_multi_hop_chain_walks_to_its_head() {
        let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
        for hop in 1..5u8 {
            walk.accept(IdentityStatus::SpentBy(spends(
                txid(hop),
                txid(hop + 1),
                vec![p2pkh()],
            )));
        }
        let AuthchainStep::Resolved(resolved) = walk.accept(IdentityStatus::Unspent {
            evidence: Evidence::ServerAssertion,
        }) else {
            panic!("expected a resolution");
        };
        assert_eq!(resolved.authhead, txid(5));
        assert_eq!(resolved.hops, 4);
    }

    /// The identity output may move to a completely different script.
    #[test]
    fn the_identity_output_may_change_script_between_hops() {
        let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(2),
            vec![vec![0xa9, 0x14, 0x00], p2pkh()],
        )));
        let AuthchainStep::Resolved(resolved) = walk.accept(IdentityStatus::Unspent {
            evidence: Evidence::ServerAssertion,
        }) else {
            panic!("a changed identity script is still the identity");
        };
        assert_eq!(resolved.authhead, txid(2));
    }

    /// An OP_RETURN identity output is an ending, not a resolution.
    #[test]
    fn an_op_return_identity_output_reports_a_burned_identity() {
        let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(2),
            vec![burn(), p2pkh()],
        )));
        assert_eq!(
            walk.accept(IdentityStatus::Unspent {
                evidence: Evidence::ServerAssertion,
            }),
            AuthchainStep::Burned {
                authhead: txid(2),
                hops: 1,
                block_height: Some(100),
            }
        );
    }

    /// An authhead that publishes nothing has no current metadata, and does
    /// not inherit its parent's.
    #[test]
    fn an_authhead_without_a_publication_offers_none() {
        let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
        // The parent published; the head does not.
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(2),
            vec![p2pkh(), publication([1; 32])],
        )));
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(2),
            txid(3),
            vec![p2pkh()],
        )));
        let AuthchainStep::Resolved(resolved) = walk.accept(IdentityStatus::Unspent {
            evidence: Evidence::ServerAssertion,
        }) else {
            panic!("expected a resolution");
        };
        assert_eq!(resolved.authhead, txid(3));
        assert_eq!(
            publication_in(resolved.outputs.iter().map(Vec::as_slice)),
            None,
            "withdrawn metadata must not be presented as current"
        );
    }

    /// The rule this module exists for: silence is not an answer.
    #[test]
    fn a_timeout_never_becomes_an_authhead() {
        for reason in [
            UnknownReason::Timeout,
            UnknownReason::CapabilityUnavailable,
            UnknownReason::IncompleteHistory,
            UnknownReason::SourceError("connection reset".into()),
        ] {
            let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
            let step = walk.accept(IdentityStatus::Unknown(reason.clone()));
            assert!(
                matches!(step, AuthchainStep::Incomplete { .. }),
                "{reason:?} produced {step:?} instead of an incomplete result"
            );
            assert!(
                !matches!(
                    step,
                    AuthchainStep::Resolved(_) | AuthchainStep::Burned { .. }
                ),
                "{reason:?} must never conclude the chain"
            );
        }
    }

    /// A candidate that does not spend the identity output is refused, however
    /// plausible its ancestry looked.
    #[test]
    fn a_candidate_outside_the_chain_is_refused() {
        let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
        let unrelated = ChainTransaction {
            txid: txid(9),
            // Spends output 0 of something else, and output 1 of the identity.
            inputs: vec![(txid(8), 0), (txid(1), 1)],
            outputs: vec![p2pkh()],
            block_height: Some(50),
        };
        let step = walk.accept(IdentityStatus::SpentBy(unrelated));
        let AuthchainStep::InvalidEvidence { at, .. } = step else {
            panic!("an off-chain candidate was accepted: {step:?}");
        };
        assert_eq!(at, txid(1));
    }

    fn corroborating(hops: u32) -> AuthchainBudget {
        AuthchainBudget {
            max_hops: hops,
            agreements_per_hop: 2,
        }
    }

    /// Two sources, two different successors: report it, do not pick one.
    ///
    /// Both genuinely spend the identity output, so both survive acceptance.
    /// They cannot both be on the chain this wallet is following, and choosing
    /// by arrival order would make the answer depend on the network.
    #[test]
    fn disagreeing_sources_are_reported_rather_than_raced() {
        let mut walk = AuthchainResolution::begin(txid(1), corroborating(10));
        assert_eq!(
            walk.accept(IdentityStatus::SpentBy(spends(
                txid(1),
                txid(2),
                vec![p2pkh()]
            ))),
            AuthchainStep::Query { txid: txid(1) },
            "one agreement is not enough here, so ask another source"
        );
        let step = walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(3),
            vec![p2pkh()],
        )));
        let AuthchainStep::ConflictingEvidence { at, candidates } = step else {
            panic!("a disagreement resolved itself: {step:?}");
        };
        assert_eq!(at, txid(1));
        assert_eq!(candidates, vec![txid(2), txid(3)]);
    }

    /// The same successor from two sources is agreement, and it advances.
    #[test]
    fn agreeing_sources_advance_the_walk() {
        let mut walk = AuthchainResolution::begin(txid(1), corroborating(10));
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(2),
            vec![p2pkh()],
        )));
        assert_eq!(
            walk.accept(IdentityStatus::SpentBy(spends(
                txid(1),
                txid(2),
                vec![p2pkh()]
            ))),
            AuthchainStep::Query { txid: txid(2) }
        );
        assert_eq!(walk.hops(), 1);
    }

    /// One source sees a successor, another says the output is unspent.
    ///
    /// Usually a lagging server rather than a lie, and either way not the
    /// moment to declare an authhead.
    #[test]
    fn spent_and_unspent_answers_conflict_rather_than_concluding() {
        let mut walk = AuthchainResolution::begin(txid(1), corroborating(10));
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(2),
            vec![p2pkh()],
        )));
        let step = walk.accept(IdentityStatus::Unspent {
            evidence: Evidence::ServerAssertion,
        });
        assert_eq!(
            step,
            AuthchainStep::ConflictingEvidence {
                at: txid(1),
                candidates: vec![txid(2)],
            }
        );
    }

    /// With the ordinary setting, the first validated answer wins.
    #[test]
    fn a_single_agreement_advances_by_default() {
        let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
        assert_eq!(
            walk.accept(IdentityStatus::SpentBy(spends(
                txid(1),
                txid(2),
                vec![p2pkh()]
            ))),
            AuthchainStep::Query { txid: txid(2) }
        );
        assert_eq!(walk.hops(), 1);
    }

    /// A long chain stops at the budget, and says so.
    #[test]
    fn an_exhausted_budget_is_incomplete_not_resolved() {
        let mut walk = AuthchainResolution::begin(
            txid(1),
            AuthchainBudget {
                max_hops: 2,
                ..AuthchainBudget::default()
            },
        );
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(2),
            vec![p2pkh()],
        )));
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(2),
            txid(3),
            vec![p2pkh()],
        )));
        let step = walk.accept(IdentityStatus::SpentBy(spends(
            txid(3),
            txid(4),
            vec![p2pkh()],
        )));
        assert_eq!(
            step,
            AuthchainStep::Incomplete {
                reached: txid(3),
                hops: 2,
                reason: IncompleteReason::BudgetExhausted,
            }
        );
    }

    /// Cancelling keeps the position and produces no conclusion.
    #[test]
    fn cancelling_yields_a_position_not_an_answer() {
        let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(2),
            vec![p2pkh()],
        )));
        assert_eq!(
            walk.cancel(),
            AuthchainStep::Incomplete {
                reached: txid(2),
                hops: 1,
                reason: IncompleteReason::Cancelled,
            }
        );
        assert!(walk.is_finished());
    }

    /// The evidence behind "unspent" travels with the result.
    ///
    /// It is the weakest link: every hop before it was checked against the
    /// chain rule, and this one rests on a source's word unless something
    /// stronger says otherwise.
    #[test]
    fn the_result_records_what_the_last_step_rested_on() {
        for evidence in [
            Evidence::ServerAssertion,
            Evidence::FullNodeValidated {
                source: crate::chain::SourceId::new("own-node"),
            },
        ] {
            let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
            walk.accept(IdentityStatus::SpentBy(spends(
                txid(1),
                txid(2),
                vec![p2pkh()],
            )));
            let AuthchainStep::Resolved(resolved) = walk.accept(IdentityStatus::Unspent {
                evidence: evidence.clone(),
            }) else {
                panic!("expected a resolution");
            };
            assert_eq!(resolved.evidence, evidence);
        }
    }

    /// A publication on the authhead is read from the authhead alone.
    #[test]
    fn the_publication_comes_from_the_resolved_head() {
        let mut walk = AuthchainResolution::begin(txid(1), AuthchainBudget::default());
        walk.accept(IdentityStatus::SpentBy(spends(
            txid(1),
            txid(2),
            vec![p2pkh(), publication([3; 32])],
        )));
        let AuthchainStep::Resolved(resolved) = walk.accept(IdentityStatus::Unspent {
            evidence: Evidence::ServerAssertion,
        }) else {
            panic!("expected a resolution");
        };
        let script = resolved
            .outputs
            .iter()
            .find_map(|script| parse_publication(script))
            .expect("a publication");
        assert_eq!(script.content_hash, [3; 32]);
        assert_eq!(script.uris, vec!["example.com"]);
    }
}

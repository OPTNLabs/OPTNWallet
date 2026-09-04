//! Checking one implementation against another, without fooling ourselves.
//!
//! Two places in this project need the same thing. SwiftFulcrum is an
//! independent implementation of behaviour the Rust core also implements, and
//! a Rust MLS would have to produce byte-identical KeyPackages to the
//! TypeScript one before it could replace it. Both are the same question:
//! *given these inputs, do these implementations emit the same bytes, and are
//! those bytes right?*
//!
//! Those are two questions, and conflating them is the trap this module
//! exists to avoid. **Two implementations agreeing proves only that they
//! agree.** They can share a misreading of the same spec, or one can have been
//! written by reading the other. Agreement is evidence of consistency, not of
//! correctness, so it gets its own verdict — [`Verdict::AgreeButUnanchored`] —
//! rather than being allowed to read as a pass.
//!
//! What makes a difference actionable is *where* it is. "They differ" sends
//! someone to diff two blobs by hand; "they differ at byte 37 of 214" usually
//! names the field.
//!
//! One rule is inherited rather than invented: a case never carries secret
//! material. A differential test must not become the reason a preview library,
//! or anything else, is handed a private key.

use std::fmt;

/// One thing implementations must agree about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConformanceCase {
    /// A stable name, so a failure can be talked about.
    pub id: String,
    /// What each implementation was given, as a human-readable description.
    ///
    /// Deliberately a description rather than typed inputs: the harness does
    /// not run anything, it compares what was run elsewhere.
    pub input: String,
    /// The bytes a published vector says are correct.
    ///
    /// `None` is a legitimate and common state -- MDK publishes no MLS
    /// conformance fixtures, for instance -- and it is why
    /// [`Verdict::AgreeButUnanchored`] exists rather than being folded into a
    /// pass.
    pub canonical: Option<Vec<u8>>,
}

impl ConformanceCase {
    pub fn new(id: impl Into<String>, input: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            input: input.into(),
            canonical: None,
        }
    }

    /// Anchor the case to published bytes.
    pub fn anchored(mut self, canonical: Vec<u8>) -> Self {
        self.canonical = Some(canonical);
        self
    }

    pub fn is_anchored(&self) -> bool {
        self.canonical.is_some()
    }
}

/// What one implementation produced for a case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    /// Which implementation this came from.
    pub implementation: String,
    pub output: Vec<u8>,
}

impl Observation {
    pub fn new(implementation: impl Into<String>, output: Vec<u8>) -> Self {
        Self {
            implementation: implementation.into(),
            output,
        }
    }
}

/// What a comparison concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Every implementation matched the published bytes. The only real pass.
    Conforms,
    /// They agree with each other, and there is nothing to check them against.
    ///
    /// Not a pass. Two implementations can share a misreading, or one can have
    /// been written by reading the other, and this verdict exists so that
    /// cannot be mistaken for correctness in a summary.
    AgreeButUnanchored,
    /// Implementations disagree with each other.
    Diverges {
        left: String,
        right: String,
        /// Byte offset of the first difference. `None` when one output is a
        /// prefix of the other, in which case the length is the difference.
        at: Option<usize>,
    },
    /// At least one implementation disagrees with the published bytes.
    ///
    /// Reported ahead of divergence: when there is a canonical, "wrong" is a
    /// more useful thing to be told than "different from each other".
    ViolatesCanonical {
        implementation: String,
        at: Option<usize>,
    },
    /// Nothing was observed.
    ///
    /// A case nobody ran must never read as a pass, which is the failure mode
    /// of every "all green" summary that quietly skipped something.
    NotRun,
}

impl Verdict {
    /// Whether this verdict may be reported as a pass.
    ///
    /// Only [`Verdict::Conforms`]. Agreement without an anchor is deliberately
    /// excluded.
    pub const fn is_pass(&self) -> bool {
        matches!(self, Self::Conforms)
    }

    /// Whether this verdict needs someone to look at it.
    pub const fn needs_attention(&self) -> bool {
        matches!(
            self,
            Self::Diverges { .. } | Self::ViolatesCanonical { .. } | Self::NotRun
        )
    }
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conforms => f.write_str("conforms to the published vector"),
            Self::AgreeButUnanchored => f.write_str(
                "implementations agree, but nothing anchors them: no published vector to check \
                 against, so this is consistency and not correctness",
            ),
            Self::Diverges { left, right, at } => match at {
                Some(offset) => write!(f, "{left} and {right} differ at byte {offset}"),
                None => write!(f, "{left} and {right} differ in length"),
            },
            Self::ViolatesCanonical { implementation, at } => match at {
                Some(offset) => write!(
                    f,
                    "{implementation} disagrees with the published vector at byte {offset}"
                ),
                None => write!(
                    f,
                    "{implementation} disagrees with the published vector in length"
                ),
            },
            Self::NotRun => f.write_str("nothing was observed"),
        }
    }
}

/// The offset of the first differing byte, or `None` if one is a prefix of the
/// other.
pub fn first_difference(left: &[u8], right: &[u8]) -> Option<usize> {
    left.iter().zip(right.iter()).position(|(a, b)| a != b).or({
        if left.len() == right.len() {
            None
        } else {
            // They match as far as the shorter one goes; the difference is
            // that one continues.
            Some(left.len().min(right.len()))
        }
    })
}

/// Compare what every implementation produced for one case.
///
/// The order of the checks is the policy. A canonical, where there is one,
/// decides first: being told an implementation is *wrong* is more useful than
/// being told two are *different*. Only with no canonical does agreement come
/// into it, and then only as its own verdict.
pub fn judge(case: &ConformanceCase, observations: &[Observation]) -> Verdict {
    if observations.is_empty() {
        return Verdict::NotRun;
    }

    if let Some(canonical) = case.canonical.as_deref() {
        for observation in observations {
            if observation.output != canonical {
                return Verdict::ViolatesCanonical {
                    implementation: observation.implementation.clone(),
                    at: first_difference(&observation.output, canonical),
                };
            }
        }
        return Verdict::Conforms;
    }

    let first = &observations[0];
    for other in &observations[1..] {
        if other.output != first.output {
            return Verdict::Diverges {
                left: first.implementation.clone(),
                right: other.implementation.clone(),
                at: first_difference(&first.output, &other.output),
            };
        }
    }
    Verdict::AgreeButUnanchored
}

/// A run of cases, and what it is honest to say about it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConformanceReport {
    pub results: Vec<(String, Verdict)>,
}

impl ConformanceReport {
    pub fn record(&mut self, case: &ConformanceCase, observations: &[Observation]) {
        self.results
            .push((case.id.clone(), judge(case, observations)));
    }

    /// Cases that actually passed.
    pub fn passed(&self) -> usize {
        self.results.iter().filter(|(_, v)| v.is_pass()).count()
    }

    /// Cases where two implementations agreed with nothing to anchor them.
    pub fn unanchored(&self) -> usize {
        self.results
            .iter()
            .filter(|(_, v)| matches!(v, Verdict::AgreeButUnanchored))
            .count()
    }

    /// Cases someone has to look at.
    pub fn needing_attention(&self) -> Vec<&(String, Verdict)> {
        self.results
            .iter()
            .filter(|(_, v)| v.needs_attention())
            .collect()
    }

    /// A one-line summary that cannot be read as better than it is.
    ///
    /// Unanchored cases are named separately rather than counted as passes,
    /// because "12 passed" when four of them were only self-consistent is the
    /// summary that lets a wrong assumption ship.
    pub fn summary(&self) -> String {
        let total = self.results.len();
        let attention = self.needing_attention().len();
        let unanchored = self.unanchored();
        let mut line = format!("{}/{total} conform", self.passed());
        if unanchored > 0 {
            line.push_str(&format!(
                ", {unanchored} agree but are unanchored (consistency, not correctness)"
            ));
        }
        if attention > 0 {
            line.push_str(&format!(", {attention} need attention"));
        }
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case() -> ConformanceCase {
        ConformanceCase::new("keypackage", "the same identity key and capabilities")
    }

    #[test]
    fn agreement_without_a_vector_is_not_a_pass() {
        // The trap this module exists for. Two implementations can share a
        // misreading of one spec, or one can have been written by reading the
        // other, so agreeing proves they agree and nothing else.
        let verdict = judge(
            &case(),
            &[
                Observation::new("ts-mls", vec![1, 2, 3]),
                Observation::new("mdk", vec![1, 2, 3]),
            ],
        );
        assert_eq!(verdict, Verdict::AgreeButUnanchored);
        assert!(!verdict.is_pass(), "this must never read as a pass");
        assert!(!verdict.needs_attention(), "nor as a failure");
        assert!(verdict.to_string().contains("not correctness"));

        // The same two outputs, once there is something to anchor them to.
        let anchored = case().anchored(vec![1, 2, 3]);
        assert_eq!(
            judge(
                &anchored,
                &[
                    Observation::new("ts-mls", vec![1, 2, 3]),
                    Observation::new("mdk", vec![1, 2, 3]),
                ]
            ),
            Verdict::Conforms
        );
    }

    #[test]
    fn a_case_nobody_ran_is_not_a_case_that_passed() {
        // The failure mode of every "all green" summary that quietly skipped
        // something.
        let verdict = judge(&case(), &[]);
        assert_eq!(verdict, Verdict::NotRun);
        assert!(!verdict.is_pass());
        assert!(verdict.needs_attention());
    }

    #[test]
    fn a_difference_is_reported_where_it_is_not_merely_that_it_exists() {
        // "They differ" sends someone to diff two blobs by hand. "They differ
        // at byte 2" usually names the field.
        let verdict = judge(
            &case(),
            &[
                Observation::new("ts-mls", vec![1, 2, 3, 4]),
                Observation::new("mdk", vec![1, 2, 9, 4]),
            ],
        );
        assert_eq!(
            verdict,
            Verdict::Diverges {
                left: "ts-mls".into(),
                right: "mdk".into(),
                at: Some(2),
            }
        );
        assert!(verdict.to_string().contains("byte 2"));

        // A prefix is a length difference, reported at the point one ran out.
        assert_eq!(first_difference(&[1, 2, 3], &[1, 2, 3, 4]), Some(3));
        assert_eq!(first_difference(&[1, 2, 3], &[1, 2, 3]), None);
        assert_eq!(first_difference(&[], &[]), None);
    }

    #[test]
    fn being_wrong_is_reported_ahead_of_being_different() {
        // With a published vector in hand, "this one is wrong" is more useful
        // than "these two disagree" -- it says which to fix.
        let anchored = case().anchored(vec![1, 2, 3]);
        let verdict = judge(
            &anchored,
            &[
                Observation::new("ts-mls", vec![1, 2, 3]),
                Observation::new("mdk", vec![1, 9, 3]),
            ],
        );
        assert_eq!(
            verdict,
            Verdict::ViolatesCanonical {
                implementation: "mdk".into(),
                at: Some(1),
            }
        );
        assert!(verdict.needs_attention());
    }

    #[test]
    fn the_summary_cannot_be_read_as_better_than_it_is() {
        // "12 passed" when four were only self-consistent is the summary that
        // lets a shared wrong assumption ship.
        let mut report = ConformanceReport::default();
        let anchored = ConformanceCase::new("cashaddr", "a known hash160").anchored(vec![7]);
        report.record(&anchored, &[Observation::new("rust", vec![7])]);
        report.record(
            &ConformanceCase::new("keypackage", "fixed caps"),
            &[
                Observation::new("ts-mls", vec![1]),
                Observation::new("mdk", vec![1]),
            ],
        );
        report.record(&ConformanceCase::new("sighash", "one input"), &[]);

        assert_eq!(report.passed(), 1, "only the anchored one conformed");
        assert_eq!(report.unanchored(), 1);
        assert_eq!(report.needing_attention().len(), 1);

        let summary = report.summary();
        assert!(summary.starts_with("1/3 conform"), "{summary}");
        assert!(summary.contains("unanchored"), "{summary}");
        assert!(summary.contains("need attention"), "{summary}");
    }

    #[test]
    fn this_harness_serves_both_of_the_places_that_need_it() {
        // SwiftFulcrum and MDK are the same question asked twice: given these
        // inputs, do these implementations emit the same bytes, and are those
        // bytes right? The difference between them is only whether a published
        // vector exists -- and that difference is exactly what the verdicts
        // distinguish.
        let fulcrum =
            ConformanceCase::new("cashaddr", "hash160 of a known key").anchored(vec![0xde, 0xad]);
        assert!(fulcrum.is_anchored());
        assert_eq!(
            judge(
                &fulcrum,
                &[
                    Observation::new("optn-core", vec![0xde, 0xad]),
                    Observation::new("SwiftFulcrum", vec![0xde, 0xad]),
                ]
            ),
            Verdict::Conforms
        );

        // MDK publishes no MLS fixtures, so the best available answer there is
        // the honest one rather than a pass.
        let keypackage = ConformanceCase::new("keypackage", "fixed caps, same identity key");
        assert!(!keypackage.is_anchored());
        assert_eq!(
            judge(
                &keypackage,
                &[
                    Observation::new("ts-mls", vec![0xbe, 0xef]),
                    Observation::new("mdk", vec![0xbe, 0xef]),
                ]
            ),
            Verdict::AgreeButUnanchored
        );
    }
}

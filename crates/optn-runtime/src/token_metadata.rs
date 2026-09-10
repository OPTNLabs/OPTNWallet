//! Turning a publication into metadata, or into an honest absence.
//!
//! The authchain says *which* registry is authentic and commits to its hash.
//! Fetching it is the easy half; the hard half is what a wallet shows when the
//! fetch does not work, because the tempting answers are all wrong:
//!
//! - Showing nothing makes owned tokens look like they vanished. A holder's
//!   coins do not depend on a web server being up.
//! - Showing the last known name without saying it is stale presents withdrawn
//!   or superseded metadata as current.
//! - Showing whatever came back without checking the hash lets whoever serves
//!   the file rename someone else's token.
//!
//! So resolution has four outcomes and they stay distinct all the way to the
//! screen: authenticated, stale-but-known, unresolved, and *deliberately*
//! unpublished. Only the first is current metadata; the rest each say something
//! different, and a wallet that collapses them into "no name" throws away the
//! difference between "we could not reach it" and "the owner withdrew it".
//!
//! What comes back is untrusted content. It is bytes from a URL an on-chain
//! output named, which is to say bytes an attacker can choose if they can
//! reach that server. The hash check is what makes them safe to parse, and the
//! byte, redirect and time limits are what stop a hostile server from doing
//! damage before the check ever happens.

use std::time::Duration;

use optn_core::bcmr::RegistryPublication;

/// Bounds a fetch must respect.
///
/// Not tuning knobs. A registry is a small JSON document, and anything that
/// does not fit these is not one — the limits exist so a server that answers
/// slowly, forever, or with a hundred megabytes cannot hold a wallet open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchLimits {
    pub max_bytes: usize,
    pub max_redirects: u8,
    pub deadline: Duration,
}

impl Default for FetchLimits {
    fn default() -> Self {
        Self {
            max_bytes: 2 * 1024 * 1024,
            max_redirects: 3,
            deadline: Duration::from_secs(20),
        }
    }
}

/// Why registry bytes could not be obtained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The response exceeded [`FetchLimits::max_bytes`].
    TooLarge {
        limit: usize,
    },
    TooManyRedirects {
        limit: u8,
    },
    Timeout,
    /// Source or transport policy forbids this URI.
    ///
    /// A Tor-required wallet must not quietly fetch a registry over a clear
    /// connection, and a scheme this build cannot reach is refused rather than
    /// rewritten into one it can.
    PolicyRefused {
        detail: String,
    },
    Transport {
        detail: String,
    },
}

/// What a wallet actually knows about a token's identity.
///
/// The variants are the point. Each says something different, and a screen
/// that renders them identically has thrown the difference away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityMetadata {
    /// Fetched from the current authhead's publication and hash-verified.
    Current {
        contents: Vec<u8>,
        source_uri: String,
    },
    /// Verified once, and the authhead has moved on or cannot be re-read.
    ///
    /// Usable for display, and only if it is labelled. The holder is looking
    /// at a name that was right before.
    LastKnown {
        contents: Vec<u8>,
        /// The authhead this was current for.
        authhead: [u8; 32],
        reason: StaleReason,
    },
    /// The authhead publishes nothing.
    ///
    /// Not a failure: the owner removed the publication, and the
    /// specification is explicit that an ancestor's does not carry forward.
    /// The token still exists and is still owned.
    Unpublished,
    /// Nothing could be verified. The token is still owned.
    Unresolved { reason: UnresolvedReason },
}

/// Why known-good metadata is no longer current.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaleReason {
    /// The identity moved to a new authhead this wallet has not read yet.
    AuthheadAdvanced,
    /// The current authhead's registry could not be fetched.
    RefetchFailed(FetchError),
    /// A reorg invalidated the chain position this was resolved at.
    ChainReorganised { at_height: u32 },
}

/// Why nothing could be established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnresolvedReason {
    /// The authchain walk did not reach an authhead.
    AuthchainIncomplete,
    /// Every published URI failed.
    AllSourcesFailed(Vec<FetchError>),
    /// Bytes arrived and did not match the committed hash.
    ///
    /// Kept apart from a transport failure on purpose: this is someone
    /// serving the wrong file under the right name, not a network problem.
    HashMismatch { attempted: Vec<String> },
    /// The publication named nowhere to fetch from.
    NoUriPublished,
}

/// One attempt's result, as a transport reports it.
pub type FetchAttempt = Result<Vec<u8>, FetchError>;

/// Resolve a publication into metadata, given whatever the transport returned.
///
/// Deliberately takes the results rather than a transport: the ordering,
/// bounding and policy checks belong to the caller, and keeping them out of
/// here means this logic is testable without a network and cannot itself reach
/// one. `attempts` pairs each URI with what came back, in the order tried.
///
/// The first response whose hash matches wins. A response that does not match
/// is not a fallback candidate — it is a wrong file, and trying the next URI is
/// the right move rather than showing it.
pub fn resolve(
    publication: &RegistryPublication,
    attempts: &[(String, FetchAttempt)],
) -> IdentityMetadata {
    if publication.uris.is_empty() {
        return IdentityMetadata::Unresolved {
            reason: UnresolvedReason::NoUriPublished,
        };
    }
    let mut failures = Vec::new();
    let mut mismatched = Vec::new();
    for (uri, attempt) in attempts {
        match attempt {
            Ok(contents) if publication.matches(contents) => {
                return IdentityMetadata::Current {
                    contents: contents.clone(),
                    source_uri: uri.clone(),
                };
            }
            Ok(_) => mismatched.push(uri.clone()),
            Err(error) => failures.push(error.clone()),
        }
    }
    if !mismatched.is_empty() {
        return IdentityMetadata::Unresolved {
            reason: UnresolvedReason::HashMismatch {
                attempted: mismatched,
            },
        };
    }
    IdentityMetadata::Unresolved {
        reason: UnresolvedReason::AllSourcesFailed(failures),
    }
}

/// Fall back to what was verified before, saying so.
///
/// For when the current authhead cannot be read but this wallet holds a
/// registry it verified earlier. The result is deliberately `LastKnown` rather
/// than `Current`: it was true once, and the difference is the whole point.
pub fn fall_back_to_cached(
    cached: Option<(Vec<u8>, [u8; 32])>,
    reason: StaleReason,
    otherwise: IdentityMetadata,
) -> IdentityMetadata {
    match cached {
        Some((contents, authhead)) => IdentityMetadata::LastKnown {
            contents,
            authhead,
            reason,
        },
        None => otherwise,
    }
}

impl IdentityMetadata {
    /// Whether this is the identity the chain endorses right now.
    pub const fn is_current(&self) -> bool {
        matches!(self, Self::Current { .. })
    }

    /// Whether a holder must be told the name may be out of date.
    ///
    /// True for anything that is not current, including the unresolved cases:
    /// a token shown with no name at all still needs to read as "we could not
    /// check this" rather than as a nameless token.
    pub const fn needs_a_caveat(&self) -> bool {
        !self.is_current()
    }

    /// Bytes safe to parse, if any.
    ///
    /// Only ever content whose hash matched, which is what makes parsing it
    /// defensible at all.
    pub fn verified_contents(&self) -> Option<&[u8]> {
        match self {
            Self::Current { contents, .. } | Self::LastKnown { contents, .. } => Some(contents),
            Self::Unpublished | Self::Unresolved { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn publication(contents: &[u8], uris: &[&str]) -> RegistryPublication {
        RegistryPublication::committing_to(
            contents,
            uris.iter().map(|uri| (*uri).to_owned()).collect(),
        )
    }

    #[test]
    fn matching_contents_resolve_to_current_metadata() {
        let body = br#"{"version":{"major":1}}"#;
        let publication = publication(body, &["example.com"]);
        let resolved = resolve(
            &publication,
            &[("https://example.com/x".into(), Ok(body.to_vec()))],
        );
        assert_eq!(
            resolved,
            IdentityMetadata::Current {
                contents: body.to_vec(),
                source_uri: "https://example.com/x".into(),
            }
        );
        assert!(resolved.is_current());
        assert!(!resolved.needs_a_caveat());
    }

    /// Whoever serves the file does not get to rename the token.
    #[test]
    fn contents_that_do_not_match_are_never_used() {
        let publication = publication(b"real registry", &["example.com"]);
        let resolved = resolve(
            &publication,
            &[(
                "https://example.com/x".into(),
                Ok(b"something else".to_vec()),
            )],
        );
        assert_eq!(
            resolved,
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::HashMismatch {
                    attempted: vec!["https://example.com/x".into()],
                },
            }
        );
        assert_eq!(resolved.verified_contents(), None);
    }

    /// A wrong file is not a reason to stop trying the alternatives.
    #[test]
    fn a_later_uri_can_still_supply_the_right_file() {
        let body = b"real registry";
        let publication = publication(body, &["bad.example", "good.example"]);
        let resolved = resolve(
            &publication,
            &[
                ("https://bad.example/x".into(), Ok(b"wrong".to_vec())),
                ("https://good.example/x".into(), Ok(body.to_vec())),
            ],
        );
        assert!(resolved.is_current());
        assert_eq!(resolved.verified_contents(), Some(body.as_slice()));
    }

    /// A mismatch is reported as a mismatch, not as a network problem.
    #[test]
    fn a_mismatch_outranks_transport_failures_in_the_report() {
        let publication = publication(b"real", &["a.example", "b.example"]);
        let resolved = resolve(
            &publication,
            &[
                ("https://a.example/x".into(), Err(FetchError::Timeout)),
                ("https://b.example/x".into(), Ok(b"wrong".to_vec())),
            ],
        );
        match resolved {
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::HashMismatch { attempted },
            } => assert_eq!(attempted, vec!["https://b.example/x".to_owned()]),
            other => panic!("someone serving the wrong file is not a timeout: {other:?}"),
        }
    }

    #[test]
    fn every_source_failing_is_unresolved_with_the_reasons_kept() {
        let publication = publication(b"real", &["a.example", "b.example"]);
        let resolved = resolve(
            &publication,
            &[
                ("https://a.example/x".into(), Err(FetchError::Timeout)),
                (
                    "https://b.example/x".into(),
                    Err(FetchError::TooLarge { limit: 2048 }),
                ),
            ],
        );
        assert_eq!(
            resolved,
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AllSourcesFailed(vec![
                    FetchError::Timeout,
                    FetchError::TooLarge { limit: 2048 },
                ]),
            }
        );
    }

    #[test]
    fn a_publication_naming_nowhere_is_reported_as_such() {
        let publication = publication(b"real", &[]);
        assert_eq!(
            resolve(&publication, &[]),
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::NoUriPublished,
            }
        );
    }

    /// Falling back is allowed; pretending it is current is not.
    #[test]
    fn a_cached_registry_comes_back_labelled_stale() {
        let cached = Some((b"older registry".to_vec(), [4u8; 32]));
        let resolved = fall_back_to_cached(
            cached,
            StaleReason::RefetchFailed(FetchError::Timeout),
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AuthchainIncomplete,
            },
        );
        assert_eq!(
            resolved,
            IdentityMetadata::LastKnown {
                contents: b"older registry".to_vec(),
                authhead: [4u8; 32],
                reason: StaleReason::RefetchFailed(FetchError::Timeout),
            }
        );
        assert!(!resolved.is_current());
        assert!(
            resolved.needs_a_caveat(),
            "a name that was right before still has to be labelled"
        );
        // Usable, because it was verified when it was cached.
        assert_eq!(
            resolved.verified_contents(),
            Some(b"older registry".as_slice())
        );
    }

    #[test]
    fn with_nothing_cached_the_fallback_keeps_the_original_answer() {
        let resolved = fall_back_to_cached(
            None,
            StaleReason::AuthheadAdvanced,
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AuthchainIncomplete,
            },
        );
        assert_eq!(
            resolved,
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AuthchainIncomplete,
            }
        );
    }

    /// An owner withdrawing a publication is a statement, not a failure.
    #[test]
    fn an_unpublished_identity_is_distinct_from_an_unreachable_one() {
        assert_ne!(
            IdentityMetadata::Unpublished,
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AuthchainIncomplete,
            }
        );
        assert!(IdentityMetadata::Unpublished.needs_a_caveat());
        assert_eq!(IdentityMetadata::Unpublished.verified_contents(), None);
    }

    /// Unverified bytes never reach a parser, whatever the outcome.
    #[test]
    fn only_hash_verified_bytes_are_offered_for_parsing() {
        for metadata in [
            IdentityMetadata::Unpublished,
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::HashMismatch {
                    attempted: vec!["x".into()],
                },
            },
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AllSourcesFailed(vec![FetchError::Timeout]),
            },
        ] {
            assert_eq!(metadata.verified_contents(), None, "{metadata:?}");
        }
    }

    /// A reorg makes a resolved identity stale rather than wrong.
    #[test]
    fn a_reorg_downgrades_a_resolved_identity() {
        let resolved = fall_back_to_cached(
            Some((b"registry".to_vec(), [1u8; 32])),
            StaleReason::ChainReorganised { at_height: 800_000 },
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AuthchainIncomplete,
            },
        );
        assert!(matches!(
            resolved,
            IdentityMetadata::LastKnown {
                reason: StaleReason::ChainReorganised { at_height: 800_000 },
                ..
            }
        ));
    }
}

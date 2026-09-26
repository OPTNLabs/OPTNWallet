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

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use optn_app::{AppAction, AppState, IdentityStatus, TokenIdentity};
use optn_core::bcmr::{publication_in, RegistryPublication};

use crate::authchain::{
    self, AuthchainBudget, AuthchainResolution, AuthchainStep, ChainTransaction,
};
use crate::capability_planner::{candidate_plans, CapabilityPlan, TokenCapabilityOperation};
use crate::chain::Evidence;
use crate::chain_service::ObservedTransaction;

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

/// Platform-owned byte transport; publication/evidence acceptance stays here.
/// Native hosts execute the selected privacy route, while a restricted host
/// may omit this port entirely. No wallet material crosses it.
pub trait RegistryFetcher: Send + Sync {
    /// Selected metadata services may offer alternate registry byte locations.
    /// These are untrusted candidates, never authchain or token ownership evidence.
    fn registry_candidates(&self, _category: [u8; 32]) -> Vec<String> {
        Vec::new()
    }

    fn fetch<'a>(
        &'a self,
        uri: &'a str,
        limits: FetchLimits,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FetchAttempt> + Send + 'a>>;
}

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
    if publication.uris.is_empty() && attempts.is_empty() {
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

fn category_hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Turn resolved metadata into the observation the application accepts.
///
/// Renderers never call this. The hash check already happened in [`resolve`];
/// this only names the category and marks how far the identity got.
pub fn observe_identity(category: [u8; 32], metadata: IdentityMetadata) -> AppAction {
    let category_hex = category_hex(&category);
    let parsed = metadata
        .verified_contents()
        .and_then(|bytes| optn_core::bcmr::names_for_category(bytes, &category_hex));
    let identity = match (&metadata, parsed) {
        (IdentityMetadata::Current { .. }, Some(names)) => TokenIdentity {
            name: names.name,
            ticker: names.ticker,
            decimals: names.decimals,
            status: IdentityStatus::Verified,
        },
        (IdentityMetadata::LastKnown { .. }, Some(names)) => TokenIdentity {
            name: names.name,
            ticker: names.ticker,
            decimals: names.decimals,
            status: IdentityStatus::Stale,
        },
        (IdentityMetadata::Unpublished, _) => TokenIdentity {
            name: category_hex.clone(),
            ticker: None,
            decimals: 0,
            status: IdentityStatus::Unpublished,
        },
        (IdentityMetadata::Unresolved { .. }, _) | (_, None) => TokenIdentity {
            name: category_hex.clone(),
            ticker: None,
            decimals: 0,
            status: IdentityStatus::Unresolved,
        },
    };
    AppAction::SetTokenIdentity {
        category_hex,
        identity,
    }
}

/// Resolve a publication, then publish the observation.
pub fn observe_publication(
    category: [u8; 32],
    publication: &RegistryPublication,
    attempts: &[(String, FetchAttempt)],
) -> AppAction {
    observe_identity(category, resolve(publication, attempts))
}

/// What the live wallet-sync finish path already knows about one owned category.
///
/// Publications and fetch bytes come from the runtime's authchain walk and
/// [`TokenCapabilityOperation::BcmrAuthhead`] plans. A missing map entry is
/// not unpublished: it means this wallet did not reach an authhead, so the
/// identity stays unresolved. Timeout and incomplete lookup must never become
/// an authhead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnedCategoryIdentity {
    /// Authhead publication plus the fetch attempts already made for it.
    Observed {
        publication: RegistryPublication,
        attempts: Vec<(String, FetchAttempt)>,
    },
    /// The authhead publishes nothing. Distinct from an incomplete walk.
    Unpublished,
    /// The walk did not reach an authhead. Never Current.
    Unresolved,
}

/// Capability plans a live resolver may use to obtain an authhead.
///
/// Direct `BcmrAuthhead` and spender-derived walks are both valid. Neither
/// plan names Electrum, Fulcrum, BIP37, or Neutrino, so a BIP37-only policy
/// cannot pick up an Electrum shortcut from this module.
pub fn owned_identity_plans() -> Vec<CapabilityPlan> {
    candidate_plans(TokenCapabilityOperation::BcmrAuthhead)
}

/// Categories this wallet currently holds, from its own coins.
pub fn owned_token_categories(app: &AppState) -> BTreeSet<[u8; 32]> {
    app.coins
        .iter()
        .filter_map(|coin| coin.token().map(|token| token.category))
        .collect()
}

/// Observed transactions plus registry fetch attempts for one identity walk.
///
/// Fetch bytes are transport results, not an identity. The collector still
/// walks the authchain; a missing authhead never becomes Current.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityCollection {
    pub transactions: Vec<ChainTransaction>,
    pub fetch_attempts: Vec<(String, FetchAttempt)>,
    pub evidence: Evidence,
}

impl IdentityCollection {
    /// Decode snapshot transactions into the provider-neutral authchain shape.
    pub fn from_observed(
        transactions: &[ObservedTransaction],
        fetch_attempts: Vec<(String, FetchAttempt)>,
        evidence: Evidence,
    ) -> Self {
        let transactions = transactions
            .iter()
            .filter_map(|observed| {
                if optn_core::header_hash::sha256d(&observed.raw) != observed.txid {
                    return None;
                }
                let decoded = optn_core::tx::decode(&observed.raw).ok()?;
                Some(ChainTransaction {
                    txid: observed.txid,
                    inputs: decoded
                        .inputs
                        .into_iter()
                        .map(|(txid, vout, _)| (txid, vout))
                        .collect(),
                    outputs: decoded
                        .outputs
                        .into_iter()
                        .map(|output| output.script_pubkey)
                        .collect(),
                    block_height: observed.block_height,
                })
            })
            .collect();
        Self {
            transactions,
            fetch_attempts,
            evidence,
        }
    }
}

/// Resolve owned identities through the selected capability routes. Wallet
/// history may nominate a successor, but the same node must supply its bytes
/// and explicitly establish the terminal output's unspent status.
pub(crate) async fn resolve_selected_identities(
    service: &mut crate::chain_service::ChainService,
    categories: BTreeSet<[u8; 32]>,
    transactions: &[ObservedTransaction],
) -> BTreeMap<[u8; 32], OwnedCategoryIdentity> {
    use crate::chain_service::{ChainOperation, ChainPayload, ChainRequest, OutpointSpentness};
    let mut identities = BTreeMap::new();
    let collection =
        IdentityCollection::from_observed(transactions, vec![], Evidence::ServerAssertion);
    let fetcher = service.registry_fetcher();
    let source_lifetime = service.revocation();
    let mut bytes_left = FetchLimits::default().max_bytes;
    // Bound optional metadata work for a refresh. Unfinished categories remain
    // unresolved without withholding the wallet's accepted coins or history.
    let work = async {
        for category in categories.into_iter().take(32) {
            let mut identity = OwnedCategoryIdentity::Unresolved;
            for route in service.routes_for_operation(ChainOperation::OutpointSpentness) {
                let Some(transaction_route) =
                    service.matching_route_for_operation(&route, ChainOperation::TransactionLookup)
                else {
                    continue;
                };
                let mut walk = AuthchainResolution::begin(
                    category,
                    AuthchainBudget {
                        max_hops: 64,
                        ..Default::default()
                    },
                );
                let mut step = walk.next_step();
                while let AuthchainStep::Query { txid } = step {
                    let Ok(observed) = service
                        .execute_on_route(
                            &transaction_route,
                            &ChainRequest::TransactionLookup { txid },
                        )
                        .await
                    else {
                        break;
                    };
                    if !matches!(&observed.evidence, Evidence::FullNodeValidated { source } if source == &route.source)
                    {
                        break;
                    }
                    let ChainPayload::Transaction(transaction) = observed.value else {
                        break;
                    };
                    let Ok(decoded) = optn_core::tx::decode(&transaction.raw) else {
                        break;
                    };
                    let current = IdentityCollection::from_observed(
                        &[transaction],
                        vec![],
                        observed.evidence,
                    );
                    let Some(current) = current.transactions.first() else {
                        break;
                    };
                    walk.inspect(current);
                    if matches!(
                        optn_core::bcmr::identity_output_state(
                            current.outputs.first().map(Vec::as_slice)
                        ),
                        optn_core::bcmr::IdentityOutputState::Burned
                    ) {
                        identity = OwnedCategoryIdentity::Unpublished;
                        break;
                    }
                    let mut successors = collection
                        .transactions
                        .iter()
                        .filter(|candidate| candidate.inputs.contains(&(txid, 0)));
                    if let Some(successor) = successors.next() {
                        if successors.next().is_some() {
                            break;
                        }
                        step = walk.accept(authchain::IdentityStatus::SpentBy(successor.clone()));
                        continue;
                    }
                    let Ok(unspent) = service
                        .execute_on_route(
                            &route,
                            &ChainRequest::OutpointSpentness { txid, vout: 0 },
                        )
                        .await
                    else {
                        break;
                    };
                    if !matches!(&unspent.evidence, Evidence::FullNodeValidated { source } if source == &route.source)
                    {
                        break;
                    }
                    let ChainPayload::OutpointSpentness(OutpointSpentness::Unspent {
                        value_sats,
                        script_pubkey,
                        ..
                    }) = unspent.value
                    else {
                        break;
                    };
                    if !decoded.outputs.first().is_some_and(|output| {
                        output.value == value_sats && output.script_pubkey == script_pubkey
                    }) {
                        break;
                    }
                    step = walk.accept(authchain::IdentityStatus::Unspent {
                        evidence: unspent.evidence,
                    });
                }
                if let AuthchainStep::Resolved(head) = step {
                    let mut resolved = IdentityCollection {
                        transactions: vec![],
                        fetch_attempts: vec![],
                        evidence: head.evidence.clone(),
                    };
                    if let (Some(publication), Some(fetcher)) = (
                        publication_in(head.outputs.iter().map(Vec::as_slice)),
                        fetcher.as_ref(),
                    ) {
                        let candidates = fetcher.registry_candidates(category);
                        for uri in publication
                            .uris
                            .iter()
                            .take(3)
                            .chain(candidates.iter().take(3))
                        {
                            if bytes_left == 0 {
                                break;
                            }
                            let attempt = fetcher
                                .fetch(
                                    uri,
                                    FetchLimits {
                                        max_bytes: bytes_left,
                                        ..Default::default()
                                    },
                                )
                                .await
                                .and_then(|bytes| {
                                    if bytes.len() > bytes_left {
                                        Err(FetchError::TooLarge { limit: bytes_left })
                                    } else {
                                        Ok(bytes)
                                    }
                                });
                            let matches = attempt
                                .as_ref()
                                .is_ok_and(|bytes| publication.matches(bytes));
                            if let Ok(bytes) = &attempt {
                                bytes_left = bytes_left.saturating_sub(bytes.len());
                            }
                            resolved.fetch_attempts.push((uri.clone(), attempt));
                            if matches {
                                break;
                            }
                        }
                        // An indexer's bytes are accepted by the same publication hash
                        // gate as publisher bytes. Keep the actual source URI for evidence.
                        identity = OwnedCategoryIdentity::Observed {
                            publication,
                            attempts: resolved.fetch_attempts,
                        };
                    } else {
                        identity = identity_from_step(AuthchainStep::Resolved(head), &resolved);
                    }
                    break;
                }
            }
            identities.insert(category, identity);
        }
    };
    tokio::select! {
        biased;
        _ = source_lifetime.cancelled() => {},
        _ = tokio::time::timeout(FetchLimits::default().deadline, work) => {},
    }
    identities
}

/// Walk every owned category through the BCMR authchain plans.
///
/// Timeout, missing history, and a missing authbase are unresolved — never an
/// authhead. An authhead with no publication is unpublished. Fetch attempts
/// are applied only after that walk.
pub fn collect_owned_token_identities(
    categories: impl IntoIterator<Item = [u8; 32]>,
    collection: &IdentityCollection,
) -> BTreeMap<[u8; 32], OwnedCategoryIdentity> {
    let mut observations = BTreeMap::new();
    if owned_identity_plans().is_empty() {
        return observations;
    }
    let by_id: BTreeMap<_, _> = collection
        .transactions
        .iter()
        .map(|tx| (tx.txid, tx))
        .collect();
    let mut spender: BTreeMap<[u8; 32], &ChainTransaction> = BTreeMap::new();
    for tx in &collection.transactions {
        for (prev, vout) in &tx.inputs {
            if *vout == 0 {
                spender.insert(*prev, tx);
            }
        }
    }
    for category in categories {
        observations.insert(
            category,
            resolve_owned_category(category, &by_id, &spender, collection),
        );
    }
    observations
}

fn resolve_owned_category(
    category: [u8; 32],
    by_id: &BTreeMap<[u8; 32], &ChainTransaction>,
    spender: &BTreeMap<[u8; 32], &ChainTransaction>,
    collection: &IdentityCollection,
) -> OwnedCategoryIdentity {
    let mut walk = AuthchainResolution::begin(category, AuthchainBudget::default());
    let mut pending = walk.next_step();
    let step = loop {
        match pending {
            AuthchainStep::Query { txid } => {
                pending = match by_id.get(&txid) {
                    None => walk.accept(authchain::IdentityStatus::Unknown(
                        authchain::UnknownReason::IncompleteHistory,
                    )),
                    Some(tx) => {
                        walk.inspect(tx);
                        let status = match spender.get(&txid) {
                            Some(successor) => {
                                authchain::IdentityStatus::SpentBy((*successor).clone())
                            }
                            // Wallet transactions are not a complete spender index.
                            // Even a proof of inclusion says nothing about a later
                            // spend outside this wallet's scripts or scan range.
                            None => authchain::IdentityStatus::Unknown(
                                authchain::UnknownReason::IncompleteHistory,
                            ),
                        };
                        walk.accept(status)
                    }
                };
            }
            other => break other,
        }
    };
    identity_from_step(step, collection)
}

fn identity_from_step(
    step: AuthchainStep,
    collection: &IdentityCollection,
) -> OwnedCategoryIdentity {
    match step {
        AuthchainStep::Resolved(head)
            if matches!(head.evidence, Evidence::FullNodeValidated { .. }) =>
        {
            identity_from_outputs(&head.outputs, collection)
        }
        AuthchainStep::Resolved(_) => OwnedCategoryIdentity::Unresolved,
        AuthchainStep::Burned { .. } => OwnedCategoryIdentity::Unpublished,
        AuthchainStep::Query { .. }
        | AuthchainStep::Incomplete { .. }
        | AuthchainStep::InvalidEvidence { .. }
        | AuthchainStep::ConflictingEvidence { .. } => OwnedCategoryIdentity::Unresolved,
    }
}

fn identity_from_outputs(
    outputs: &[Vec<u8>],
    collection: &IdentityCollection,
) -> OwnedCategoryIdentity {
    let Some(publication) = publication_in(outputs.iter().map(Vec::as_slice)) else {
        return OwnedCategoryIdentity::Unpublished;
    };
    let attempts = publication
        .uris
        .iter()
        .map(|uri| {
            let resolved = RegistryPublication::resolve_uri(uri);
            let attempt = collection
                .fetch_attempts
                .iter()
                .find(|(candidate, _)| candidate == &resolved || candidate == uri)
                .map(|(_, attempt)| attempt.clone())
                .unwrap_or(Err(FetchError::Transport {
                    detail: "registry was not fetched".into(),
                }));
            (resolved, attempt)
        })
        .collect();
    OwnedCategoryIdentity::Observed {
        publication,
        attempts,
    }
}

/// Publish identities for every owned token category through
/// [`observe_publication`] / [`observe_identity`] and `reduce`.
///
/// This is the live wallet-sync publisher. A renderer cannot call it: finish
/// does, after coins have been applied. A category with no observation is
/// unresolved, never current. Hash mismatch is not current. Unpublished keeps
/// the coin visible with a caveat.
pub fn apply_owned_token_identities(
    app: &mut AppState,
    observations: &BTreeMap<[u8; 32], OwnedCategoryIdentity>,
) {
    for category in owned_token_categories(app) {
        let mut action = match observations.get(&category) {
            Some(OwnedCategoryIdentity::Observed {
                publication,
                attempts,
            }) => observe_publication(category, publication, attempts),
            Some(OwnedCategoryIdentity::Unpublished) => {
                observe_identity(category, IdentityMetadata::Unpublished)
            }
            Some(OwnedCategoryIdentity::Unresolved) | None => observe_identity(
                category,
                IdentityMetadata::Unresolved {
                    reason: UnresolvedReason::AuthchainIncomplete,
                },
            ),
        };
        if let AppAction::SetTokenIdentity {
            category_hex,
            identity,
        } = &mut action
        {
            if identity.status == IdentityStatus::Unresolved {
                if let Some(cached) = app.token_identities.get(category_hex).filter(|cached| {
                    matches!(
                        cached.status,
                        IdentityStatus::Verified | IdentityStatus::Stale
                    )
                }) {
                    // A failed refresh cannot authenticate a new name or erase
                    // an old one. Preserve it only with the last-known caveat.
                    *identity = cached.clone();
                    identity.status = IdentityStatus::Stale;
                }
            }
        }
        app.reduce(action);
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

    #[test]
    fn authhead_evidence_is_not_discarded_when_projecting_identity() {
        let collection = IdentityCollection {
            transactions: vec![],
            fetch_attempts: vec![],
            evidence: Evidence::ServerAssertion,
        };
        for evidence in [
            Evidence::ServerAssertion,
            Evidence::FullNodeValidated {
                source: "node".into(),
            },
        ] {
            let trusted = matches!(evidence, Evidence::FullNodeValidated { .. });
            let result = identity_from_step(
                AuthchainStep::Resolved(authchain::ResolvedAuthhead {
                    authhead: [1; 32],
                    hops: 0,
                    block_height: None,
                    outputs: vec![p2pkh()],
                    evidence,
                }),
                &collection,
            );
            assert_eq!(
                result,
                if trusted {
                    OwnedCategoryIdentity::Unpublished
                } else {
                    OwnedCategoryIdentity::Unresolved
                }
            );
        }
    }

    #[test]
    fn identity_history_rejects_transaction_bytes_with_another_id() {
        let raw = vec![2, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let txid = optn_core::header_hash::sha256d(&raw);
        let mut transaction = ObservedTransaction {
            txid,
            raw,
            block_height: None,
        };
        assert_eq!(
            IdentityCollection::from_observed(
                &[transaction.clone()],
                vec![],
                Evidence::ServerAssertion
            )
            .transactions
            .len(),
            1
        );
        transaction.txid[0] ^= 1;
        assert!(IdentityCollection::from_observed(
            &[transaction],
            vec![],
            Evidence::ServerAssertion
        )
        .transactions
        .is_empty());
    }

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

    #[test]
    fn hash_only_publication_accepts_selected_candidate_bytes_but_not_another_hash() {
        let body = registry_body("Bitcats", ALPHA);
        let publication = publication(&body, &[]);
        let uri = "https://indexer.example/registry".to_owned();
        for (bytes, expected) in [
            (body, IdentityStatus::Verified),
            (b"wrong registry".to_vec(), IdentityStatus::Unresolved),
        ] {
            let mut state = wallet_with(vec![coin(
                1,
                1_000,
                Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
            )]);
            apply_owned_token_identities(
                &mut state,
                &BTreeMap::from([(
                    ALPHA,
                    OwnedCategoryIdentity::Observed {
                        publication: publication.clone(),
                        attempts: vec![(uri.clone(), Ok(bytes))],
                    },
                )]),
            );
            let assets = optn_app::assets_view_model(&state);
            assert_eq!(
                assets.categories[0].identity.as_ref().unwrap().status,
                expected
            );
            assert_eq!(state.coins.len(), 1);
        }
    }

    #[test]
    fn malformed_first_publication_cannot_be_replaced_by_later_verified_bytes() {
        let body = registry_body("Bitcats", ALPHA);
        let input = collection(&body, "example.com", Ok(body.clone()), true, true);
        let outputs = vec![
            p2pkh(),
            optn_core::bcmr::PUBLICATION_PREFIX.to_vec(),
            publication_script(&body, "example.com"),
        ];
        assert_eq!(
            identity_from_outputs(&outputs, &input),
            OwnedCategoryIdentity::Unpublished
        );
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

    const ALPHA: [u8; 32] = [0xaa; 32];

    fn registry_body(name: &str, category: [u8; 32]) -> Vec<u8> {
        let hex = category_hex(&category);
        format!(
            r#"{{"identities":{{"{}":{{"1700000000":{{"name":"{name}","token":{{"category":"{hex}","symbol":"BCAT","decimals":2}}}}}}}}}}"#,
            "00".repeat(32)
        )
        .into_bytes()
    }

    fn coin(seed: u8, sats: u64, token: Option<optn_core::token::TokenData>) -> optn_app::Coin {
        let outpoint = optn_app::Outpoint::new([seed; 32], u32::from(seed));
        let coin = optn_app::Coin::new(outpoint, sats, format!("bitcoincash:q{seed}"))
            .expect("a non-zero coin");
        match token {
            Some(token) => coin.with_token(token),
            None => coin,
        }
    }

    fn nft(category: [u8; 32], commitment: &[u8]) -> optn_core::token::TokenData {
        optn_core::token::TokenData {
            category,
            amount: 0,
            nft: Some(optn_core::token::Nft {
                capability: optn_core::token::Capability::None,
                commitment: commitment.to_vec(),
            }),
        }
    }

    fn wallet_with(coins: Vec<optn_app::Coin>) -> optn_app::AppState {
        let mut state = optn_app::AppState::for_surface(optn_app::AppSurface::Desktop);
        for coin in coins {
            state.coins.insert(coin).expect("distinct outpoints");
        }
        state
    }

    /// Hash-matching publication bytes become the Current name on Assets and
    /// My NFTs. This drives [`observe_publication`], not a pre-built identity.
    #[test]
    fn hash_matching_publication_becomes_current_identity_on_assets_and_nfts() {
        let body = registry_body("Bitcats", ALPHA);
        let publication = publication(&body, &["example.com"]);
        let mut state = wallet_with(vec![
            coin(
                1,
                1_000,
                Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
            ),
            coin(2, 1_000, Some(nft(ALPHA, b"\x01"))),
        ]);
        state.reduce(observe_publication(
            ALPHA,
            &publication,
            &[("https://example.com/x".into(), Ok(body))],
        ));

        let assets = optn_app::assets_view_model(&state);
        let identity = assets.categories[0]
            .identity
            .as_ref()
            .expect("resolved identity");
        assert_eq!(identity.name, "Bitcats");
        assert_eq!(identity.status, IdentityStatus::Verified);
        assert_eq!(identity.status.caveat(), None);
        let nfts = optn_app::nfts_view_model(&state);
        assert_eq!(
            nfts.nfts[0]
                .identity
                .as_ref()
                .map(|item| item.name.as_str()),
            Some("Bitcats")
        );
    }

    #[test]
    fn a_mismatched_hash_is_not_shown_as_current() {
        let body = registry_body("Bitcats", ALPHA);
        let publication = publication(&body, &["example.com"]);
        let mut state = wallet_with(vec![coin(
            1,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        state.reduce(observe_publication(
            ALPHA,
            &publication,
            &[(
                "https://example.com/x".into(),
                Ok(b"something else".to_vec()),
            )],
        ));
        let assets = optn_app::assets_view_model(&state);
        assert_eq!(assets.categories.len(), 1);
        let identity = assets.categories[0]
            .identity
            .as_ref()
            .expect("unresolved still named");
        assert_ne!(identity.status, IdentityStatus::Verified);
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert!(identity.status.caveat().is_some());
        assert_ne!(identity.name, "Bitcats");
    }

    #[test]
    fn unpublished_and_unresolved_keep_the_coin_visible_with_a_caveat() {
        let mut unpublished = wallet_with(vec![coin(
            1,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        unpublished.reduce(observe_identity(ALPHA, IdentityMetadata::Unpublished));
        let assets = optn_app::assets_view_model(&unpublished);
        assert_eq!(assets.categories.len(), 1);
        let identity = assets.categories[0].identity.as_ref().expect("status");
        assert_eq!(identity.status, IdentityStatus::Unpublished);
        assert_eq!(identity.status.caveat(), Some("no registry published"));

        let mut unresolved = wallet_with(vec![coin(
            2,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        unresolved.reduce(observe_identity(
            ALPHA,
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AuthchainIncomplete,
            },
        ));
        let assets = optn_app::assets_view_model(&unresolved);
        assert_eq!(assets.categories.len(), 1);
        let identity = assets.categories[0].identity.as_ref().expect("status");
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert_eq!(identity.status.caveat(), Some("unverified"));
    }

    #[tokio::test]
    async fn the_runtime_keeps_identity_stale_without_fresh_sync_and_a_renderer_cannot_publish() {
        let body = registry_body("Bitcats", ALPHA);
        let publication = publication(&body, &["example.com"]);
        let state = wallet_with(vec![coin(
            1,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        let runtime = crate::AppRuntime::spawn(state);
        let action = observe_publication(
            ALPHA,
            &publication,
            &[("https://example.com/x".into(), Ok(body))],
        );
        runtime.dispatch(action.clone()).await.expect("dispatch");
        assert!(
            runtime.state().token_identities.is_empty(),
            "a renderer dispatch must not publish a name"
        );
        runtime.observe(action).await.expect("observe");
        let assets = optn_app::assets_view_model(&runtime.state());
        assert_eq!(
            assets.categories[0]
                .identity
                .as_ref()
                .map(|identity| identity.name.as_str()),
            Some("Bitcats")
        );
        assert_eq!(
            assets.categories[0]
                .identity
                .as_ref()
                .map(|identity| identity.status),
            Some(IdentityStatus::Stale)
        );
    }

    #[test]
    fn failed_identity_refresh_keeps_last_known_but_unpublication_clears_it() {
        let mut state = wallet_with(vec![coin(
            1,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        let body = registry_body("Bitcats", ALPHA);
        let published = OwnedCategoryIdentity::Observed {
            publication: publication(&body, &["example.com"]),
            attempts: vec![("https://example.com".into(), Ok(body))],
        };
        apply_owned_token_identities(&mut state, &BTreeMap::from([(ALPHA, published)]));
        let key = category_hex(&ALPHA);
        assert_eq!(
            state.token_identities[&key].status,
            IdentityStatus::Verified
        );
        for observation in [
            BTreeMap::new(),
            BTreeMap::from([(ALPHA, OwnedCategoryIdentity::Unresolved)]),
        ] {
            apply_owned_token_identities(&mut state, &observation);
            let identity = &state.token_identities[&key];
            assert_eq!(identity.name, "Bitcats");
            assert_eq!(identity.status, IdentityStatus::Stale);
        }
        apply_owned_token_identities(
            &mut state,
            &BTreeMap::from([(ALPHA, OwnedCategoryIdentity::Unpublished)]),
        );
        assert_eq!(
            state.token_identities[&key].status,
            IdentityStatus::Unpublished
        );
        assert_ne!(state.token_identities[&key].name, "Bitcats");
        apply_owned_token_identities(&mut state, &BTreeMap::new());
        assert_eq!(
            state.token_identities[&key].status,
            IdentityStatus::Unresolved
        );
        assert_eq!(state.coins.len(), 1);
    }

    fn p2pkh() -> Vec<u8> {
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(&[0u8; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        script
    }

    fn publication_script(contents: &[u8], uri: &str) -> Vec<u8> {
        let hash = RegistryPublication::committing_to(contents, vec![uri.to_owned()]).content_hash;
        let mut script = optn_core::bcmr::PUBLICATION_PREFIX.to_vec();
        script.push(32);
        script.extend_from_slice(&hash);
        script.push(u8::try_from(uri.len()).expect("short uri"));
        script.extend_from_slice(uri.as_bytes());
        script
    }

    fn collection(
        contents: &[u8],
        uri: &str,
        attempt: FetchAttempt,
        authbase: bool,
        publishes: bool,
    ) -> IdentityCollection {
        let transactions = if authbase {
            let outputs = if publishes {
                vec![p2pkh(), publication_script(contents, uri)]
            } else {
                vec![p2pkh()]
            };
            vec![ChainTransaction {
                txid: ALPHA,
                inputs: vec![],
                outputs,
                block_height: Some(1),
            }]
        } else {
            Vec::new()
        };
        IdentityCollection {
            transactions,
            fetch_attempts: vec![(RegistryPublication::resolve_uri(uri), attempt)],
            evidence: crate::chain::Evidence::ServerAssertion,
        }
    }

    fn publish_collected(state: &mut optn_app::AppState, collection: &IdentityCollection) {
        let observations =
            collect_owned_token_identities(owned_token_categories(state), collection);
        apply_owned_token_identities(state, &observations);
    }

    /// Hash-matching bytes cannot establish that a wallet-local transaction
    /// is still the authhead. Inclusion evidence cannot prove absence of a spend.
    #[test]
    fn live_publisher_requires_spentness_evidence_even_for_matching_bytes() {
        let body = registry_body("Bitcats", ALPHA);
        let mut state = wallet_with(vec![
            coin(
                1,
                1_000,
                Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
            ),
            coin(2, 1_000, Some(nft(ALPHA, b"\x01"))),
        ]);
        for evidence in [
            Evidence::ServerAssertion,
            Evidence::MerkleTransactionIncluded {
                txid: ALPHA,
                block_hash: [1; 32],
                height: 1,
            },
            Evidence::FullNodeValidated {
                source: "fixture".into(),
            },
        ] {
            let mut input = collection(&body, "example.com", Ok(body.clone()), true, true);
            input.evidence = evidence;
            publish_collected(&mut state, &input);
            let assets = optn_app::assets_view_model(&state);
            let identity = assets.categories[0]
                .identity
                .as_ref()
                .expect("resolved identity");
            assert_eq!(identity.name, category_hex(&ALPHA));
            assert_eq!(identity.status, IdentityStatus::Unresolved);
            assert_eq!(identity.status.caveat(), Some("unverified"));
            let nfts = optn_app::nfts_view_model(&state);
            assert_eq!(
                nfts.nfts[0]
                    .identity
                    .as_ref()
                    .map(|item| item.name.as_str()),
                Some(category_hex(&ALPHA).as_str())
            );
        }
    }

    #[test]
    fn live_publisher_does_not_show_a_hash_mismatch_as_current() {
        let body = registry_body("Bitcats", ALPHA);
        let mut state = wallet_with(vec![coin(
            1,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        publish_collected(
            &mut state,
            &collection(
                &body,
                "example.com",
                Ok(b"something else".to_vec()),
                true,
                true,
            ),
        );
        let assets = optn_app::assets_view_model(&state);
        assert_eq!(assets.categories.len(), 1);
        let identity = assets.categories[0]
            .identity
            .as_ref()
            .expect("unresolved still named");
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert!(identity.status.caveat().is_some());
        assert_ne!(identity.name, "Bitcats");
    }

    #[test]
    fn live_publisher_does_not_infer_withdrawal_from_incomplete_history() {
        let body = registry_body("Bitcats", ALPHA);
        let mut unpublished = wallet_with(vec![coin(
            1,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        publish_collected(
            &mut unpublished,
            &collection(&body, "example.com", Ok(body.clone()), true, false),
        );
        let assets = optn_app::assets_view_model(&unpublished);
        assert_eq!(assets.categories.len(), 1);
        let identity = assets.categories[0].identity.as_ref().expect("status");
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert_eq!(identity.status.caveat(), Some("unverified"));

        let mut unresolved = wallet_with(vec![coin(
            2,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        publish_collected(
            &mut unresolved,
            &collection(&body, "example.com", Ok(body.clone()), false, false),
        );
        let assets = optn_app::assets_view_model(&unresolved);
        assert_eq!(assets.categories.len(), 1);
        let identity = assets.categories[0].identity.as_ref().expect("status");
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert_eq!(identity.status.caveat(), Some("unverified"));
        assert_ne!(identity.status, IdentityStatus::Verified);
    }

    #[test]
    fn live_publisher_leaves_a_renderer_unable_to_inject_a_name() {
        let body = registry_body("Bitcats", ALPHA);
        let mut state = wallet_with(vec![coin(
            1,
            1_000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        publish_collected(
            &mut state,
            &collection(&body, "example.com", Ok(body.clone()), false, false),
        );
        state.reduce_intent(optn_app::AppAction::SetTokenIdentity {
            category_hex: category_hex(&ALPHA),
            identity: TokenIdentity {
                name: "Totally Real Coin".into(),
                ticker: None,
                decimals: 0,
                status: IdentityStatus::Verified,
            },
        });
        let assets = optn_app::assets_view_model(&state);
        let identity = assets.categories[0].identity.as_ref().expect("status");
        assert_ne!(identity.name, "Totally Real Coin");
        assert_eq!(identity.status, IdentityStatus::Unresolved);
    }

    #[test]
    fn identity_plans_stay_provider_neutral() {
        use crate::capability_planner::LocalDerivation;
        use crate::chain::Capability;

        let plans = owned_identity_plans();
        assert!(
            plans.iter().any(|plan| matches!(
                plan,
                CapabilityPlan::Direct {
                    capability: Capability::BcmrAuthhead
                }
            )),
            "a direct authhead capability remains available"
        );
        assert!(
            plans.iter().any(|plan| matches!(
                plan,
                CapabilityPlan::Derived {
                    derivation: LocalDerivation::BcmrAuthheadFromSpenderLookup,
                    ..
                }
            )),
            "a BIP37-only wallet can still walk via spender lookup"
        );
        for plan in &plans {
            for capability in plan.requirements() {
                assert_ne!(
                    *capability,
                    Capability::ElectrumProtocol,
                    "authhead plans must not require Electrum"
                );
            }
        }
    }
}

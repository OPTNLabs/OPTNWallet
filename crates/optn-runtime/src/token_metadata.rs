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
use optn_core::network::Network;
use serde::{Deserialize, Serialize};

use crate::authchain::{
    self, AuthchainBudget, AuthchainResolution, AuthchainStep, ChainTransaction,
};
use crate::capability_planner::{candidate_plans, CapabilityPlan, TokenCapabilityOperation};
use crate::chain::{Evidence, Hash32, SourceId};
use crate::chain_service::{CapabilityRoute, ObservedTransaction};

const MAX_IDENTITY_CATEGORIES: usize = 32;
const MAX_AUTHCHAIN_HOPS: u32 = 64;

fn identity_budget() -> AuthchainBudget {
    AuthchainBudget {
        max_hops: MAX_AUTHCHAIN_HOPS,
        ..Default::default()
    }
}

/// Authenticated restart hints, never current evidence or application state.
/// Private records are minted only by the resolver and stored inside the
/// existing encrypted wallet checkpoint. Even a locally valid record requires
/// a new selected-node lookup and terminal unspent observation.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct BcmrIdentityCache(BTreeMap<String, CachedBcmrIdentity>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CachedBcmrIdentity {
    network: String,
    source: SourceId,
    route: Hash32,
    /// Historical provenance only; never used as the live tip.
    tip: (u32, Hash32),
    /// Authbase through head, in internal transaction-hash order. Keeping raw
    /// links makes the category binding checkable without ancestor network I/O.
    chain: Vec<Vec<u8>>,
    registry: Option<CachedRegistry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CachedRegistry {
    contents: Vec<u8>,
    source_uri: String,
}

impl std::fmt::Debug for BcmrIdentityCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BcmrIdentityCache(<stale wallet-private hints>)")
    }
}

fn route_binding(route: &CapabilityRoute) -> Option<Hash32> {
    let endpoint = route.endpoint.as_ref()?;
    // This is an equality discriminator, not evidence. A future change to a
    // protocol's Debug spelling safely causes a cold walk. Length-prefix the
    // only free-form field so endpoint changes cannot alias another route.
    let binding = format!(
        "{:?}:{:?}:{}:{}:{:?}",
        route.protocol,
        endpoint.kind,
        endpoint.host.len(),
        endpoint.host,
        endpoint.port
    );
    Some(optn_core::header_hash::sha256d(binding.as_bytes()))
}

impl CachedBcmrIdentity {
    fn size_bytes(&self) -> usize {
        self.chain
            .iter()
            .fold(0usize, |n, raw| n.saturating_add(raw.len()))
            .saturating_add(self.network.len())
            .saturating_add(self.source.as_str().len())
            .saturating_add(self.registry.as_ref().map_or(0, |registry| {
                registry
                    .contents
                    .len()
                    .saturating_add(registry.source_uri.len())
            }))
    }

    fn resume(&self, category: [u8; 32]) -> Option<AuthchainResolution> {
        if self.chain.is_empty() || self.chain.len() > MAX_AUTHCHAIN_HOPS as usize {
            return None;
        }
        let mut walk = AuthchainResolution::for_token_category(category, identity_budget());
        let mut seen = BTreeSet::new();
        let mut head_outputs = Vec::new();
        for (index, raw) in self.chain.iter().enumerate() {
            let txid = optn_core::header_hash::sha256d(raw);
            if !seen.insert(txid) {
                return None;
            }
            let decoded = optn_core::tx::decode(raw).ok()?;
            if decoded.outputs.is_empty() {
                return None;
            }
            let transaction = ChainTransaction {
                txid,
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
                // Cached inclusion height is not live inclusion evidence.
                block_height: None,
            };
            if index == 0 {
                if txid != walk.current() {
                    return None;
                }
                walk.inspect(&transaction);
            } else if !matches!(
                walk.accept(authchain::IdentityStatus::SpentBy(transaction.clone())),
                AuthchainStep::Query { txid: next } if next == txid
            ) {
                return None;
            }
            // Burned identities cannot have successors or terminal UTXOs.
            if !matches!(
                optn_core::bcmr::identity_output_state(
                    transaction.outputs.first().map(Vec::as_slice)
                ),
                optn_core::bcmr::IdentityOutputState::Live
            ) {
                return None;
            }
            head_outputs = transaction.outputs;
        }
        if let Some(registry) = &self.registry {
            let publication = publication_in(head_outputs.iter().map(Vec::as_slice))?;
            if !publication.matches(&registry.contents) {
                return None;
            }
        }
        // No accept(Unspent) call occurs here: local restoration can only ask
        // for the cached head, never return Resolved.
        Some(walk)
    }
}

impl BcmrIdentityCache {
    pub(crate) fn validate(&self, network: Network) -> Result<(), String> {
        if self.0.len() > MAX_IDENTITY_CATEGORIES
            || self
                .0
                .values()
                .fold(0usize, |n, entry| n.saturating_add(entry.size_bytes()))
                > FetchLimits::default().max_bytes
        {
            return Err("BCMR restart cache exceeds the metadata budget".into());
        }
        for (category, entry) in &self.0 {
            let bytes = parse_category_key(category).ok_or("invalid BCMR restart category")?;
            if entry.network != network.to_string()
                || entry.source.as_str().is_empty()
                || entry.source.as_str().len() > 256
                || entry.resume(bytes).is_none()
            {
                return Err("invalid BCMR restart chain or registry".into());
            }
        }
        Ok(())
    }

    fn insert_bounded(&mut self, category: [u8; 32], entry: CachedBcmrIdentity) {
        // Replacement must discard a superseded publication even if the new
        // record cannot fit. It must not double-count the previous record.
        self.0.remove(&category_hex(&category));
        let size = self.0.values().fold(entry.size_bytes(), |n, old| {
            n.saturating_add(old.size_bytes())
        });
        if self.0.len() < MAX_IDENTITY_CATEGORIES && size <= FetchLimits::default().max_bytes {
            self.0.insert(category_hex(&category), entry);
        }
    }
}

/// The caller supplies the accepted live snapshot's network/tip and one clock
/// for the whole refresh. A missing tip cannot revalidate a restart hint.
pub(crate) struct IdentityResolutionContext<'a> {
    pub network: Network,
    pub tip: Option<(u32, Hash32)>,
    pub now_unix_ms: Option<i64>,
    pub cache: &'a BcmrIdentityCache,
}

pub(crate) struct SelectedIdentityResolution {
    pub identities: BTreeMap<[u8; 32], OwnedCategoryIdentity>,
    pub cache: BcmrIdentityCache,
    now_unix_ms: Option<i64>,
}

impl SelectedIdentityResolution {
    /// Reparse hash-checked registry bytes at the supplied refresh clock. No
    /// cached TokenIdentity or previously chosen snapshot is reused.
    pub(crate) fn apply(&self, app: &mut AppState) {
        apply_owned_token_identities_at(app, &self.identities, self.now_unix_ms);
    }
}

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

fn parse_category_key(category: &str) -> Option<[u8; 32]> {
    if category.len() != 64
        || !category
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
    {
        return None;
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&category[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

fn transient_chain_failure(error: &crate::chain_service::ChainServiceError) -> bool {
    use crate::chain_service::{ChainBackendError, ChainServiceError};
    match error {
        ChainServiceError::NoEligibleProvider | ChainServiceError::RouteUnavailable => true,
        ChainServiceError::Exhausted { attempts } => attempts.iter().all(|attempt| {
            matches!(
                attempt.error,
                ChainBackendError::Timeout | ChainBackendError::Offline
            )
        }),
    }
}

/// One checked wall-clock reading for identity resolution and projection.
/// Missing or unrepresentable time must never select a current snapshot.
pub(crate) fn checked_unix_ms() -> Option<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
}

/// Turn resolved metadata into the observation the application accepts.
///
/// Renderers never call this. The hash check already happened in [`resolve`];
/// this only names the category and marks how far the identity got.
pub fn observe_identity(category: [u8; 32], metadata: IdentityMetadata) -> AppAction {
    observe_identity_at(category, metadata, checked_unix_ms())
}

fn observe_identity_at(
    category: [u8; 32],
    metadata: IdentityMetadata,
    now_unix_ms: Option<i64>,
) -> AppAction {
    let category_hex = category_hex(&category);
    let parsed = now_unix_ms.and_then(|now| {
        metadata
            .verified_contents()
            .and_then(|bytes| optn_core::bcmr::names_for_category(bytes, &category_hex, now))
    });
    let identity = match (&metadata, parsed) {
        (IdentityMetadata::Current { .. }, Some(names)) => TokenIdentity {
            name: names.name,
            ticker: names.ticker,
            decimals: names.decimals,
            status: IdentityStatus::Verified,
            presentation: names.presentation,
        },
        (IdentityMetadata::LastKnown { .. }, Some(names)) => TokenIdentity {
            name: names.name,
            ticker: names.ticker,
            decimals: names.decimals,
            status: IdentityStatus::Stale,
            presentation: names.presentation,
        },
        (IdentityMetadata::Unpublished, _) => TokenIdentity {
            name: category_hex.clone(),
            ticker: None,
            decimals: 0,
            status: IdentityStatus::Unpublished,
            presentation: Default::default(),
        },
        (IdentityMetadata::Unresolved { .. }, _) | (_, None) => TokenIdentity {
            name: category_hex.clone(),
            ticker: None,
            decimals: 0,
            status: IdentityStatus::Unresolved,
            presentation: Default::default(),
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
/// history or a permitted spender-discovery route may nominate a successor,
/// but the selected validating node must supply its bytes and explicitly
/// establish the terminal output's unspent status.
#[cfg(test)]
pub(crate) async fn resolve_selected_identities(
    service: &mut crate::chain_service::ChainService,
    categories: BTreeSet<[u8; 32]>,
    transactions: &[ObservedTransaction],
) -> BTreeMap<[u8; 32], OwnedCategoryIdentity> {
    resolve_selected_identities_inner(service, categories, transactions, None)
        .await
        .identities
}

/// Resume only from locally checked hints bound to this network and exact
/// selected source/endpoint. Every successful result still needs current
/// full-node evidence; the stored tip and registry never supply that evidence.
pub(crate) async fn resolve_selected_identities_with_cache(
    service: &mut crate::chain_service::ChainService,
    categories: BTreeSet<[u8; 32]>,
    transactions: &[ObservedTransaction],
    context: IdentityResolutionContext<'_>,
) -> SelectedIdentityResolution {
    resolve_selected_identities_inner(service, categories, transactions, Some(context)).await
}

async fn resolve_selected_identities_inner(
    service: &mut crate::chain_service::ChainService,
    categories: BTreeSet<[u8; 32]>,
    transactions: &[ObservedTransaction],
    context: Option<IdentityResolutionContext<'_>>,
) -> SelectedIdentityResolution {
    use crate::chain_service::{ChainOperation, ChainPayload, ChainRequest, OutpointSpentness};
    let source_lifetime = service.revocation();
    let cache_valid = !source_lifetime.is_revoked()
        && context
            .as_ref()
            .is_some_and(|context| context.cache.validate(context.network).is_ok());
    let mut result = SelectedIdentityResolution {
        identities: BTreeMap::new(),
        // Incomplete work can retain hints, never identity observations. Keep
        // only locally valid, network-bound records for still-owned categories.
        cache: context.as_ref().filter(|_| cache_valid).map_or_else(
            BcmrIdentityCache::default,
            |context| {
                BcmrIdentityCache(
                    context
                        .cache
                        .0
                        .iter()
                        .filter(|(key, _)| {
                            parse_category_key(key)
                                .is_some_and(|category| categories.contains(&category))
                        })
                        .map(|(key, entry)| (key.clone(), entry.clone()))
                        .collect(),
                )
            },
        ),
        now_unix_ms: context.as_ref().and_then(|context| context.now_unix_ms),
    };
    if context
        .as_ref()
        .is_some_and(|context| context.tip.is_none())
    {
        return result;
    }
    let tip_matches = |observed: Option<(u32, Hash32)>| {
        context
            .as_ref()
            .is_none_or(|context| observed.is_none() || observed == context.tip)
    };
    let collection =
        IdentityCollection::from_observed(transactions, vec![], Evidence::ServerAssertion);
    let fetcher = service.registry_fetcher();
    let mut bytes_left = FetchLimits::default().max_bytes;
    // Bound optional metadata work for a refresh. Unfinished categories remain
    // unresolved without withholding the wallet's accepted coins or history.
    let work = async {
        for category in categories.into_iter().take(MAX_IDENTITY_CATEGORIES) {
            let category_key = category_hex(&category);
            let mut identity = OwnedCategoryIdentity::Unresolved;
            for route in service.routes_for_operation(ChainOperation::OutpointSpentness) {
                let Some(transaction_route) =
                    service.matching_route_for_operation(&route, ChainOperation::TransactionLookup)
                else {
                    continue;
                };
                let hint = context
                    .as_ref()
                    .filter(|_| cache_valid)
                    .and_then(|context| context.cache.0.get(&category_key))
                    .filter(|hint| {
                        hint.source == route.source && Some(hint.route) == route_binding(&route)
                    });
                let mut walk = hint
                    .and_then(|hint| hint.resume(category))
                    .unwrap_or_else(|| {
                        AuthchainResolution::for_token_category(category, identity_budget())
                    });
                let mut path = context
                    .as_ref()
                    .map(|_| hint.map_or_else(Vec::new, |hint| hint.chain.clone()));
                let mut path_bytes = path
                    .as_ref()
                    .map_or(0, |path| path.iter().map(Vec::len).sum::<usize>());
                let mut seen = hint.map_or_else(BTreeSet::new, |hint| {
                    hint.chain
                        .iter()
                        .take(hint.chain.len().saturating_sub(1))
                        .map(|raw| optn_core::header_hash::sha256d(raw))
                        .collect()
                });
                let mut step = walk.next_step();
                while let AuthchainStep::Query { txid } = step {
                    if !seen.insert(txid) {
                        result.cache.0.remove(&category_key);
                        break;
                    }
                    let observed = match service
                        .execute_on_route(
                            &transaction_route,
                            &ChainRequest::TransactionLookup { txid },
                        )
                        .await
                    {
                        Ok(observed) => observed,
                        Err(error) => {
                            if !transient_chain_failure(&error) {
                                result.cache.0.remove(&category_key);
                            }
                            break;
                        }
                    };
                    if observed.source != route.source
                        || !tip_matches(observed.chain_tip)
                        || !matches!(&observed.evidence, Evidence::FullNodeValidated { source } if source == &route.source)
                    {
                        result.cache.0.remove(&category_key);
                        break;
                    }
                    let ChainPayload::Transaction(transaction) = observed.value else {
                        result.cache.0.remove(&category_key);
                        break;
                    };
                    let Ok(decoded) = optn_core::tx::decode(&transaction.raw) else {
                        result.cache.0.remove(&category_key);
                        break;
                    };
                    if transaction.txid != txid
                        || optn_core::header_hash::sha256d(&transaction.raw) != txid
                    {
                        result.cache.0.remove(&category_key);
                        break;
                    }
                    if let Some(chain) = path.as_mut() {
                        if chain
                            .last()
                            .is_none_or(|raw| optn_core::header_hash::sha256d(raw) != txid)
                        {
                            path_bytes = path_bytes.saturating_add(transaction.raw.len());
                            if path_bytes <= FetchLimits::default().max_bytes {
                                chain.push(transaction.raw.clone());
                            } else {
                                // An oversize ancestry disables persistence, never
                                // expands the restart budget or grants authority.
                                path = None;
                            }
                        }
                    }
                    let current = IdentityCollection::from_observed(
                        &[transaction],
                        vec![],
                        observed.evidence,
                    );
                    let Some(current) = current.transactions.first() else {
                        result.cache.0.remove(&category_key);
                        break;
                    };
                    walk.inspect(current);
                    if matches!(
                        optn_core::bcmr::identity_output_state(
                            current.outputs.first().map(Vec::as_slice)
                        ),
                        optn_core::bcmr::IdentityOutputState::Burned
                    ) {
                        result.cache.0.remove(&category_key);
                        identity = OwnedCategoryIdentity::Unpublished;
                        break;
                    }
                    let mut successors = collection
                        .transactions
                        .iter()
                        .filter(|candidate| candidate.inputs.contains(&(txid, 0)));
                    if let Some(successor) = successors.next() {
                        if successors.next().is_some() {
                            result.cache.0.remove(&category_key);
                            break;
                        }
                        step = walk.accept(authchain::IdentityStatus::SpentBy(successor.clone()));
                        continue;
                    }
                    let unspent = match service
                        .execute_on_route(
                            &route,
                            &ChainRequest::OutpointSpentness { txid, vout: 0 },
                        )
                        .await
                    {
                        Ok(unspent) => unspent,
                        Err(error) => {
                            if !transient_chain_failure(&error) {
                                result.cache.0.remove(&category_key);
                            }
                            break;
                        }
                    };
                    if unspent.source != route.source
                        || !tip_matches(unspent.chain_tip)
                        || !matches!(&unspent.evidence, Evidence::FullNodeValidated { source } if source == &route.source)
                    {
                        result.cache.0.remove(&category_key);
                        break;
                    }
                    let ChainPayload::OutpointSpentness(OutpointSpentness::Unspent {
                        value_sats,
                        script_pubkey,
                        best_block,
                        txid: output_txid,
                        vout,
                    }) = unspent.value
                    else {
                        // An absent UTXO is not a terminal authhead. Discovery may
                        // nominate the exact spender, including outside this wallet's
                        // history. It must then be fetched from the validating node
                        // on the next iteration, before any of its claims are used.
                        let Some(output) = decoded.outputs.first() else {
                            result.cache.0.remove(&category_key);
                            break;
                        };
                        let mut discovered_successor: Option<ChainTransaction> = None;
                        let mut ambiguous = false;
                        for discovery in
                            service.routes_for_operation(ChainOperation::OutpointSpender)
                        {
                            let Ok(candidate) = service
                                .execute_on_route(
                                    &discovery,
                                    &ChainRequest::OutpointSpender {
                                        txid,
                                        vout: 0,
                                        script_pubkey: output.script_pubkey.clone(),
                                        from_height: current.block_height,
                                    },
                                )
                                .await
                            else {
                                continue;
                            };
                            let ChainPayload::OutpointSpender {
                                spender: Some(spender),
                                ..
                            } = candidate.value
                            else {
                                continue;
                            };
                            let discovered = IdentityCollection::from_observed(
                                &[spender],
                                vec![],
                                candidate.evidence,
                            );
                            if let Some(successor) = discovered.transactions.first() {
                                if discovered_successor
                                    .as_ref()
                                    .is_some_and(|previous| previous.txid != successor.txid)
                                {
                                    ambiguous = true;
                                    break;
                                }
                                discovered_successor = Some(successor.clone());
                            }
                        }
                        if ambiguous {
                            result.cache.0.remove(&category_key);
                            break;
                        }
                        if let Some(successor) = discovered_successor {
                            step = walk.accept(authchain::IdentityStatus::SpentBy(successor));
                        }
                        if matches!(step, AuthchainStep::Query { txid: next } if next != txid) {
                            continue;
                        }
                        break;
                    };
                    if output_txid != txid
                        || vout != 0
                        || context.as_ref().is_some_and(|context| {
                            context.tip.map(|(_, hash)| hash) != Some(best_block)
                        })
                        || !decoded.outputs.first().is_some_and(|output| {
                            output.value == value_sats && output.script_pubkey == script_pubkey
                        })
                    {
                        result.cache.0.remove(&category_key);
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
                    if let Some(publication) =
                        publication_in(head.outputs.iter().map(Vec::as_slice))
                    {
                        // Reuse committed bytes only after the current head and
                        // terminal output passed the same live gates as a cold
                        // walk. The registry is reparsed by apply() at this run's
                        // clock, including future snapshots and token withdrawal.
                        if let Some(registry) =
                            hint.and_then(|hint| hint.registry.as_ref())
                                .filter(|registry| {
                                    publication.matches(&registry.contents)
                                        && registry.contents.len() <= bytes_left
                                })
                        {
                            bytes_left -= registry.contents.len();
                            resolved
                                .fetch_attempts
                                .push((registry.source_uri.clone(), Ok(registry.contents.clone())));
                        } else if let Some(fetcher) = fetcher.as_ref() {
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
                    result.cache.0.remove(&category_key);
                    if let (Some(context), Some(chain), Some(binding)) =
                        (context.as_ref(), path, route_binding(&route))
                    {
                        if let Some(tip) = context.tip {
                            let registry = match &identity {
                                OwnedCategoryIdentity::Observed {
                                    publication,
                                    attempts,
                                } => attempts.iter().find_map(|(uri, attempt)| {
                                    attempt
                                        .as_ref()
                                        .ok()
                                        .filter(|contents| publication.matches(contents))
                                        .map(|contents| CachedRegistry {
                                            contents: contents.clone(),
                                            source_uri: uri.clone(),
                                        })
                                }),
                                _ => None,
                            };
                            result.cache.insert_bounded(
                                category,
                                CachedBcmrIdentity {
                                    network: context.network.to_string(),
                                    source: route.source.clone(),
                                    route: binding,
                                    tip,
                                    chain,
                                    registry,
                                },
                            );
                        }
                    }
                    break;
                }
                if matches!(identity, OwnedCategoryIdentity::Unpublished) {
                    break;
                }
            }
            result.identities.insert(category, identity);
        }
    };
    tokio::select! {
        biased;
        _ = source_lifetime.cancelled() => {},
        _ = tokio::time::timeout(FetchLimits::default().deadline, work) => {},
    }
    if source_lifetime.is_revoked() {
        // A cancelled source lease invalidates completed categories too.
        result.identities.clear();
        result.cache = BcmrIdentityCache::default();
    }
    result
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
    let mut walk = AuthchainResolution::for_token_category(category, AuthchainBudget::default());
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
    apply_owned_token_identities_at(app, observations, checked_unix_ms());
}

pub(crate) fn apply_owned_token_identities_at(
    app: &mut AppState,
    observations: &BTreeMap<[u8; 32], OwnedCategoryIdentity>,
    now_unix_ms: Option<i64>,
) {
    for category in owned_token_categories(app) {
        let metadata = match observations.get(&category) {
            Some(OwnedCategoryIdentity::Observed {
                publication,
                attempts,
            }) => resolve(publication, attempts),
            Some(OwnedCategoryIdentity::Unpublished) => IdentityMetadata::Unpublished,
            Some(OwnedCategoryIdentity::Unresolved) | None => IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AuthchainIncomplete,
            },
        };
        // Fresh authenticated bytes supersede cached claims, including token
        // removal or an invalid current snapshot. Neither may revive old data.
        let allow_cached = !metadata.is_current();
        let mut action = observe_identity_at(category, metadata, now_unix_ms);
        if let AppAction::SetTokenIdentity {
            category_hex,
            identity,
        } = &mut action
        {
            if allow_cached && identity.status == IdentityStatus::Unresolved {
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
pub(crate) mod tests {
    use super::*;
    use crate::chain::{
        Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, ChainSource,
        ConnectionPolicy, Endpoint, EndpointKind, ProtocolFamily, ProviderHealth, SourceCatalog,
        SourceDisposition, SourceOrigin,
    };
    use crate::chain_service::{
        BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation,
        ChainPayload, ChainRequest, ChainService, OutpointSpentness,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    const CACHE_TIP: (u32, Hash32) = (100, [7; 32]);
    const CACHE_CLOCK: i64 = 1_700_000_000_000;

    struct CacheBackend {
        source: SourceId,
        endpoint: Endpoint,
        capabilities: CapabilitySet,
        transactions: Vec<ObservedTransaction>,
        terminal: Option<OutpointSpentness>,
        terminal_evidence: Evidence,
        raw_tip: Option<(u32, Hash32)>,
        failure: Option<ChainBackendError>,
        requests: Arc<Mutex<Vec<ChainRequest>>>,
    }

    impl ChainBackend for CacheBackend {
        fn source_id(&self) -> &SourceId {
            &self.source
        }
        fn protocol(&self) -> ProtocolFamily {
            ProtocolFamily::BchnRpc
        }
        fn endpoint(&self) -> Option<&Endpoint> {
            Some(&self.endpoint)
        }
        fn capabilities(&self) -> &CapabilitySet {
            &self.capabilities
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }
        fn supports(&self, operation: ChainOperation) -> bool {
            matches!(
                operation,
                ChainOperation::TransactionLookup
                    | ChainOperation::OutpointSpentness
                    | ChainOperation::OutpointSpender
            )
        }
        fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(request.clone());
                if let Some(error) = &self.failure {
                    return Err(error.clone());
                }
                let (payload, evidence, chain_tip) = match request {
                    ChainRequest::TransactionLookup { txid } => (
                        ChainPayload::Transaction(self.transactions.iter().find(|tx| tx.txid == *txid).cloned().ok_or(ChainBackendError::Unsupported)?),
                        Evidence::FullNodeValidated { source: self.source.clone() },
                        self.raw_tip,
                    ),
                    ChainRequest::OutpointSpentness { txid, vout } => (
                        ChainPayload::OutpointSpentness(self.terminal.as_ref().filter(|terminal| {
                            matches!(terminal, OutpointSpentness::Unspent { txid: head, vout: index, .. } if head == txid && index == vout)
                        }).cloned().unwrap_or(OutpointSpentness::Unknown { txid: *txid, vout: *vout })),
                        self.terminal_evidence.clone(), None,
                    ),
                    ChainRequest::OutpointSpender { txid, vout, .. } => (
                        ChainPayload::OutpointSpender {
                            txid: *txid, vout: *vout,
                            spender: self.transactions.iter().find(|tx| {
                                optn_core::tx::decode(&tx.raw).unwrap().inputs.iter().any(|(parent, index, _)| parent == txid && index == vout)
                            }).cloned(),
                        }, Evidence::ServerAssertion, None,
                    ),
                    _ => return Err(ChainBackendError::Unsupported),
                };
                Ok(BackendObservation {
                    payload,
                    evidence,
                    chain_tip,
                })
            })
        }
    }

    struct CacheFetcher {
        body: Vec<u8>,
        calls: Arc<AtomicUsize>,
        revoke: Option<crate::chain_service::ChainRevocation>,
    }
    impl RegistryFetcher for CacheFetcher {
        fn fetch<'a>(
            &'a self,
            _: &'a str,
            limits: FetchLimits,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FetchAttempt> + Send + 'a>>
        {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                if let Some(lifetime) = &self.revoke {
                    lifetime.revoke();
                }
                if self.body.len() > limits.max_bytes {
                    Err(FetchError::TooLarge {
                        limit: limits.max_bytes,
                    })
                } else {
                    Ok(self.body.clone())
                }
            })
        }
    }

    fn cache_transaction(parent: Option<Hash32>, body: Option<&[u8]>) -> ObservedTransaction {
        let mut raw = vec![2, 0, 0, 0, u8::from(parent.is_some())];
        if let Some(parent) = parent {
            raw.extend_from_slice(&parent);
            raw.extend_from_slice(&0u32.to_le_bytes());
            raw.push(0);
            raw.extend_from_slice(&u32::MAX.to_le_bytes());
        }
        let mut outputs = vec![(546u64, p2pkh())];
        if let Some(body) = body {
            outputs.push((0, publication_script(body, "example.test")));
        }
        raw.push(outputs.len() as u8);
        for (value, script) in outputs {
            raw.extend_from_slice(&value.to_le_bytes());
            raw.extend_from_slice(&optn_core::tx::varint(script.len() as u64));
            raw.extend_from_slice(&script);
        }
        raw.extend_from_slice(&0u32.to_le_bytes());
        ObservedTransaction {
            txid: optn_core::header_hash::sha256d(&raw),
            raw,
            block_height: Some(90),
        }
    }

    fn cache_fixture() -> ([u8; 32], ObservedTransaction, ObservedTransaction, Vec<u8>) {
        let base = cache_transaction(None, None);
        let mut category = base.txid;
        category.reverse();
        let body = registry_body("Cached", category);
        let head = cache_transaction(Some(base.txid), Some(&body));
        (category, base, head, body)
    }

    fn cache_backend(
        transactions: Vec<ObservedTransaction>,
        terminal: Option<Hash32>,
    ) -> CacheBackend {
        let source = SourceId::new("cache-node");
        let mut capabilities = CapabilitySet::default();
        for capability in [
            Capability::TransactionQuery,
            Capability::OutpointUnspentLookup,
            Capability::OutpointSpenderLookup,
        ] {
            capabilities.record(
                capability,
                CapabilityConfidence::Verified,
                CapabilityDiscovery::ActiveProbe,
            );
        }
        CacheBackend {
            terminal: terminal.map(|txid| OutpointSpentness::Unspent {
                txid,
                vout: 0,
                value_sats: 546,
                script_pubkey: p2pkh(),
                best_block: CACHE_TIP.1,
            }),
            terminal_evidence: Evidence::FullNodeValidated {
                source: source.clone(),
            },
            source,
            endpoint: Endpoint {
                kind: EndpointKind::BchnRpc,
                host: "fixture.invalid".into(),
                port: Some(1234),
            },
            capabilities,
            transactions,
            raw_tip: Some(CACHE_TIP),
            failure: None,
            requests: Arc::new(Mutex::new(vec![])),
        }
    }

    fn cache_service(
        backend: CacheBackend,
        body: Option<Vec<u8>>,
    ) -> (
        ChainService,
        Arc<Mutex<Vec<ChainRequest>>>,
        Arc<AtomicUsize>,
    ) {
        let requests = backend.requests.clone();
        let fetches = Arc::new(AtomicUsize::new(0));
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: backend.source.clone(),
                label: "cache test".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![backend.endpoint.clone()],
                capabilities: Default::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let mut service = ChainService::new(
            catalog,
            ConnectionPolicy::exact(backend.source.clone(), ProtocolFamily::BchnRpc),
        );
        service.register(Arc::new(backend));
        if let Some(body) = body {
            service.set_registry_fetcher(Arc::new(CacheFetcher {
                body,
                calls: fetches.clone(),
                revoke: None,
            }));
        }
        (service, requests, fetches)
    }

    async fn run_cached(
        service: &mut ChainService,
        category: [u8; 32],
        cache: &BcmrIdentityCache,
        now: Option<i64>,
    ) -> SelectedIdentityResolution {
        resolve_selected_identities_with_cache(
            service,
            BTreeSet::from([category]),
            &[],
            IdentityResolutionContext {
                network: Network::Chipnet,
                tip: Some(CACHE_TIP),
                now_unix_ms: now,
                cache,
            },
        )
        .await
    }

    fn projected_identity(
        result: &SelectedIdentityResolution,
        category: [u8; 32],
    ) -> TokenIdentity {
        let mut app = wallet_with(vec![coin(
            1,
            1000,
            Some(optn_core::token::TokenData::fungible(category, 1)),
        )]);
        result.apply(&mut app);
        app.token_identities[&category_hex(&category)].clone()
    }

    /// Shared only with the checkpoint codec test: the cache is produced by a
    /// real resolver run against deterministic in-memory transports.
    pub(crate) async fn resolved_cache_fixture() -> ([u8; 32], BcmrIdentityCache) {
        let (category, base, head, body) = cache_fixture();
        let (mut service, _, _) = cache_service(
            cache_backend(vec![base, head.clone()], Some(head.txid)),
            Some(body),
        );
        let resolved = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        assert_eq!(
            projected_identity(&resolved, category).status,
            IdentityStatus::Verified
        );
        assert_eq!(resolved.cache.0.len(), 1);
        (category, resolved.cache)
    }

    #[tokio::test]
    async fn cached_head_revalidates_without_ancestor_requests_or_registry_refetch() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        let (mut cold_service, _, _) =
            cache_service(cache_backend(vec![head.clone()], Some(head.txid)), None);
        let cold =
            resolve_selected_identities(&mut cold_service, BTreeSet::from([category]), &[]).await;
        assert_eq!(cold[&category], OwnedCategoryIdentity::Unresolved);
        assert_eq!(
            revalidate_cache_fixture(&cache).await.status,
            IdentityStatus::Verified
        );
    }

    pub(crate) async fn revalidate_cache_fixture(cache: &BcmrIdentityCache) -> TokenIdentity {
        let (category, _, head, _) = cache_fixture();
        // The backend deliberately has no authbase and no registry transport.
        let (mut service, requests, fetches) =
            cache_service(cache_backend(vec![head.clone()], Some(head.txid)), None);
        let resolved = run_cached(&mut service, category, cache, Some(CACHE_CLOCK)).await;
        assert_eq!(
            *requests.lock().unwrap(),
            vec![
                ChainRequest::TransactionLookup { txid: head.txid },
                ChainRequest::OutpointSpentness {
                    txid: head.txid,
                    vout: 0
                },
            ]
        );
        assert_eq!(fetches.load(Ordering::SeqCst), 0);
        resolved.cache.validate(Network::Chipnet).unwrap();
        projected_identity(&resolved, category)
    }

    #[tokio::test]
    async fn reorg_requires_new_terminal_evidence_and_a_removed_head_cannot_survive() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, base, head, _) = cache_fixture();
        let new_tip = (99, [8; 32]);
        // A retained head can be reused at a different tip only when the live
        // node revalidates it at that exact new tip.
        let mut backend = cache_backend(vec![head.clone()], Some(head.txid));
        backend.raw_tip = Some(new_tip);
        if let Some(OutpointSpentness::Unspent { best_block, .. }) = backend.terminal.as_mut() {
            *best_block = new_tip.1;
        }
        let (mut service, requests, _) = cache_service(backend, None);
        let retained = resolve_selected_identities_with_cache(
            &mut service,
            BTreeSet::from([category]),
            &[],
            IdentityResolutionContext {
                network: Network::Chipnet,
                tip: Some(new_tip),
                now_unix_ms: Some(CACHE_CLOCK),
                cache: &cache,
            },
        )
        .await;
        assert_eq!(
            projected_identity(&retained, category).status,
            IdentityStatus::Verified
        );
        assert_eq!(retained.cache.0[&category_hex(&category)].tip, new_tip);
        assert_eq!(requests.lock().unwrap().len(), 2);

        // Roll back to a different successor: the missing old head may not
        // restore its registry. Discard its hint; once the failed route is
        // eligible again, walk from the authbase to authenticate its replacement.
        let replacement_body = registry_body("Replacement", category);
        let replacement = cache_transaction(Some(base.txid), Some(&replacement_body));
        let (mut service, _, fetches) = cache_service(
            cache_backend(
                vec![base.clone(), replacement.clone()],
                Some(replacement.txid),
            ),
            Some(replacement_body.clone()),
        );
        let removed = run_cached(&mut service, category, &cache, Some(CACHE_CLOCK)).await;
        assert_eq!(
            projected_identity(&removed, category).status,
            IdentityStatus::Unresolved
        );
        assert!(removed.cache.0.is_empty());
        assert_eq!(fetches.load(Ordering::SeqCst), 0);
        let (mut service, requests, fetches) = cache_service(
            cache_backend(
                vec![base.clone(), replacement.clone()],
                Some(replacement.txid),
            ),
            Some(replacement_body),
        );
        let recovered = run_cached(&mut service, category, &removed.cache, Some(CACHE_CLOCK)).await;
        assert_eq!(projected_identity(&recovered, category).name, "Replacement");
        assert_eq!(
            projected_identity(&recovered, category).status,
            IdentityStatus::Verified
        );
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        assert_eq!(
            requests.lock().unwrap()[0],
            ChainRequest::TransactionLookup { txid: base.txid }
        );
    }

    #[tokio::test]
    async fn revocation_during_refetch_discards_revalidated_head_and_cached_registry() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        let body = registry_body("Advanced", category);
        let next = cache_transaction(Some(head.txid), Some(&body));
        let (mut service, _, calls) = cache_service(
            cache_backend(vec![head, next.clone()], Some(next.txid)),
            None,
        );
        service.set_registry_fetcher(Arc::new(CacheFetcher {
            body,
            calls: calls.clone(),
            revoke: Some(service.revocation()),
        }));
        let resolved = run_cached(&mut service, category, &cache, Some(CACHE_CLOCK)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(resolved.identities.is_empty());
        assert!(resolved.cache.0.is_empty());
        assert_eq!(
            projected_identity(&resolved, category).status,
            IdentityStatus::Unresolved
        );
    }

    #[tokio::test]
    async fn cached_registry_is_reparsed_at_current_clock_including_withdrawal() {
        let (category, base, _, _) = cache_fixture();
        let key = category_hex(&category);
        let body = serde_json::to_vec(&serde_json::json!({"identities": {&key: {
            "2023-11-14T22:13:20.000Z": {"name": "Old", "token": {"category": &key}},
            "2023-11-14T22:13:20.001Z": {"name": "New", "token": {"category": &key}},
            "2023-11-14T22:13:20.002Z": {"name": "Withdrawn"}
        }}}))
        .unwrap();
        let head = cache_transaction(Some(base.txid), Some(&body));
        let (mut service, _, fetches) = cache_service(
            cache_backend(vec![base, head.clone()], Some(head.txid)),
            Some(body),
        );
        let first = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        assert_eq!(projected_identity(&first, category).name, "Old");
        for (clock, expected, status) in [
            (Some(CACHE_CLOCK + 1), "New", IdentityStatus::Verified),
            (
                Some(CACHE_CLOCK + 2),
                key.as_str(),
                IdentityStatus::Unresolved,
            ),
            (None, key.as_str(), IdentityStatus::Unresolved),
        ] {
            let next = run_cached(&mut service, category, &first.cache, clock).await;
            let mut app = wallet_with(vec![coin(
                1,
                1000,
                Some(optn_core::token::TokenData::fungible(category, 1)),
            )]);
            first.apply(&mut app);
            next.apply(&mut app);
            assert_eq!(app.token_identities[&key].name, expected);
            assert_eq!(app.token_identities[&key].status, status);
        }
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn spent_cached_head_continues_to_advanced_or_withdrawn_publication() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        let next_body = registry_body("Advanced", category);
        for publishes in [true, false] {
            let successor =
                cache_transaction(Some(head.txid), publishes.then_some(next_body.as_slice()));
            let (mut service, requests, fetches) = cache_service(
                cache_backend(vec![head.clone(), successor.clone()], Some(successor.txid)),
                Some(next_body.clone()),
            );
            let resolved = run_cached(&mut service, category, &cache, Some(CACHE_CLOCK)).await;
            let identity = projected_identity(&resolved, category);
            assert_eq!(
                identity.status,
                if publishes {
                    IdentityStatus::Verified
                } else {
                    IdentityStatus::Unpublished
                }
            );
            if publishes {
                assert_eq!(identity.name, "Advanced");
            }
            assert_eq!(fetches.load(Ordering::SeqCst), usize::from(publishes));
            let entry = &resolved.cache.0[&category_hex(&category)];
            assert_eq!(entry.chain.len(), 3);
            assert_eq!(entry.registry.is_some(), publishes);
            assert!(requests.lock().unwrap().iter().any(|request| matches!(request, ChainRequest::OutpointSpender { txid, vout: 0, .. } if *txid == head.txid)));
            resolved.cache.validate(Network::Chipnet).unwrap();
        }
    }

    #[tokio::test]
    async fn cache_never_replaces_terminal_full_node_source_output_or_tip_evidence() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        for case in 0..8 {
            let mut backend = cache_backend(vec![head.clone()], Some(head.txid));
            match case {
                0 => backend.terminal = None,
                1 => backend.terminal_evidence = Evidence::ServerAssertion,
                2 => {
                    backend.terminal_evidence = Evidence::MerkleTransactionIncluded {
                        txid: head.txid,
                        block_hash: CACHE_TIP.1,
                        height: 90,
                    }
                }
                3 => {
                    backend.terminal_evidence = Evidence::FullNodeValidated {
                        source: "other-node".into(),
                    }
                }
                4 => {
                    if let Some(OutpointSpentness::Unspent { value_sats, .. }) =
                        backend.terminal.as_mut()
                    {
                        *value_sats += 1;
                    }
                }
                5 => {
                    if let Some(OutpointSpentness::Unspent { script_pubkey, .. }) =
                        backend.terminal.as_mut()
                    {
                        script_pubkey.push(0);
                    }
                }
                6 => {
                    if let Some(OutpointSpentness::Unspent { best_block, .. }) =
                        backend.terminal.as_mut()
                    {
                        *best_block = [8; 32];
                    }
                }
                7 => backend.raw_tip = Some((100, [8; 32])),
                _ => unreachable!(),
            }
            let (mut service, _, fetches) = cache_service(backend, None);
            let resolved = run_cached(&mut service, category, &cache, Some(CACHE_CLOCK)).await;
            assert_eq!(
                projected_identity(&resolved, category).status,
                IdentityStatus::Unresolved,
                "case {case}"
            );
            assert_eq!(resolved.cache.0.is_empty(), case != 0, "case {case}");
            assert_eq!(fetches.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn changed_source_endpoint_or_network_cannot_use_restart_shortcut() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, base, head, body) = cache_fixture();
        for case in 0..3 {
            let mut backend = cache_backend(vec![base.clone(), head.clone()], Some(head.txid));
            if case == 0 {
                backend.source = "another-source".into();
                backend.terminal_evidence = Evidence::FullNodeValidated {
                    source: backend.source.clone(),
                };
            } else if case == 1 {
                backend.endpoint.host = "changed.invalid".into();
            }
            let (mut service, requests, fetches) = cache_service(backend, Some(body.clone()));
            let resolved = resolve_selected_identities_with_cache(
                &mut service,
                BTreeSet::from([category]),
                &[],
                IdentityResolutionContext {
                    network: if case == 2 {
                        Network::Mainnet
                    } else {
                        Network::Chipnet
                    },
                    tip: Some(CACHE_TIP),
                    now_unix_ms: Some(CACHE_CLOCK),
                    cache: &cache,
                },
            )
            .await;
            assert_eq!(
                projected_identity(&resolved, category).status,
                IdentityStatus::Verified
            );
            assert_eq!(
                requests.lock().unwrap()[0],
                ChainRequest::TransactionLookup { txid: base.txid }
            );
            assert_eq!(fetches.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn transient_failures_retain_bounded_owned_hints_without_current_authority() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        let previously_verified = revalidate_cache_fixture(&cache).await;
        for failure in [
            Some(ChainBackendError::Timeout),
            Some(ChainBackendError::Offline),
            None,
        ] {
            let mut backend = cache_backend(vec![head.clone()], Some(head.txid));
            backend.failure = failure.clone();
            let (mut service, _, _) = cache_service(backend, None);
            if failure.is_none() {
                // Same selected configuration, before a transport reconnects.
                service = ChainService::new(service.catalog().clone(), service.policy().clone());
            }
            let resolved = run_cached(&mut service, category, &cache, Some(CACHE_CLOCK)).await;
            assert_eq!(
                serde_json::to_value(&resolved.cache).unwrap(),
                serde_json::to_value(&cache).unwrap()
            );
            let mut app = wallet_with(vec![coin(
                1,
                1000,
                Some(optn_core::token::TokenData::fungible(category, 1)),
            )]);
            app.token_identities
                .insert(category_hex(&category), previously_verified.clone());
            resolved.apply(&mut app);
            assert_eq!(
                app.token_identities[&category_hex(&category)].status,
                IdentityStatus::Stale
            );
            assert_eq!(
                app.token_identities[&category_hex(&category)].name,
                "Cached"
            );
            // Once available again, only the head and its UTXO are queried.
            assert_eq!(
                revalidate_cache_fixture(&resolved.cache).await.status,
                IdentityStatus::Verified
            );

            let unowned = resolve_selected_identities_with_cache(
                &mut service,
                BTreeSet::new(),
                &[],
                IdentityResolutionContext {
                    network: Network::Chipnet,
                    tip: Some(CACHE_TIP),
                    now_unix_ms: Some(CACHE_CLOCK),
                    cache: &cache,
                },
            )
            .await;
            assert!(unowned.cache.0.is_empty());
        }
    }

    #[tokio::test]
    async fn a_live_burn_removes_the_retained_publication_hint() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        let mut burned = cache_transaction(Some(head.txid), None);
        // This fixture has one output followed by its four-byte locktime.
        let script_start = burned.raw.len() - 4 - p2pkh().len();
        burned.raw[script_start] = 0x6a;
        burned.txid = optn_core::header_hash::sha256d(&burned.raw);
        let (mut service, _, fetches) =
            cache_service(cache_backend(vec![head, burned], None), None);
        let resolved = run_cached(&mut service, category, &cache, Some(CACHE_CLOCK)).await;
        assert_eq!(
            projected_identity(&resolved, category).status,
            IdentityStatus::Unpublished
        );
        assert!(resolved.cache.0.is_empty());
        assert_eq!(fetches.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn missing_tip_keeps_only_hints_but_revocation_discards_them() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        for revoked in [false, true] {
            let (mut service, requests, _) =
                cache_service(cache_backend(vec![head.clone()], Some(head.txid)), None);
            if revoked {
                service.revocation().revoke();
            }
            let resolved = resolve_selected_identities_with_cache(
                &mut service,
                BTreeSet::from([category]),
                &[],
                IdentityResolutionContext {
                    network: Network::Chipnet,
                    tip: revoked.then_some(CACHE_TIP),
                    now_unix_ms: Some(CACHE_CLOCK),
                    cache: &cache,
                },
            )
            .await;
            assert!(requests.lock().unwrap().is_empty());
            assert_eq!(resolved.cache.0.is_empty(), revoked);
            assert_eq!(
                projected_identity(&resolved, category).status,
                IdentityStatus::Unresolved
            );
        }
    }

    #[tokio::test]
    async fn ambiguous_successors_leave_cached_identity_unresolved() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        let first = cache_transaction(Some(head.txid), None);
        let second = cache_transaction(Some(head.txid), Some(&registry_body("Other", category)));
        let (mut service, requests, _) = cache_service(
            cache_backend(vec![head.clone(), first.clone()], Some(first.txid)),
            None,
        );
        let resolved = resolve_selected_identities_with_cache(
            &mut service,
            BTreeSet::from([category]),
            &[first, second],
            IdentityResolutionContext {
                network: Network::Chipnet,
                tip: Some(CACHE_TIP),
                now_unix_ms: Some(CACHE_CLOCK),
                cache: &cache,
            },
        )
        .await;
        assert_eq!(
            projected_identity(&resolved, category).status,
            IdentityStatus::Unresolved
        );
        assert!(resolved.cache.0.is_empty());
        assert_eq!(
            *requests.lock().unwrap(),
            vec![ChainRequest::TransactionLookup { txid: head.txid }]
        );
    }

    #[tokio::test]
    async fn malformed_restart_records_are_rejected_and_never_shortcut_resolution() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, base, head, body) = cache_fixture();
        for case in 0..7 {
            let mut malformed = cache.clone();
            let entry = malformed.0.values_mut().next().unwrap();
            match case {
                0 => entry.chain[0].push(0),
                1 => entry.chain.reverse(),
                2 => entry.registry.as_mut().unwrap().contents.push(0),
                3 => entry.chain.clear(),
                4 => entry.chain = vec![head.raw.clone(); MAX_AUTHCHAIN_HOPS as usize + 1],
                5 => {
                    entry.registry.as_mut().unwrap().contents =
                        vec![0; FetchLimits::default().max_bytes + 1]
                }
                6 => {
                    let entry = malformed.0.remove(&category_hex(&category)).unwrap();
                    malformed.0.insert("not-a-category".into(), entry);
                }
                _ => unreachable!(),
            }
            assert!(malformed.validate(Network::Chipnet).is_err(), "case {case}");
            let (mut service, requests, fetches) = cache_service(
                cache_backend(vec![base.clone(), head.clone()], Some(head.txid)),
                Some(body.clone()),
            );
            let resolved = run_cached(&mut service, category, &malformed, Some(CACHE_CLOCK)).await;
            assert_eq!(
                requests.lock().unwrap()[0],
                ChainRequest::TransactionLookup { txid: base.txid }
            );
            assert_eq!(
                projected_identity(&resolved, category).status,
                IdentityStatus::Verified
            );
            assert_eq!(fetches.load(Ordering::SeqCst), 1);
        }
    }

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
            r#"{{"identities":{{"{hex}":{{"2023-11-14T22:13:20.000Z":{{"name":"{name}","token":{{"category":"{hex}","symbol":"BCAT","decimals":2}}}}}}}}}}"#
        )
        .into_bytes()
    }

    #[test]
    fn identity_projection_uses_supplied_wall_clock_and_fails_closed_without_it() {
        let category = category_hex(&ALPHA);
        let body = serde_json::to_vec(&serde_json::json!({"identities": {&category: {
            "2023-11-14T22:13:20.000Z": {"name": "Old", "token": {"category": category}},
            "2023-11-14T22:13:20.001Z": {"name": "New", "token": {"category": category}}
        }}}))
        .unwrap();
        let metadata = resolve(
            &publication(&body, &["example.com"]),
            &[("example.com".into(), Ok(body.clone()))],
        );
        for (now, expected, status) in [
            (Some(0), "Old", IdentityStatus::Verified),
            (Some(1_700_000_000_000), "Old", IdentityStatus::Verified),
            (Some(1_700_000_000_001), "New", IdentityStatus::Verified),
            (None, category.as_str(), IdentityStatus::Unresolved),
        ] {
            let AppAction::SetTokenIdentity { identity, .. } =
                observe_identity_at(ALPHA, metadata.clone(), now)
            else {
                panic!("identity observation");
            };
            assert_eq!(identity.name, expected);
            assert_eq!(identity.status, status);
        }
        let AppAction::SetTokenIdentity { identity, .. } = observe_identity_at(
            ALPHA,
            IdentityMetadata::LastKnown {
                contents: body,
                authhead: [3; 32],
                reason: StaleReason::AuthheadAdvanced,
            },
            Some(1_700_000_000_001),
        ) else {
            panic!("identity observation");
        };
        assert_eq!(identity.name, "New");
        assert_eq!(identity.status, IdentityStatus::Stale);
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

    #[test]
    fn fresh_registry_withdrawal_clears_cached_names_but_fetch_failures_keep_them_stale() {
        let key = category_hex(&ALPHA);
        let original = registry_body("Bitcats", ALPHA);
        let observe = |body: &[u8], attempt: FetchAttempt| {
            BTreeMap::from([(
                ALPHA,
                OwnedCategoryIdentity::Observed {
                    publication: publication(body, &["example.com"]),
                    attempts: vec![("example.com".into(), attempt)],
                },
            )])
        };
        let mut initial = wallet_with(vec![coin(
            1,
            1000,
            Some(optn_core::token::TokenData::fungible(ALPHA, 10)),
        )]);
        apply_owned_token_identities(&mut initial, &observe(&original, Ok(original.clone())));
        assert_eq!(
            initial.token_identities[&key].status,
            IdentityStatus::Verified
        );
        for attempt in [Err(FetchError::Timeout), Ok(b"hash mismatch".to_vec())] {
            let mut state = initial.clone();
            apply_owned_token_identities(&mut state, &observe(&original, attempt));
            assert_eq!(state.token_identities[&key].name, "Bitcats");
            assert_eq!(state.token_identities[&key].status, IdentityStatus::Stale);
        }
        let mut removed: serde_json::Value = serde_json::from_slice(&original).unwrap();
        removed["identities"][&key]["2023-11-14T22:13:20.001Z"] =
            serde_json::json!({"name": "Removed"});
        for body in [
            serde_json::to_vec(&removed).unwrap(),
            br#"{"identities":{}}"#.to_vec(),
            b"malformed authenticated registry".to_vec(),
        ] {
            let mut state = initial.clone();
            apply_owned_token_identities(&mut state, &observe(&body, Ok(body.clone())));
            let identity = &state.token_identities[&key];
            assert_eq!(identity.name, key);
            assert_eq!(identity.status, IdentityStatus::Unresolved);
            assert!(identity.ticker.is_none());
            assert_eq!(identity.presentation, Default::default());
            assert_eq!(state.coins.len(), 1);
        }
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
                presentation: Default::default(),
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

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

use optn_app::{
    AppAction, AppState, IdentityAssurance, IdentityBasis, IdentityStatus, TokenIdentity,
};
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
/// Spender lookups that must answer per hop: two, so that two disagreeing
/// sources are still caught, without asking every selected server.
const SPENDER_CROSS_CHECK: usize = 2;

/// Routes in plan order, a full node's first: it validates what it answers,
/// and a walk it completes is never asked of a server that only reports.
fn full_node_first(mut routes: Vec<CapabilityRoute>) -> Vec<CapabilityRoute> {
    routes.sort_by_key(|route| route.protocol != crate::chain::ProtocolFamily::BchnRpc);
    routes
}

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
        let (walk, latest) = resume_chain(category, &self.chain)?;
        if let Some(registry) = &self.registry {
            if !latest.as_ref()?.matches(&registry.contents) {
                return None;
            }
        }
        Some(walk)
    }
}

/// Rebuild a walk from raw transactions, authbase first, checking every link
/// locally: the first hashes to the category's authbase, each spends output 0
/// of the one before, and only the last may be burned. Returns the walk
/// positioned at the last transaction and the newest publication on the chain.
///
/// Nothing here is evidence. The resolver still looks the last transaction up
/// on the selected route and asks whether its identity output is unspent; the
/// hash links are what make an earlier hop as good as that live answer.
fn resume_chain(
    category: [u8; 32],
    chain: &[Vec<u8>],
) -> Option<(AuthchainResolution, Option<RegistryPublication>)> {
    if chain.is_empty() || chain.len() > MAX_AUTHCHAIN_HOPS as usize {
        return None;
    }
    let mut walk = AuthchainResolution::for_token_category(category, identity_budget());
    let mut seen = BTreeSet::new();
    let mut latest = None;
    for (index, raw) in chain.iter().enumerate() {
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
            // Stored inclusion height is not live inclusion evidence.
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
        // A burned identity output ends the chain: only the head may carry
        // one, and nothing follows it.
        match optn_core::bcmr::identity_output_state(transaction.outputs.first().map(Vec::as_slice))
        {
            optn_core::bcmr::IdentityOutputState::Live => {}
            optn_core::bcmr::IdentityOutputState::Burned if index + 1 == chain.len() => {}
            _ => return None,
        }
        if let Some(publication) = publication_in(transaction.outputs.iter().map(Vec::as_slice)) {
            latest = Some(publication);
        }
    }
    // No accept(Unspent) call occurs here: local restoration can only ask
    // for the last transaction, never return Resolved.
    Some((walk, latest))
}

/// The authchains a verified registry carries for the given categories.
///
/// BCMR's `authchain` extension lists an identity's chain as raw transactions,
/// authbase first, keyed `"0"`, `"1"`, ... in an identity snapshot. A registry
/// listing several identities can carry chains for all of them, which saves a
/// first walk for each. Untrusted: a chain is only a restart point, checked by
/// [`resume_chain`] before use. Where snapshots disagree the longest wins, and
/// the link checks decide whether it is usable at all.
fn registry_authchains(
    contents: &[u8],
    wanted: &BTreeSet<[u8; 32]>,
) -> BTreeMap<[u8; 32], Vec<Vec<u8>>> {
    let mut chains = BTreeMap::new();
    let Ok(registry) = serde_json::from_slice::<serde_json::Value>(contents) else {
        return chains;
    };
    let Some(identities) = registry
        .get("identities")
        .and_then(serde_json::Value::as_object)
    else {
        return chains;
    };
    for (authbase, history) in identities {
        let Some(category) = parse_category_key(&authbase.to_ascii_lowercase()) else {
            continue;
        };
        if !wanted.contains(&category) {
            continue;
        }
        let longest = history
            .as_object()
            .into_iter()
            .flat_map(|snapshots| snapshots.values())
            .filter_map(|snapshot| snapshot.get("extensions")?.get("authchain")?.as_object())
            .filter_map(|links| {
                if links.is_empty() || links.len() > MAX_AUTHCHAIN_HOPS as usize {
                    return None;
                }
                (0..links.len())
                    .map(|index| {
                        optn_core::payment::decode_hex(links.get(&index.to_string())?.as_str()?)
                            .ok()
                    })
                    .collect::<Option<Vec<_>>>()
            })
            .max_by_key(Vec::len);
        if let Some(chain) = longest {
            chains.insert(category, chain);
        }
    }
    chains
}

/// Keep the longer of two candidate chains for each category.
fn merge_authchains(
    into: &mut BTreeMap<[u8; 32], Vec<Vec<u8>>>,
    from: BTreeMap<[u8; 32], Vec<Vec<u8>>>,
) {
    for (category, chain) in from {
        let known = into.entry(category).or_default();
        if chain.len() > known.len() {
            *known = chain;
        }
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
    /// Nothing on the authchain publishes a registry.
    ///
    /// Not a failure: the identity has never been given a chain-resolved
    /// registry. The token still exists and is still owned.
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

/// The most recent publication on a chain of raw transactions, oldest first.
///
/// A head that publishes nothing leaves the identity's latest registry in
/// effect: issuers move identity outputs for other reasons, and a newer
/// publication -- including one that withdraws the token -- is how a registry
/// changes. This is how Electron Cash and OPTN's legacy resolver read a chain.
fn latest_publication(chain: &[Vec<u8>]) -> Option<RegistryPublication> {
    chain.iter().rev().find_map(|raw| {
        let decoded = optn_core::tx::decode(raw).ok()?;
        publication_in(
            decoded
                .outputs
                .iter()
                .map(|output| output.script_pubkey.as_slice()),
        )
    })
}

/// A transaction a spender search supplied along with its answer.
struct Hint {
    transaction: ChainTransaction,
    observed: ObservedTransaction,
    source: SourceId,
    evidence: Evidence,
}

/// What one observation on the selected route can support. That route's own
/// validating node settles a step; its server can only report one. A claim
/// attributed to another source, or evidence this path does not rank, supports
/// nothing.
fn assurance_of(evidence: &Evidence, route: &CapabilityRoute) -> Option<IdentityAssurance> {
    match evidence {
        Evidence::FullNodeValidated { source } if source == &route.source => {
            Some(IdentityAssurance::NodeValidated)
        }
        Evidence::ServerAssertion => Some(IdentityAssurance::ServerReported),
        _ => None,
    }
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
            basis: IdentityBasis::default(),
        },
        (IdentityMetadata::LastKnown { .. }, Some(names)) => TokenIdentity {
            name: names.name,
            ticker: names.ticker,
            decimals: names.decimals,
            status: IdentityStatus::Stale,
            presentation: names.presentation,
            basis: IdentityBasis::default(),
        },
        (IdentityMetadata::Unpublished, _) => TokenIdentity {
            name: category_hex.clone(),
            ticker: None,
            decimals: 0,
            status: IdentityStatus::Unpublished,
            presentation: Default::default(),
            basis: IdentityBasis::default(),
        },
        (IdentityMetadata::Unresolved { .. }, _) | (_, None) => TokenIdentity {
            name: category_hex.clone(),
            ticker: None,
            decimals: 0,
            status: IdentityStatus::Unresolved,
            presentation: Default::default(),
            basis: IdentityBasis::default(),
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
        /// How the authhead carrying the publication was established.
        basis: IdentityBasis,
    },
    /// No transaction on the authchain publishes a registry. Distinct from an
    /// incomplete walk.
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
    // Chains other registries carry for these categories: from registries
    // cached by earlier refreshes, and from those verified as this one runs.
    let wanted = categories.clone();
    let mut authchains = BTreeMap::new();
    if let Some(context) = context.as_ref().filter(|_| cache_valid) {
        for registry in context
            .cache
            .0
            .values()
            .filter_map(|entry| entry.registry.as_ref())
        {
            merge_authchains(
                &mut authchains,
                registry_authchains(&registry.contents, &wanted),
            );
        }
    }
    // Bound optional metadata work for a refresh. Unfinished categories remain
    // unresolved without withholding the wallet's accepted coins or history.
    let work = async {
        for category in categories.into_iter().take(MAX_IDENTITY_CATEGORIES) {
            let category_key = category_hex(&category);
            let mut identity = OwnedCategoryIdentity::Unresolved;
            for route in
                full_node_first(service.routes_for_operation(ChainOperation::OutpointSpentness))
            {
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
                // Restart from this route's own hint, or else from a chain a
                // verified registry carries. Either is checked link by link,
                // and its last transaction is still established live below.
                let restart = match hint {
                    Some(hint) => hint.resume(category).map(|walk| (hint.chain.clone(), walk)),
                    None => authchains.get(&category).and_then(|chain| {
                        resume_chain(category, chain).map(|(walk, _)| (chain.clone(), walk))
                    }),
                };
                let (start, mut walk) = match restart {
                    Some((chain, walk)) => (chain, walk),
                    None => (
                        Vec::new(),
                        AuthchainResolution::for_token_category(category, identity_budget()),
                    ),
                };
                let mut path = context.as_ref().map(|_| start.clone());
                let mut path_bytes = path
                    .as_ref()
                    .map_or(0, |path| path.iter().map(Vec::len).sum::<usize>());
                let mut seen: BTreeSet<Hash32> = start
                    .iter()
                    .take(start.len().saturating_sub(1))
                    .map(|raw| optn_core::header_hash::sha256d(raw))
                    .collect();
                // The weakest evidence any accepted step rested on. It starts at
                // the strongest and only ever falls.
                let mut assurance = IdentityAssurance::NodeValidated;
                // Transactions a spender search passed through on its way back.
                // Candidates only: each must still continue the chain when the
                // walk reaches it. Its bytes stand in for a lookup only when they
                // came from this route's own source and would not weaken what
                // the walk already rests on; otherwise the route is asked.
                let mut hinted: BTreeMap<Hash32, Hint> = BTreeMap::new();
                let mut burned = false;
                // The newest registry published anywhere on the chain so far. A
                // restart chain's earlier hops count; its head is read again live.
                let mut latest = latest_publication(&start[..start.len().saturating_sub(1)]);
                let mut step = walk.next_step();
                while let AuthchainStep::Query { txid } = step {
                    if !seen.insert(txid) {
                        result.cache.0.remove(&category_key);
                        break;
                    }
                    let supplied = hinted
                        .remove(&txid)
                        .filter(|hint| {
                            hint.source == route.source
                                && assurance_of(&hint.evidence, &route)
                                    .is_some_and(|level| level >= assurance)
                        })
                        .map(|hint| (hint.observed, hint.evidence));
                    let (transaction, evidence) = match supplied {
                        Some(supplied) => supplied,
                        None => {
                            let observed = match service
                                .execute_optional_on_route(
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
                            if observed.source != route.source || !tip_matches(observed.chain_tip) {
                                result.cache.0.remove(&category_key);
                                break;
                            }
                            let ChainPayload::Transaction(transaction) = observed.value else {
                                result.cache.0.remove(&category_key);
                                break;
                            };
                            (transaction, observed.evidence)
                        }
                    };
                    let Some(level) = assurance_of(&evidence, &route) else {
                        result.cache.0.remove(&category_key);
                        break;
                    };
                    assurance = assurance.min(level);
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
                    let current =
                        IdentityCollection::from_observed(&[transaction], vec![], evidence);
                    let Some(current) = current.transactions.first() else {
                        result.cache.0.remove(&category_key);
                        break;
                    };
                    walk.inspect(current);
                    if let Some(publication) =
                        publication_in(current.outputs.iter().map(Vec::as_slice))
                    {
                        latest = Some(publication);
                    }
                    if matches!(
                        optn_core::bcmr::identity_output_state(
                            current.outputs.first().map(Vec::as_slice)
                        ),
                        optn_core::bcmr::IdentityOutputState::Burned
                    ) {
                        // An `OP_RETURN` identity output cannot be spent, so this
                        // is the head on the chain's own terms: no server has to
                        // say so. A burned head is still the head, and its outputs
                        // carry its registry -- often the burning output itself.
                        burned = true;
                        break;
                    }
                    let mut successors = collection
                        .transactions
                        .iter()
                        .chain(hinted.values().map(|hint| &hint.transaction))
                        .filter(|candidate| candidate.inputs.contains(&(txid, 0)));
                    if let Some(successor) = successors.next() {
                        // Wallet history and a search's hints may hold the same
                        // transaction; only two different spenders conflict.
                        if successors.any(|other| other.txid != successor.txid) {
                            result.cache.0.remove(&category_key);
                            break;
                        }
                        step = walk.accept(authchain::IdentityStatus::SpentBy(successor.clone()));
                        continue;
                    }
                    let unspent = match service
                        .execute_optional_on_route(
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
                    let level = assurance_of(&unspent.evidence, &route);
                    if unspent.source != route.source
                        || !tip_matches(unspent.chain_tip)
                        || level.is_none()
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
                        // history. Its bytes are used as a lookup only when they came
                        // from this route's own server; otherwise the next iteration
                        // fetches them from the selected route before believing them.
                        let Some(output) = decoded.outputs.first() else {
                            result.cache.0.remove(&category_key);
                            break;
                        };
                        let mut discovered_successor: Option<ChainTransaction> = None;
                        let mut ambiguous = false;
                        let mut answered = 0usize;
                        for discovery in full_node_first(
                            service.routes_for_operation(ChainOperation::OutpointSpender),
                        ) {
                            if answered >= SPENDER_CROSS_CHECK {
                                break;
                            }
                            let Ok(candidate) = service
                                .execute_optional_on_route(
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
                            answered += 1;
                            let ChainPayload::OutpointSpender {
                                spender: Some(spender),
                                descendants,
                                ..
                            } = candidate.value
                            else {
                                continue;
                            };
                            let discovered = IdentityCollection::from_observed(
                                std::slice::from_ref(&spender),
                                vec![],
                                candidate.evidence.clone(),
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
                                for observed in std::iter::once(spender).chain(descendants) {
                                    let decoded = IdentityCollection::from_observed(
                                        std::slice::from_ref(&observed),
                                        vec![],
                                        candidate.evidence.clone(),
                                    );
                                    if let Some(transaction) =
                                        decoded.transactions.into_iter().next()
                                    {
                                        hinted.insert(
                                            transaction.txid,
                                            Hint {
                                                transaction,
                                                observed,
                                                source: discovery.source.clone(),
                                                evidence: candidate.evidence.clone(),
                                            },
                                        );
                                    }
                                }
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
                    if let Some(level) = level {
                        assurance = assurance.min(level);
                    }
                    step = walk.accept(authchain::IdentityStatus::Unspent {
                        evidence: unspent.evidence,
                    });
                }
                let terminal = match step {
                    AuthchainStep::Resolved(_) => Some(false),
                    _ if burned => Some(true),
                    _ => None,
                };
                if let Some(burned) = terminal {
                    let basis = IdentityBasis { assurance, burned };
                    // The head's own publication when it has one, otherwise the
                    // newest earlier one: still in effect until superseded.
                    if let Some(publication) = latest.take() {
                        let mut attempts = Vec::new();
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
                            attempts
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
                                attempts.push((uri.clone(), attempt));
                                if matches {
                                    break;
                                }
                            }
                        }
                        if let Some(contents) = attempts.iter().find_map(|(_, attempt)| {
                            attempt
                                .as_ref()
                                .ok()
                                .filter(|contents| publication.matches(contents))
                        }) {
                            merge_authchains(
                                &mut authchains,
                                registry_authchains(contents, &wanted),
                            );
                        }
                        // An indexer's bytes are accepted by the same publication hash
                        // gate as publisher bytes. Keep the actual source URI for evidence.
                        identity = OwnedCategoryIdentity::Observed {
                            publication,
                            attempts,
                            basis,
                        };
                    } else {
                        identity = OwnedCategoryIdentity::Unpublished;
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
                                    ..
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
        // Only reached for a head the route's own node established.
        basis: IdentityBasis {
            assurance: IdentityAssurance::NodeValidated,
            burned: false,
        },
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

/// The identity one observation supports, as the action that publishes it.
fn project_identity(
    category: [u8; 32],
    observation: Option<&OwnedCategoryIdentity>,
    now_unix_ms: Option<i64>,
) -> (AppAction, bool) {
    let (metadata, basis) = match observation {
        Some(OwnedCategoryIdentity::Observed {
            publication,
            attempts,
            basis,
        }) => (resolve(publication, attempts), *basis),
        Some(OwnedCategoryIdentity::Unpublished) => {
            (IdentityMetadata::Unpublished, IdentityBasis::default())
        }
        Some(OwnedCategoryIdentity::Unresolved) | None => (
            IdentityMetadata::Unresolved {
                reason: UnresolvedReason::AuthchainIncomplete,
            },
            IdentityBasis::default(),
        ),
    };
    let current = metadata.is_current();
    let mut action = observe_identity_at(category, metadata, now_unix_ms);
    if let AppAction::SetTokenIdentity { identity, .. } = &mut action {
        if identity.status == IdentityStatus::Verified {
            identity.basis = basis;
        }
    }
    (action, current)
}

/// Resolve token identities over the service's selected routes, the way a
/// wallet refresh does, for categories nothing here holds.
///
/// For diagnostics and live checks: no restart hint is read or written, no
/// wallet state is touched, and the result is exactly what a holder of each
/// category would be shown. Identities are judged against the routes' own
/// answers, as a refresh without an accepted tip would.
pub async fn resolve_category_identities(
    service: &mut crate::chain_service::ChainService,
    categories: BTreeSet<[u8; 32]>,
) -> BTreeMap<[u8; 32], TokenIdentity> {
    let resolved = resolve_selected_identities_inner(service, categories.clone(), &[], None).await;
    let now = checked_unix_ms();
    categories
        .into_iter()
        .filter_map(|category| {
            match project_identity(category, resolved.identities.get(&category), now) {
                (AppAction::SetTokenIdentity { identity, .. }, _) => Some((category, identity)),
                _ => None,
            }
        })
        .collect()
}

pub(crate) fn apply_owned_token_identities_at(
    app: &mut AppState,
    observations: &BTreeMap<[u8; 32], OwnedCategoryIdentity>,
    now_unix_ms: Option<i64>,
) {
    for category in owned_token_categories(app) {
        // Fresh authenticated bytes supersede cached claims, including token
        // removal or an invalid current snapshot. Neither may revive old data.
        let (mut action, current) =
            project_identity(category, observations.get(&category), now_unix_ms);
        let allow_cached = !current;
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
        /// `None` answers lookups as the source's own node.
        lookup_evidence: Option<Evidence>,
        /// Returned with any spender this backend discovers.
        descendants: Vec<ObservedTransaction>,
        protocol: ProtocolFamily,
        raw_tip: Option<(u32, Hash32)>,
        failure: Option<ChainBackendError>,
        requests: Arc<Mutex<Vec<ChainRequest>>>,
    }

    impl ChainBackend for CacheBackend {
        fn source_id(&self) -> &SourceId {
            &self.source
        }
        fn protocol(&self) -> ProtocolFamily {
            self.protocol
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
                        self.lookup_evidence.clone().unwrap_or_else(|| Evidence::FullNodeValidated { source: self.source.clone() }),
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
                            descendants: self.descendants.clone(),
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
            lookup_evidence: None,
            descendants: Vec::new(),
            protocol: ProtocolFamily::BchnRpc,
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
    async fn spent_cached_head_continues_to_an_advanced_or_a_quiet_head() {
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
            // A new head that publishes nothing leaves the previous registry in
            // effect, and its cached bytes still match without a refetch.
            assert_eq!(identity.status, IdentityStatus::Verified);
            assert_eq!(identity.name, if publishes { "Advanced" } else { "Cached" });
            assert_eq!(fetches.load(Ordering::SeqCst), usize::from(publishes));
            let entry = &resolved.cache.0[&category_hex(&category)];
            assert_eq!(entry.chain.len(), 3);
            assert!(entry.registry.is_some());
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
                // A server's word about the terminal output is a labelled,
                // weaker answer (see `a_server_reported_head_...`). A proof of
                // inclusion says nothing at all about whether it is unspent.
                1 => {
                    backend.terminal_evidence = Evidence::MerkleTransactionIncluded {
                        txid: head.txid,
                        block_hash: CACHE_TIP.1,
                        height: 91,
                    }
                }
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
    async fn a_burn_without_a_new_publication_freezes_the_last_registry() {
        let (category, cache) = resolved_cache_fixture().await;
        let (_, _, head, _) = cache_fixture();
        let mut burned = cache_transaction(Some(head.txid), None);
        // This fixture has one output followed by its four-byte locktime.
        let script_start = burned.raw.len() - 4 - p2pkh().len();
        burned.raw[script_start] = 0x6a;
        burned.txid = optn_core::header_hash::sha256d(&burned.raw);
        let (mut service, _, fetches) =
            cache_service(cache_backend(vec![head, burned.clone()], None), None);
        let resolved = run_cached(&mut service, category, &cache, Some(CACHE_CLOCK)).await;
        let identity = projected_identity(&resolved, category);
        // Nobody can publish for this identity again: its last registry is final.
        assert_eq!(identity.status, IdentityStatus::Verified);
        assert_eq!(identity.name, "Cached");
        assert!(identity.basis.burned);
        let entry = &resolved.cache.0[&category_hex(&category)];
        assert!(entry.registry.is_some());
        assert_eq!(entry.chain.last(), Some(&burned.raw));
        resolved.cache.validate(Network::Chipnet).unwrap();
        assert_eq!(fetches.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn the_newest_publication_on_the_chain_is_in_effect() {
        // Moria USD's shape on mainnet: a registry published mid-chain, then
        // identity moves that publish nothing.
        let base = cache_transaction(None, None);
        let mut category = base.txid;
        category.reverse();
        let first = registry_body("First", category);
        let second = registry_body("Second", category);
        for (bodies, expected) in [
            (vec![Some(&first), None, None], Some("First")),
            (vec![Some(&first), Some(&second), None], Some("Second")),
            (vec![None, None, None], None),
        ] {
            let mut chain = vec![base.clone()];
            for body in &bodies {
                let parent = chain.last().unwrap().txid;
                chain.push(cache_transaction(Some(parent), body.map(Vec::as_slice)));
            }
            let head = chain.last().unwrap().txid;
            let (mut service, _, fetches) = cache_service(
                server_backend(chain, Some(head)),
                expected.map(|name| registry_body(name, category)),
            );
            let resolved = run_cached(
                &mut service,
                category,
                &BcmrIdentityCache::default(),
                Some(CACHE_CLOCK),
            )
            .await;
            let identity = projected_identity(&resolved, category);
            match expected {
                Some(name) => {
                    assert_eq!(identity.status, IdentityStatus::Verified);
                    assert_eq!(identity.name, name);
                    assert_eq!(fetches.load(Ordering::SeqCst), 1);
                }
                None => assert_eq!(identity.status, IdentityStatus::Unpublished),
            }
            resolved.cache.validate(Network::Chipnet).unwrap();
        }
    }

    fn server_backend(
        transactions: Vec<ObservedTransaction>,
        terminal: Option<Hash32>,
    ) -> CacheBackend {
        let mut backend = cache_backend(transactions, terminal);
        backend.lookup_evidence = Some(Evidence::ServerAssertion);
        backend.terminal_evidence = Evidence::ServerAssertion;
        backend
    }

    #[tokio::test]
    async fn a_server_reported_head_is_current_at_its_own_assurance() {
        let (category, base, head, body) = cache_fixture();
        let (mut service, _, fetches) = cache_service(
            server_backend(vec![base, head.clone()], Some(head.txid)),
            Some(body),
        );
        let resolved = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        let identity = projected_identity(&resolved, category);
        assert_eq!(identity.status, IdentityStatus::Verified);
        assert_eq!(identity.name, "Cached");
        assert_eq!(
            identity.basis,
            IdentityBasis {
                assurance: IdentityAssurance::ServerReported,
                burned: false,
            }
        );
        assert_eq!(identity.caveat(), Some("as reported by server"));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        resolved.cache.validate(Network::Chipnet).unwrap();

        // One server-level step is enough to lower the whole result: the
        // node's own lookups cannot vouch for a terminal it only heard about.
        let (category, base, head, body) = cache_fixture();
        let mut mixed = cache_backend(vec![base, head.clone()], Some(head.txid));
        mixed.terminal_evidence = Evidence::ServerAssertion;
        let (mut service, _, _) = cache_service(mixed, Some(body));
        let resolved = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        assert_eq!(
            projected_identity(&resolved, category).basis.assurance,
            IdentityAssurance::ServerReported
        );
    }

    #[tokio::test]
    async fn a_node_validated_head_says_so() {
        let (category, cache) = resolved_cache_fixture().await;
        let _ = cache;
        let (_, base, head, body) = cache_fixture();
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
        let identity = projected_identity(&resolved, category);
        assert_eq!(identity.basis.assurance, IdentityAssurance::NodeValidated);
        assert!(!identity.basis.burned);
        assert_eq!(identity.caveat(), None);
    }

    /// A genesis whose identity output is the BCMR publication itself: the
    /// identity is burned at birth, and that output is its registry.
    fn burned_genesis(parent: Hash32, body: &[u8]) -> ObservedTransaction {
        let script = publication_script(body, "example.test");
        let mut raw = vec![2, 0, 0, 0, 1];
        raw.extend_from_slice(&parent);
        raw.extend_from_slice(&0u32.to_le_bytes());
        raw.push(0);
        raw.extend_from_slice(&u32::MAX.to_le_bytes());
        raw.push(2);
        raw.extend_from_slice(&0u64.to_le_bytes());
        raw.extend_from_slice(&optn_core::tx::varint(script.len() as u64));
        raw.extend_from_slice(&script);
        raw.extend_from_slice(&546u64.to_le_bytes());
        raw.extend_from_slice(&optn_core::tx::varint(p2pkh().len() as u64));
        raw.extend_from_slice(&p2pkh());
        raw.extend_from_slice(&0u32.to_le_bytes());
        ObservedTransaction {
            txid: optn_core::header_hash::sha256d(&raw),
            raw,
            block_height: Some(91),
        }
    }

    #[tokio::test]
    async fn a_burned_head_publishes_its_own_registry_without_asking_anyone_it_is_current() {
        let (category, base, _, _) = cache_fixture();
        let body = registry_body("Frozen", category);
        let genesis = burned_genesis(base.txid, &body);
        for server_only in [false, true] {
            // Nobody reports the burned output unspent: none is needed.
            let mut backend = cache_backend(vec![base.clone(), genesis.clone()], None);
            if server_only {
                backend.lookup_evidence = Some(Evidence::ServerAssertion);
                backend.terminal_evidence = Evidence::ServerAssertion;
            }
            let (mut service, requests, fetches) = cache_service(backend, Some(body.clone()));
            let resolved = run_cached(
                &mut service,
                category,
                &BcmrIdentityCache::default(),
                Some(CACHE_CLOCK),
            )
            .await;
            let identity = projected_identity(&resolved, category);
            assert_eq!(identity.status, IdentityStatus::Verified);
            assert_eq!(identity.name, "Frozen");
            assert_eq!(
                identity.basis,
                IdentityBasis {
                    assurance: if server_only {
                        IdentityAssurance::ServerReported
                    } else {
                        IdentityAssurance::NodeValidated
                    },
                    burned: true,
                }
            );
            assert_eq!(fetches.load(Ordering::SeqCst), 1);
            assert!(!requests.lock().unwrap().iter().any(|request| matches!(
                request,
                ChainRequest::OutpointSpentness { txid, .. } if *txid == genesis.txid
            )));

            // Restarting from the cache asks only for the burned head again.
            let (mut service, requests, fetches) = cache_service(
                {
                    let mut backend = cache_backend(vec![genesis.clone()], None);
                    if server_only {
                        backend.lookup_evidence = Some(Evidence::ServerAssertion);
                    }
                    backend
                },
                None,
            );
            let again =
                run_cached(&mut service, category, &resolved.cache, Some(CACHE_CLOCK)).await;
            assert_eq!(projected_identity(&again, category).name, "Frozen");
            assert_eq!(
                *requests.lock().unwrap(),
                vec![ChainRequest::TransactionLookup { txid: genesis.txid }]
            );
            assert_eq!(fetches.load(Ordering::SeqCst), 0);
        }
    }

    /// base -> a1 -> a2 -> a3 (head, publishing), each spending output 0.
    fn hinted_chain() -> ([u8; 32], Vec<ObservedTransaction>, Vec<u8>) {
        let base = cache_transaction(None, None);
        let mut category = base.txid;
        category.reverse();
        let body = registry_body("Far", category);
        let a1 = cache_transaction(Some(base.txid), None);
        let a2 = cache_transaction(Some(a1.txid), None);
        let a3 = cache_transaction(Some(a2.txid), Some(&body));
        (category, vec![base, a1, a2, a3], body)
    }

    #[tokio::test]
    async fn a_servers_walk_back_hints_skip_its_own_repeat_lookups() {
        let (category, chain, body) = hinted_chain();
        let head = chain[3].txid;
        let mut backend = server_backend(chain.clone(), Some(head));
        // Discovery from base:0 finds a1 and walked a2, a3 on the way.
        backend.descendants = vec![chain[2].clone(), chain[3].clone()];
        let (mut service, requests, _) = cache_service(backend, Some(body));
        let resolved = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        let identity = projected_identity(&resolved, category);
        assert_eq!(identity.name, "Far");
        assert_eq!(identity.basis.assurance, IdentityAssurance::ServerReported);
        let requests = requests.lock().unwrap();
        // The authbase is looked up; the hinted hops are not looked up again.
        let lookups: Vec<_> = requests
            .iter()
            .filter_map(|request| match request {
                ChainRequest::TransactionLookup { txid } => Some(*txid),
                _ => None,
            })
            .collect();
        assert_eq!(lookups, vec![chain[0].txid]);
        // Only the head's terminal output is asked about after discovery.
        assert!(requests.iter().any(|request| matches!(
            request,
            ChainRequest::OutpointSpentness { txid, .. } if *txid == head
        )));
        assert_eq!(resolved.cache.0[&category_hex(&category)].chain.len(), 4);
    }

    #[tokio::test]
    async fn another_sources_hints_are_refetched_from_the_selected_node() {
        let (category, chain, body) = hinted_chain();
        let head = chain[3].txid;
        // The selected node discovers nothing itself; a separate server does,
        // and supplies the whole chain as hints.
        let node = cache_backend(chain.clone(), Some(head));
        let mut discovery = server_backend(chain.clone(), None);
        discovery.source = SourceId::new("discovery-server");
        discovery.endpoint = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "discovery.invalid".into(),
            port: Some(50002),
        };
        discovery.protocol = ProtocolFamily::Electrum;
        discovery.capabilities = CapabilitySet::default();
        discovery.capabilities.record(
            Capability::OutpointSpenderLookup,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        discovery.descendants = vec![chain[2].clone(), chain[3].clone()];
        let node_requests = node.requests.clone();
        let mut catalog = SourceCatalog::default();
        for (id, endpoint) in [
            (node.source.clone(), node.endpoint.clone()),
            (discovery.source.clone(), discovery.endpoint.clone()),
        ] {
            catalog
                .insert(ChainSource {
                    id,
                    label: "hint test".into(),
                    origin: SourceOrigin::UserAdded,
                    endpoints: vec![endpoint],
                    capabilities: Default::default(),
                    disposition: SourceDisposition::Enabled,
                    priority: 0,
                })
                .unwrap();
        }
        let mut policy = ConnectionPolicy::exact(node.source.clone(), ProtocolFamily::BchnRpc);
        policy.primary_scope = crate::chain::SourceScope::Explicit(BTreeSet::from([
            node.source.clone(),
            discovery.source.clone(),
        ]));
        policy.preferred = vec![node.source.clone(), discovery.source.clone()];
        policy.protocols.insert(ProtocolFamily::Electrum);
        let mut service = ChainService::new(catalog, policy);
        service.register(Arc::new(node));
        service.register(Arc::new(discovery));
        service.set_registry_fetcher(Arc::new(CacheFetcher {
            body,
            calls: Arc::new(AtomicUsize::new(0)),
            revoke: None,
        }));
        let resolved = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        let identity = projected_identity(&resolved, category);
        assert_eq!(identity.name, "Far");
        // Every hop came from the node in the end, so the node vouches for it.
        assert_eq!(identity.basis.assurance, IdentityAssurance::NodeValidated);
        let lookups: Vec<_> = node_requests
            .lock()
            .unwrap()
            .iter()
            .filter_map(|request| match request {
                ChainRequest::TransactionLookup { txid } => Some(*txid),
                _ => None,
            })
            .collect();
        assert_eq!(lookups, chain.iter().map(|tx| tx.txid).collect::<Vec<_>>());
    }

    /// An Electrum server at `name`, reporting what `transactions` hold.
    fn electrum_server(
        name: &str,
        transactions: Vec<ObservedTransaction>,
        terminal: Option<Hash32>,
    ) -> CacheBackend {
        let mut server = server_backend(transactions, terminal);
        server.source = SourceId::new(name);
        server.endpoint = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: format!("{name}.invalid"),
            port: Some(50002),
        };
        server.protocol = ProtocolFamily::Electrum;
        server
    }

    /// The given backends, all selected and ranked in the order given.
    fn ranked_service(backends: Vec<CacheBackend>, body: Vec<u8>) -> ChainService {
        let mut catalog = SourceCatalog::default();
        for backend in &backends {
            catalog
                .insert(ChainSource {
                    id: backend.source.clone(),
                    label: "route economy".into(),
                    origin: SourceOrigin::UserAdded,
                    endpoints: vec![backend.endpoint.clone()],
                    capabilities: Default::default(),
                    disposition: SourceDisposition::Enabled,
                    priority: 0,
                })
                .unwrap();
        }
        let ranked: Vec<SourceId> = backends
            .iter()
            .map(|backend| backend.source.clone())
            .collect();
        let mut policy = ConnectionPolicy::auto();
        policy.primary_scope =
            crate::chain::SourceScope::Explicit(ranked.iter().cloned().collect());
        policy.preferred = ranked;
        let mut service = ChainService::new(catalog, policy);
        for backend in backends {
            service.register(Arc::new(backend));
        }
        service.set_registry_fetcher(Arc::new(CacheFetcher {
            body,
            calls: Arc::new(AtomicUsize::new(0)),
            revoke: None,
        }));
        service
    }

    fn spender_requests(requests: &Arc<Mutex<Vec<ChainRequest>>>) -> usize {
        requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| matches!(request, ChainRequest::OutpointSpender { .. }))
            .count()
    }

    /// A full node validates what it answers, so it walks the chain even when
    /// a server is ranked ahead of it, and the server is not asked to.
    #[tokio::test]
    async fn a_full_node_walks_the_chain_before_a_server_ranked_ahead_of_it() {
        let (category, chain, body) = hinted_chain();
        let head = chain[3].txid;
        let server = electrum_server("server", chain.clone(), Some(head));
        let server_requests = server.requests.clone();
        let node = cache_backend(chain.clone(), Some(head));
        let mut service = ranked_service(vec![server, node], body);
        let resolved = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        let identity = projected_identity(&resolved, category);
        assert_eq!(identity.name, "Far");
        assert_eq!(identity.basis.assurance, IdentityAssurance::NodeValidated);
        let asked = server_requests.lock().unwrap().clone();
        assert!(
            asked
                .iter()
                .all(|request| matches!(request, ChainRequest::OutpointSpender { .. })),
            "the server only cross-checks spenders: {asked:?}"
        );
    }

    /// Spender discovery asks two sources per hop, enough to catch two that
    /// disagree, rather than every selected server.
    #[tokio::test]
    async fn spender_discovery_asks_two_sources_per_hop_not_every_one() {
        let (category, chain, body) = hinted_chain();
        let head = chain[3].txid;
        let node = cache_backend(chain.clone(), Some(head));
        let node_requests = node.requests.clone();
        let servers =
            ["one", "two", "three"].map(|name| electrum_server(name, chain.clone(), None));
        let asked: Vec<_> = servers
            .iter()
            .map(|server| server.requests.clone())
            .collect();
        let mut backends = vec![node];
        backends.extend(servers);
        let mut service = ranked_service(backends, body);
        let resolved = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        assert_eq!(projected_identity(&resolved, category).name, "Far");
        let hops = spender_requests(&node_requests);
        assert!(hops > 0, "the walk needed spender discovery");
        assert_eq!(spender_requests(&asked[0]), hops, "one cross-check per hop");
        assert_eq!(spender_requests(&asked[1]), 0);
        assert_eq!(spender_requests(&asked[2]), 0);
    }

    /// Two sources naming different spenders of the same output still leave
    /// the identity unresolved.
    #[tokio::test]
    async fn two_sources_naming_different_spenders_still_leave_it_unresolved() {
        let (category, chain, body) = hinted_chain();
        let head = chain[3].txid;
        let node = cache_backend(chain.clone(), Some(head));
        let rival = cache_transaction(Some(chain[0].txid), Some(&registry_body("Rival", category)));
        assert_ne!(rival.txid, chain[1].txid);
        let server = electrum_server("rival", vec![chain[0].clone(), rival], None);
        let mut service = ranked_service(vec![node, server], body);
        let resolved = run_cached(
            &mut service,
            category,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        assert_eq!(
            projected_identity(&resolved, category).status,
            IdentityStatus::Unresolved
        );
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

    fn hex_of(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// A second identity whose chain another registry can carry: an authbase
    /// of its own, a hop that publishes its registry, and a quiet head.
    fn beta_chain() -> ([u8; 32], Vec<ObservedTransaction>, Vec<u8>) {
        let base = cache_transaction(Some([0x42; 32]), None);
        let mut category = base.txid;
        category.reverse();
        let body = registry_body("Beta", category);
        let published = cache_transaction(Some(base.txid), Some(&body));
        let head = cache_transaction(Some(published.txid), None);
        (category, vec![base, published, head], body)
    }

    fn registry_with_authchain(
        alpha: [u8; 32],
        beta: [u8; 32],
        chain: &[ObservedTransaction],
    ) -> Vec<u8> {
        let links: serde_json::Map<String, serde_json::Value> = chain
            .iter()
            .enumerate()
            .map(|(index, tx)| (index.to_string(), serde_json::json!(hex_of(&tx.raw))))
            .collect();
        serde_json::to_vec(&serde_json::json!({"identities": {
            category_hex(&alpha): {"2023-11-14T22:13:20.000Z": {"name": "Alpha",
                "token": {"category": category_hex(&alpha), "symbol": "ALPHA", "decimals": 0}}},
            category_hex(&beta): {"2023-11-14T22:13:20.000Z": {"name": "Beta (as Alpha lists it)",
                "extensions": {"authchain": links}}}
        }}))
        .unwrap()
    }

    #[test]
    fn registry_authchains_reads_only_wanted_contiguous_chains() {
        let (beta, chain, _) = beta_chain();
        let (alpha, ..) = cache_fixture();
        let body = registry_with_authchain(alpha, beta, &chain);
        let wanted = BTreeSet::from([beta]);
        let chains = registry_authchains(&body, &wanted);
        assert_eq!(
            chains[&beta],
            chain.iter().map(|tx| tx.raw.clone()).collect::<Vec<_>>()
        );
        assert!(registry_authchains(&body, &BTreeSet::new()).is_empty());
        // A gap in the indexes, bad hex or a non-object is not a chain.
        for links in [
            serde_json::json!({"0": hex_of(&chain[0].raw), "2": hex_of(&chain[2].raw)}),
            serde_json::json!({"0": "zz"}),
            serde_json::json!(["not", "an", "object"]),
            serde_json::json!({}),
        ] {
            let body = serde_json::to_vec(&serde_json::json!({"identities": {
                category_hex(&beta): {"2023-11-14T22:13:20.000Z": {"name": "Beta",
                    "extensions": {"authchain": links}}}
            }}))
            .unwrap();
            assert!(registry_authchains(&body, &wanted).is_empty());
        }
        assert!(registry_authchains(b"not json", &wanted).is_empty());
    }

    #[tokio::test]
    async fn a_verified_registry_carrying_anothers_authchain_saves_its_walk() {
        // Run 1: Alpha's registry lists Beta's chain, and is cached with it.
        let (beta, chain, beta_body) = beta_chain();
        let (alpha, alpha_base, _, _) = cache_fixture();
        let alpha_body = registry_with_authchain(alpha, beta, &chain);
        let alpha_head = cache_transaction(Some(alpha_base.txid), Some(&alpha_body));
        let (mut service, _, _) = cache_service(
            cache_backend(vec![alpha_base, alpha_head.clone()], Some(alpha_head.txid)),
            Some(alpha_body),
        );
        let first = run_cached(
            &mut service,
            alpha,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        assert_eq!(projected_identity(&first, alpha).name, "Alpha");

        // Run 2: the node holds only Beta's head. Nothing earlier is asked for.
        let head = chain[2].clone();
        let (mut service, requests, _) = cache_service(
            cache_backend(vec![head.clone()], Some(head.txid)),
            Some(beta_body),
        );
        let resolved = resolve_selected_identities_with_cache(
            &mut service,
            BTreeSet::from([alpha, beta]),
            &[],
            IdentityResolutionContext {
                network: Network::Chipnet,
                tip: Some(CACHE_TIP),
                now_unix_ms: Some(CACHE_CLOCK),
                cache: &first.cache,
            },
        )
        .await;
        let mut app = wallet_with(vec![coin(
            1,
            1000,
            Some(optn_core::token::TokenData::fungible(beta, 1)),
        )]);
        resolved.apply(&mut app);
        let identity = &app.token_identities[&category_hex(&beta)];
        assert_eq!(identity.status, IdentityStatus::Verified);
        assert_eq!(identity.name, "Beta");
        assert_eq!(identity.basis.assurance, IdentityAssurance::NodeValidated);
        let beta_requests: Vec<_> = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| {
                !matches!(request, ChainRequest::TransactionLookup { txid } if *txid == alpha_head.txid)
                    && !matches!(request, ChainRequest::OutpointSpentness { txid, .. } if *txid == alpha_head.txid)
            })
            .cloned()
            .collect();
        assert_eq!(
            beta_requests,
            vec![
                ChainRequest::TransactionLookup { txid: head.txid },
                ChainRequest::OutpointSpentness {
                    txid: head.txid,
                    vout: 0
                },
            ]
        );
        resolved.cache.validate(Network::Chipnet).unwrap();
    }

    #[tokio::test]
    async fn a_broken_registry_authchain_is_ignored_for_a_cold_walk() {
        let (beta, chain, _) = beta_chain();
        let (alpha, alpha_base, _, _) = cache_fixture();
        // Out of order: the links do not connect, so it cannot start a walk.
        let shuffled = vec![chain[0].clone(), chain[2].clone(), chain[1].clone()];
        let alpha_body = registry_with_authchain(alpha, beta, &shuffled);
        let alpha_head = cache_transaction(Some(alpha_base.txid), Some(&alpha_body));
        let (mut service, _, _) = cache_service(
            cache_backend(vec![alpha_base, alpha_head.clone()], Some(alpha_head.txid)),
            Some(alpha_body),
        );
        let first = run_cached(
            &mut service,
            alpha,
            &BcmrIdentityCache::default(),
            Some(CACHE_CLOCK),
        )
        .await;
        let (mut service, requests, _) = cache_service(
            cache_backend(vec![chain[2].clone()], Some(chain[2].txid)),
            None,
        );
        resolve_selected_identities_with_cache(
            &mut service,
            BTreeSet::from([beta]),
            &[],
            IdentityResolutionContext {
                network: Network::Chipnet,
                tip: Some(CACHE_TIP),
                now_unix_ms: Some(CACHE_CLOCK),
                cache: &first.cache,
            },
        )
        .await;
        assert_eq!(
            requests.lock().unwrap().first(),
            Some(&ChainRequest::TransactionLookup {
                txid: chain[0].txid
            })
        );
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
                        basis: IdentityBasis::default(),
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
            basis: IdentityBasis::default(),
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
                    basis: IdentityBasis::default(),
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
                basis: Default::default(),
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

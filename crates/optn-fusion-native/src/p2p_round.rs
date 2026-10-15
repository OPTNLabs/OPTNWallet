//! One P2P CashFusion round for a wallet's coins, over Nostr and Tor: the host
//! that carries `optn_fusion::p2p`'s state machines, as `FusionP2pService.ts`
//! carries the TypeScript ones on the desktop. The two meet in one round.
//!
//! 1. The coins' keys come from the wallet runtime, largest coins first, at
//!    most the credential limit.
//! 2. A fresh round key announces the coins' tiers on the network's rolling
//!    pool and gathers live peers (the desktop's lock policy).
//! 3. The gathered group agrees on a round (`p2p::rendezvous`).
//! 4. Fresh outputs are planned and reserved by the runtime, and the round
//!    runs (`p2p::session`), signing through the native boundary.
//! 5. The coordinator broadcasts through the round's own Electrum
//!    connections; every peer rebroadcasts what it verified; the host waits for
//!    a selected server to hold the transaction.
//!
//! Every relay stream to a remote relay goes through the verified Tor proxy
//! with its own isolation credentials, so each one-shot connection that
//! carries an anonymous component is its own circuit — the property the
//! desktop gets from one socket per component. A loopback relay is dialled
//! directly.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::{Stream, StreamExt};
use optn_core::network::Network;
use optn_fusion::p2p::allocation::{plan_output_values, DEFAULT_MIN_OUTPUT};
use optn_fusion::p2p::assemble::Contribution;
use optn_fusion::p2p::credentials::MAX_INPUT_CREDENTIALS_PER_PEER;
use optn_fusion::p2p::io::{Action, Clock};
use optn_fusion::p2p::knobs::{
    GATHER_ALONE_AUTO_MS, GATHER_ALONE_MS, GATHER_FAST_WARMUP_MS, GATHER_MAX_MS, GATHER_MIN_MS,
    MAX_PLAYERS, MIN_PLAYERS, MIN_SAFE_PLAYERS, PEAK_GRACE_MS, PEER_SET_STABLE_FAST_MS,
    RENDEZVOUS_MS, SMALL_SET_HOLD_MS, TIERS_SATS,
};
use optn_fusion::p2p::pool::{
    build_announcement, is_live, parse_announcement, pool_epoch, pool_tag, select_group,
    Announcement, AnnouncementEvent, GroupPeer, POOL_ANNOUNCE_KIND, POOL_REANNOUNCE_SECONDS,
    POOL_SUBSCRIBE_LOOKBACK_SECONDS,
};
use optn_fusion::p2p::rendezvous::{Negotiated, Rendezvous};
use optn_fusion::p2p::session::{Round, RoundParams};
use optn_fusion::p2p::signer::{sign_native, SigningRound};
use optn_fusion::p2p::timing::{round_timeout_ms, COMPONENT_JITTER_MS};
use optn_fusion::p2p::wire::{parse_round_message, InputRef, OutputRef, PoolNetwork, RoundMessage};
use optn_fusion::p2p::P2P_FEERATE;
use optn_nostr::nip17;
use optn_nostr::nostr::prelude::{
    Event, EventBuilder, Filter, FinalizeEvent, Keys, Kind, PublicKey, Tag, Timestamp,
};
use optn_nostr::{Dialed, RelayDialer, RelayEndpoint, RelayIo, RelayRoute, Relays};
use optn_runtime::AppRuntime;
use zeroize::Zeroizing;

use crate::lookups::{ChainInputLookups, LookupEndpoint};
use crate::server_round::{
    runtime_refusal, transport_for, wait_until_seen, wallet_outputs, FusedRound, BROADCAST_WAIT,
};

/// The desktop's relay set (`FUSION_CORE_RELAYS`), in the same order, so
/// announcements and gift wraps share a topology with the desktop's peers.
pub const FUSION_CORE_RELAYS: [&str; 6] = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.snort.social",
    "wss://offchain.pub",
    "wss://nostr.oxtr.dev",
];

/// Opening relay connections, Tor circuits included.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
/// How often the gather re-evaluates the live set (`collectRolling`).
const GATHER_POLL_MS: u64 = 2_000;
/// A verified blame sets the accused round key aside this long.
const BLAMED_KEY_TTL: Duration = Duration::from_secs(600);
/// Whole-event attempts when too few relays take an event
/// (`PUBLISH_MAX_ROUNDS`): a relay that is slow, flaky or rate-limiting
/// refuses one attempt and takes the next.
const PUBLISH_MAX_ROUNDS: u32 = 3;
/// The pause before the next attempt, times the attempts so far
/// (`PUBLISH_RETRY_BASE_MS`).
const PUBLISH_RETRY_BASE_MS: u64 = 400;
/// Pool announcements must land on relays other wallets share, so they need
/// two acceptances when there are two relays to give them
/// (`PUBLISH_POOL_MIN_ACKS`). Round messages need one.
const PUBLISH_POOL_MIN_ACKS: usize = 2;
/// How long a settled round waits for its last messages to reach a relay
/// before the connections close. The coordinator's `final` is among them.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(15);

/// Everything about a round that is not the coins.
#[derive(Debug, Clone)]
pub struct P2pRoundSettings {
    pub network: Network,
    /// Nostr relays, `wss://` or a loopback `ws://`.
    pub relays: Vec<String>,
    /// The verified Tor proxy's SOCKS port on 127.0.0.1. Required for any
    /// remote relay or lookup server.
    pub verified_proxy: Option<u16>,
    /// The holder's selected Electrum servers: the round broadcasts and checks
    /// visibility through them, over connections of its own.
    pub lookup_servers: Vec<LookupEndpoint>,
    /// Auto waits longer alone (`P2P_GATHER_ALONE_AUTO_MS`).
    pub auto: bool,
}

/// Round keys this process announced under, and keys a verified blame named.
/// A relay keeps replaying a stored announcement, so without this a later
/// gather would count its own abandoned key, or a cheater's, as a peer.
#[derive(Default)]
struct Ghosts {
    own: HashSet<String>,
    blamed: HashMap<String, Instant>,
}

fn ghosts() -> &'static Mutex<Ghosts> {
    static GHOSTS: OnceLock<Mutex<Ghosts>> = OnceLock::new();
    GHOSTS.get_or_init(Mutex::default)
}

fn is_ghost(key: &str) -> bool {
    let mut ghosts = ghosts().lock().expect("ghost registry");
    ghosts.blamed.retain(|_, at| at.elapsed() < BLAMED_KEY_TTL);
    ghosts.own.contains(key) || ghosts.blamed.contains_key(key)
}

/// Every relay stream: a loopback relay directly, any other through the
/// verified proxy with fresh isolation credentials (a new circuit).
struct FusionRelayDialer {
    proxy: Option<u16>,
}

impl RelayDialer for FusionRelayDialer {
    fn dial(&self, endpoint: RelayEndpoint) -> Dialed {
        let proxy = self.proxy;
        Box::pin(async move {
            let transport = transport_for(&endpoint.host, proxy)?;
            let stream =
                optn_fusion::connect_stream(&endpoint.host, endpoint.port, endpoint.tls, transport)
                    .await?;
            Ok(Box::new(stream) as Box<dyn RelayIo>)
        })
    }
}

struct Clocks(Instant);

impl Clocks {
    fn now(&self) -> Clock {
        Clock {
            ms: self.0.elapsed().as_millis() as u64,
            unix: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or(0),
        }
    }
}

/// What the relays delivered.
enum Delivery {
    /// A round message, opened and parsed, from the key that sealed it.
    Message(String, RoundMessage),
    /// A gift wrap to us that opened but did not parse.
    Malformed(String),
    Announcement(Event),
}

/// Publish `event` until `min_acks` relays hold it (all of them when there
/// are fewer), retrying the whole event as the desktop does
/// (`publishEventAtLeastOnce`).
async fn publish_at_least_once(
    relays: &Relays,
    event: &Event,
    relay_count: usize,
    min_acks: usize,
) -> Result<(), String> {
    let need = min_acks.clamp(1, relay_count.max(1));
    let mut last = String::new();
    for attempt in 1..=PUBLISH_MAX_ROUNDS {
        match relays.publish(event).await {
            Ok(published) if published.accepted.len() >= need => return Ok(()),
            Ok(published) => {
                last = format!(
                    "{} of the {need} relays needed accepted it",
                    published.accepted.len()
                );
            }
            Err(error) => last = error.to_string(),
        }
        if attempt < PUBLISH_MAX_ROUNDS {
            tokio::time::sleep(Duration::from_millis(
                PUBLISH_RETRY_BASE_MS * u64::from(attempt),
            ))
            .await;
        }
    }
    Err(format!(
        "No Nostr relay accepted the Fusion message: {last}"
    ))
}

/// The relays a round speaks through.
struct Wire {
    relays: Relays,
    urls: Vec<String>,
    route: RelayRoute,
    keys: Keys,
    /// Publishes still on their way, so the round can let them land before
    /// the connections close.
    in_flight: Mutex<tokio::task::JoinSet<()>>,
}

impl Wire {
    /// Gift-wrap `message` to `to`. A transaction component goes under a
    /// throwaway key on a one-shot connection (a fresh circuit); the control
    /// plane under the round key on the shared connection. Publishing never
    /// blocks the round: a lost message is what the resend timers are for.
    fn send(&self, to: &str, message: &RoundMessage) {
        let Ok(receiver) = PublicKey::from_hex(to) else {
            return;
        };
        let json = message.to_json();
        if message.body.is_anonymous() {
            let Ok(event) = nip17::wrap(&Keys::generate(), &receiver, &json) else {
                return;
            };
            let (urls, route) = (self.urls.clone(), self.route.clone());
            self.spawn(async move {
                if let Ok(one_shot) = Relays::connect(&urls, route, CONNECT_TIMEOUT).await {
                    let _ = publish_at_least_once(&one_shot, &event, urls.len(), 1).await;
                    one_shot.shutdown().await;
                }
            });
        } else if let Ok(event) = nip17::wrap(&self.keys, &receiver, &json) {
            let (relays, count) = (self.relays.clone(), self.urls.len());
            self.spawn(async move {
                let _ = publish_at_least_once(&relays, &event, count, 1).await;
            });
        }
    }

    /// Publish a pool announcement or withdrawal under the round key.
    fn announce(&self, event: Event) {
        let (relays, count) = (self.relays.clone(), self.urls.len());
        self.spawn(async move {
            let _ = publish_at_least_once(&relays, &event, count, PUBLISH_POOL_MIN_ACKS).await;
        });
    }

    fn spawn(&self, publish: impl std::future::Future<Output = ()> + Send + 'static) {
        let mut in_flight = self.in_flight.lock().expect("publish set");
        while in_flight.try_join_next().is_some() {}
        in_flight.spawn(publish);
    }

    /// Wait, up to `limit`, for every publish still on its way.
    async fn flush(&self, limit: Duration) {
        let mut pending = std::mem::take(&mut *self.in_flight.lock().expect("publish set"));
        let _ = tokio::time::timeout(limit, async {
            while pending.join_next().await.is_some() {}
        })
        .await;
    }

    /// Open a relay event: an announcement as is, a gift wrap to this round
    /// key opened and parsed.
    fn open(&self, event: Event, now_unix: u64) -> Option<Delivery> {
        if event.kind == Kind::from(POOL_ANNOUNCE_KIND) {
            return Some(Delivery::Announcement(event));
        }
        if event.kind != Kind::GiftWrap {
            return None;
        }
        let opened = nip17::unwrap(&self.keys, &event).ok()?;
        let sender = opened.sender.to_hex();
        Some(match parse_round_message(&opened.content, now_unix) {
            Some(message) => Delivery::Message(sender, message),
            None => Delivery::Malformed(sender),
        })
    }
}

/// The pool as this round key sees it.
struct PoolView {
    network: PoolNetwork,
    me: String,
    tiers: Vec<u64>,
    num_inputs: u64,
    peers: HashMap<String, Announcement>,
}

impl PoolView {
    fn admit(&mut self, event: &Event, now_unix: u64) {
        let pubkey = event.pubkey.to_hex();
        if pubkey == self.me || is_ghost(&pubkey) || event.verify().is_err() {
            return;
        }
        let tags: Vec<Vec<String>> = event
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect();
        let parsed = parse_announcement(
            &AnnouncementEvent {
                pubkey: &pubkey,
                kind: event.kind.as_u16(),
                created_at: event.created_at.as_secs(),
                tags: &tags,
                content: &event.content,
            },
            self.network,
            now_unix,
        );
        match parsed {
            Some(mut announcement) => {
                if let Some(previous) = self.peers.get(&pubkey) {
                    announcement.at = announcement.at.max(previous.at);
                }
                announcement.seen_at = Some(now_unix);
                self.peers.insert(pubkey, announcement);
            }
            // A withdrawal is already expired and does not parse; it still
            // removes the key at once rather than at its TTL.
            None => {
                let expired = serde_json::from_str::<serde_json::Value>(&event.content)
                    .ok()
                    .and_then(|content| {
                        content.get("expiresAt").and_then(serde_json::Value::as_u64)
                    })
                    .is_some_and(|expires| expires < now_unix);
                if expired {
                    self.peers.remove(&pubkey);
                }
            }
        }
    }

    /// The live set, self included: `strict` is the lock view, in which only
    /// keys re-published during this gather count.
    fn live(&self, now_unix: u64, gather_start_unix: u64, strict: bool) -> Vec<Announcement> {
        let mut live: Vec<Announcement> = self
            .peers
            .values()
            .filter(|peer| {
                is_live(
                    peer,
                    now_unix,
                    gather_start_unix,
                    &self.me,
                    is_ghost,
                    strict,
                )
            })
            .cloned()
            .collect();
        live.push(Announcement {
            pubkey: self.me.clone(),
            network: self.network,
            epoch: pool_epoch(now_unix),
            tiers: self.tiers.clone(),
            num_inputs: self.num_inputs,
            at: now_unix,
            expires_at: now_unix + optn_fusion::p2p::pool::POOL_PEER_TTL_SECONDS,
            seen_at: Some(now_unix),
        });
        live
    }

    fn announcement(&self, keys: &Keys, now_unix: u64, withdraw: bool) -> Result<Event, String> {
        let draft = build_announcement(
            self.network,
            &self.tiers,
            self.num_inputs,
            now_unix,
            withdraw,
        )?;
        let tags = draft
            .tags
            .iter()
            .map(|tag| Tag::parse(tag.clone()).map_err(|error| error.to_string()))
            .collect::<Result<Vec<Tag>, String>>()?;
        EventBuilder::new(Kind::from(POOL_ANNOUNCE_KIND), draft.content)
            .tags(tags)
            .custom_created_at(Timestamp::from_secs(draft.created_at))
            .finalize(keys)
            .map_err(|error| error.to_string())
    }
}

/// The desktop's gather lock policy (`collectRolling`), one poll at a time.
struct Gather {
    start_ms: u64,
    start_unix: u64,
    alone_budget_ms: u64,
    fingerprint: String,
    stable_since: u64,
    last_boost: u64,
    peak_soft: usize,
    peak_strict: usize,
    last_at_peak: u64,
    last_soft_caught_up: u64,
}

enum GatherStep {
    Wait { boost: bool, status: String },
    Locked(Vec<Announcement>),
    Failed(String),
}

impl Gather {
    fn new(clock: Clock, auto: bool) -> Self {
        Self {
            start_ms: clock.ms,
            start_unix: clock.unix,
            alone_budget_ms: if auto {
                GATHER_ALONE_AUTO_MS
            } else {
                GATHER_ALONE_MS
            },
            fingerprint: String::new(),
            stable_since: clock.ms,
            last_boost: 0,
            peak_soft: 0,
            peak_strict: 0,
            last_at_peak: clock.ms,
            last_soft_caught_up: clock.ms,
        }
    }

    fn poll(&mut self, pool: &PoolView, clock: Clock, auto: bool) -> GatherStep {
        let now = clock.ms;
        let soft = pool.live(clock.unix, self.start_unix, false);
        let strict = pool.live(clock.unix, self.start_unix, true);
        self.peak_soft = self.peak_soft.max(soft.len());
        self.peak_strict = self.peak_strict.max(strict.len());
        if self.peak_strict > 0 && strict.len() >= self.peak_strict {
            self.last_at_peak = now;
        }
        if soft.len() <= strict.len() {
            self.last_soft_caught_up = now;
        }
        let mut keys: Vec<&str> = strict.iter().map(|peer| peer.pubkey.as_str()).collect();
        keys.sort_unstable();
        let fingerprint = keys.join(",");
        if fingerprint != self.fingerprint {
            self.fingerprint = fingerprint;
            self.stable_since = now;
        }
        let n = strict.len();
        let boost_ms = if n < MIN_PLAYERS { 1_500 } else { 3_000 };
        let boost = n < MIN_PLAYERS.max(self.peak_soft).max(self.peak_strict)
            && now.saturating_sub(self.last_boost) > boost_ms;
        if boost {
            self.last_boost = now;
        }
        let at_cap = n >= MAX_PLAYERS;
        let enough = n >= MIN_PLAYERS;
        let elapsed = now - self.start_ms;
        let stable_for = now - self.stable_since;
        let peak_grace_expired = now.saturating_sub(self.last_at_peak) >= PEAK_GRACE_MS;
        let expect_more_from_soft =
            soft.len() > n && now.saturating_sub(self.last_soft_caught_up) < PEAK_GRACE_MS;
        let lost_from_peak = self.peak_strict > n && self.peak_strict >= MIN_PLAYERS;
        let views_aligned =
            soft.len() == n || now.saturating_sub(self.last_soft_caught_up) >= PEAK_GRACE_MS;
        let expect_more =
            expect_more_from_soft || (lost_from_peak && !peak_grace_expired) || !views_aligned;
        let full_set_ready = at_cap
            && elapsed >= GATHER_FAST_WARMUP_MS
            && stable_for >= PEER_SET_STABLE_FAST_MS
            && !expect_more;
        let partial_set_ready = enough
            && !at_cap
            && elapsed >= GATHER_MIN_MS
            && !expect_more
            && stable_for >= SMALL_SET_HOLD_MS;
        if n < 2 && self.peak_strict >= 2 && peak_grace_expired && elapsed >= PEAK_GRACE_MS {
            return GatherStep::Failed(format!(
                "No peers left (peak was {}, now only you). Others already fused or left the pool; Auto will retry shortly.",
                self.peak_strict
            ));
        }
        let never_saw_others = self.peak_soft <= 1 && self.peak_strict <= 1;
        if never_saw_others && elapsed >= self.alone_budget_ms {
            return GatherStep::Failed(if auto {
                format!(
                    "Auto: no peers for {}s — will retry shortly. Need ≥{MIN_PLAYERS} online with P2P and Tor.",
                    self.alone_budget_ms / 1_000
                )
            } else {
                format!(
                    "No other wallets found in {}s. Need ≥{MIN_PLAYERS} peers on the same network (Tor + Nostr). Retry when others are online.",
                    self.alone_budget_ms / 1_000
                )
            });
        }
        if lost_from_peak && n < MIN_PLAYERS && (peak_grace_expired || elapsed >= GATHER_MAX_MS) {
            return GatherStep::Failed(format!(
                "Peer set changed during gather (peak {}, now {n}). Retrying with a fresh shared set.",
                self.peak_strict
            ));
        }
        if full_set_ready || partial_set_ready || elapsed >= GATHER_MAX_MS {
            if n < MIN_PLAYERS {
                return GatherStep::Failed(if auto {
                    format!("Auto: only {n} peer(s) (need ≥{MIN_PLAYERS}). Will retry shortly.")
                } else {
                    format!("P2P Fusion needs at least {MIN_PLAYERS} peers (CashFusion-style anonymity floor).")
                });
            }
            return GatherStep::Locked(strict);
        }
        GatherStep::Wait {
            boost,
            status: format!("{n} active (soft {}), need ≥{MIN_PLAYERS}…", soft.len()),
        }
    }
}

fn pool_network(network: Network) -> Result<PoolNetwork, String> {
    match network {
        Network::Mainnet => Ok(PoolNetwork::Mainnet),
        Network::Chipnet => Ok(PoolNetwork::Chipnet),
        other => Err(format!(
            "P2P CashFusion runs on mainnet and chipnet, not {other}"
        )),
    }
}

/// A boxed future the host awaits from a wallet-side helper.
pub type WalletFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>>;

/// Reserves fresh outputs for a round, durably, before any leaves the host.
pub trait OutputReserver: Send + Sync {
    fn reserve(&self, count: usize) -> WalletFuture<'_, Vec<Vec<u8>>>;
}

/// Hands a finished CoinJoin to the network. The display txid on success.
pub trait Broadcaster: Send + Sync {
    fn broadcast(&self, raw: Vec<u8>) -> WalletFuture<'_, String>;
}

impl Broadcaster for ChainInputLookups {
    fn broadcast(&self, raw: Vec<u8>) -> WalletFuture<'_, String> {
        Box::pin(async move { ChainInputLookups::broadcast(self, &raw).await })
    }
}

struct RuntimeReserver<'r>(&'r AppRuntime);

impl OutputReserver for RuntimeReserver<'_> {
    fn reserve(&self, count: usize) -> WalletFuture<'_, Vec<Vec<u8>>> {
        Box::pin(async move {
            self.0
                .reserve_change_outputs(count)
                .await
                .map_err(runtime_refusal)
        })
    }
}

/// The coins a round contributes and their signing keys.
pub struct P2pCoins {
    pub inputs: Vec<InputRef>,
    /// Compressed pubkey (hex) and secret, per input.
    pub keys: Zeroizing<Vec<(String, [u8; 32])>>,
}

/// Where a round speaks.
pub struct P2pCore {
    pub network: PoolNetwork,
    pub relays: Vec<String>,
    pub route: RelayRoute,
    pub auto: bool,
}

/// A round the network may now hold, and the scripts this wallet reserved.
pub struct P2pFused {
    pub result: optn_fusion::p2p::session::RoundResult,
    pub scripts: Vec<Vec<u8>>,
}

/// One round from announcement to a verified, broadcast transaction, with
/// the wallet behind two small traits so the same path runs against a test
/// relay.
pub async fn run_p2p(
    core: &P2pCore,
    coins: P2pCoins,
    reserver: &dyn OutputReserver,
    broadcaster: Arc<dyn Broadcaster>,
    cancel: &optn_fusion::round_cancel::CancelFlag,
    status: &(dyn Fn(&str) + Send + Sync),
) -> Result<P2pFused, String> {
    let network = core.network;
    if core.relays.is_empty() {
        return Err("no Nostr relay is configured for P2P CashFusion".into());
    }
    let inputs = coins.inputs;
    let signing_keys = Arc::new(coins.keys);
    if inputs.is_empty() {
        return Err("no coins to fuse".into());
    }
    let sum_in: u64 = inputs.iter().map(|input| input.value).sum();
    // Refuse early, as the desktop does, rather than after gathering peers.
    plan_output_values(
        &inputs
            .iter()
            .map(|input| (input.value, input.pubkey.len()))
            .collect::<Vec<_>>(),
        MIN_PLAYERS,
        P2P_FEERATE,
        DEFAULT_MIN_OUTPUT,
        None,
        || 0.5,
    )?;
    let tiers: Vec<u64> = TIERS_SATS
        .into_iter()
        .filter(|tier| sum_in > tier + 1_000)
        .collect();
    if tiers.is_empty() {
        return Err("Inputs too small for any P2P fusion tier.".into());
    }

    status("Connecting to Nostr relays…");
    let relays = Relays::connect(&core.relays, core.route.clone(), CONNECT_TIMEOUT)
        .await
        .map_err(|error| format!("could not reach the Nostr relays: {error}"))?;
    let round_keys = Keys::generate();
    let me = round_keys.public_key().to_hex();
    let wire = Wire {
        relays: relays.clone(),
        urls: core.relays.clone(),
        route: core.route.clone(),
        keys: round_keys.clone(),
        in_flight: Mutex::new(tokio::task::JoinSet::new()),
    };
    let mut pool = PoolView {
        network,
        me: me.clone(),
        tiers,
        num_inputs: inputs.len() as u64,
        peers: HashMap::new(),
    };
    let clocks = Clocks(Instant::now());

    let outcome = async {
        let mut events: Events<'_> = Box::pin(relays.events());
        let since = clocks
            .now()
            .unix
            .saturating_sub(POOL_SUBSCRIBE_LOOKBACK_SECONDS);
        relays
            .subscribe(
                Filter::new()
                    .kind(Kind::from(POOL_ANNOUNCE_KIND))
                    .hashtag(pool_tag(network))
                    .since(Timestamp::from_secs(since)),
            )
            .await
            .map_err(|error| format!("could not subscribe to the fusion pool: {error}"))?;
        // Gift wraps carry scrambled timestamps, so no `since`.
        relays
            .subscribe(
                Filter::new()
                    .kind(Kind::GiftWrap)
                    .pubkey(round_keys.public_key()),
            )
            .await
            .map_err(|error| format!("could not subscribe to round messages: {error}"))?;

        let (negotiated, early) = gather_and_agree(
            &mut events,
            &wire,
            &mut pool,
            &clocks,
            core.auto,
            cancel,
            status,
        )
        .await?;
        if negotiated.participants.len() < MIN_SAFE_PLAYERS {
            return Err(format!(
                "Round shrank to {} wallets — refusing a partial fuse; need ≥{MIN_SAFE_PLAYERS}.",
                negotiated.participants.len()
            ));
        }
        status(&format!(
            "Round agreed with {} wallets at {} sats.",
            negotiated.participants.len(),
            negotiated.tier
        ));

        let plan = plan_output_values(
            &inputs
                .iter()
                .map(|input| (input.value, input.pubkey.len()))
                .collect::<Vec<_>>(),
            negotiated.participants.len(),
            P2P_FEERATE,
            DEFAULT_MIN_OUTPUT,
            Some(negotiated.tier),
            random_unit,
        )?;
        let scripts = reserver.reserve(plan.values.len()).await?;
        if scripts.len() != plan.values.len() {
            return Err("the wallet reserved a different number of outputs".into());
        }
        let outputs: Vec<OutputRef> = scripts
            .iter()
            .zip(&plan.values)
            .map(|(script, &value)| OutputRef {
                script: optn_core::payment::hex(script),
                value,
            })
            .collect();
        let contribution = Contribution {
            inputs: inputs.clone(),
            outputs,
        };
        let signer = {
            let mine = contribution.clone();
            let keys = signing_keys.clone();
            let (session, participants, tier) = (
                negotiated.session.clone(),
                negotiated.participants.clone(),
                negotiated.tier,
            );
            Box::new(move |tx: &optn_fusion::p2p::assemble::Assembled| {
                let keys: HashMap<String, [u8; 32]> = keys.iter().cloned().collect();
                let signed = sign_native(
                    tx,
                    &mine,
                    &keys,
                    &SigningRound {
                        network,
                        session: &session,
                        participants: &participants,
                        tier,
                        feerate: P2P_FEERATE,
                    },
                );
                drop(Zeroizing::new(keys.into_values().collect::<Vec<_>>()));
                signed
            })
        };
        let mut round = Round::start(
            RoundParams {
                my_pubkey: me.clone(),
                round_secret: round_keys.secret_key().to_secret_bytes(),
                participants: negotiated.participants.clone(),
                session: negotiated.session.clone(),
                network,
                tier: negotiated.tier,
                feerate: P2P_FEERATE,
                contribution,
                signer,
                timeout_ms: round_timeout_ms(negotiated.participants.len() - 1),
                jitter_ms: COMPONENT_JITTER_MS,
            },
            clocks.now(),
        )?;
        status(if round.is_coordinator() {
            "Coordinating the round…"
        } else {
            "In the round; registering inputs and outputs…"
        });
        let clock = clocks.now();
        for (from, message) in early {
            round.on_message(&from, &message, clock);
        }
        let result = drive_round(
            &mut round,
            &mut events,
            &wire,
            &clocks,
            &broadcaster,
            cancel,
            status,
        )
        .await?;
        Ok(P2pFused { result, scripts })
    }
    .await;

    // Retire the key first, as the desktop does (`retireRoundKey`), so a
    // later gather here drops it even before the withdrawal reaches a relay;
    // not at the start, which would hide one host's concurrent rounds from
    // each other. Let the round's last messages land (closing under them
    // would lose the coordinator's `final`), then withdraw the key so relays
    // stop serving it as a live peer.
    ghosts()
        .lock()
        .expect("ghost registry")
        .own
        .insert(me.clone());
    wire.flush(FLUSH_TIMEOUT).await;
    if let Ok(withdrawal) = pool.announcement(&round_keys, clocks.now().unix, true) {
        wire.announce(withdrawal);
        wire.flush(Duration::from_secs(10)).await;
    }
    relays.shutdown().await;
    outcome
}

/// Run one P2P round for `coins` (display-order `txid:vout`) of the wallet
/// open in `runtime`. `round_id` names the round in the cancellation registry;
/// `status` receives short progress lines.
pub async fn run_p2p_round(
    runtime: &AppRuntime,
    settings: &P2pRoundSettings,
    coins: &[String],
    round_id: &str,
    status: &(dyn Fn(&str) + Send + Sync),
) -> Result<FusedRound, String> {
    let network = pool_network(settings.network)?;
    if settings.lookup_servers.is_empty() {
        return Err("no Electrum server is selected to broadcast and check this round".into());
    }
    let hosts = settings
        .lookup_servers
        .iter()
        .map(|lookup| Some(lookup.host.clone()))
        .chain(settings.relays.iter().map(|relay| relay_host(relay)));
    for host in hosts {
        let host = host.ok_or("a Nostr relay URL names no host")?;
        transport_for(&host, settings.verified_proxy)?;
    }
    optn_fusion::round_cancel::prepare_round(round_id)?;
    let registration = optn_fusion::round_cancel::acquire_round(round_id)?;

    status("Preparing inputs…");
    let mut keys = runtime
        .fusion_input_keys(coins.to_vec())
        .await
        .map_err(runtime_refusal)?;
    keys.sort_by_key(|key| std::cmp::Reverse(key.value_sats));
    keys.truncate(MAX_INPUT_CREDENTIALS_PER_PEER);
    let coins = P2pCoins {
        inputs: keys
            .iter()
            .map(|key| InputRef {
                prev_txid: key.txid.to_ascii_lowercase(),
                prev_index: key.vout,
                value: key.value_sats,
                pubkey: optn_core::payment::hex(&key.pubkey),
            })
            .collect(),
        keys: Zeroizing::new(
            keys.iter()
                .map(|key| (optn_core::payment::hex(&key.pubkey), *key.privkey))
                .collect(),
        ),
    };
    drop(keys);
    let spent: Vec<String> = coins.inputs.iter().map(InputRef::key).collect();
    let lookups = Arc::new(ChainInputLookups::electrum(
        settings.network,
        settings.lookup_servers.clone(),
        settings.verified_proxy,
    ));
    let core = P2pCore {
        network,
        relays: settings.relays.clone(),
        route: RelayRoute::Dialer(Arc::new(FusionRelayDialer {
            proxy: settings.verified_proxy,
        })),
        auto: settings.auto,
    };
    let fused = run_p2p(
        &core,
        coins,
        &RuntimeReserver(runtime),
        lookups.clone(),
        &registration.flag(),
        status,
    )
    .await;
    drop(registration);
    let P2pFused { result, scripts } = fused?;
    let created = wallet_outputs(&result.txid, &result.tx_hex, &scripts)?;
    status("Round complete; waiting for the network to show the transaction…");
    let seen = wait_until_seen(lookups.as_ref(), &result.txid, BROADCAST_WAIT).await;
    Ok(FusedRound {
        txid: result.txid,
        tx_hex: result.tx_hex,
        spent,
        created,
        seen,
    })
}

/// The host of a relay URL, for the Tor rule.
pub fn relay_host(relay: &str) -> Option<String> {
    let rest = relay.split_once("://")?.1;
    let authority = rest.split('/').next()?;
    let host = match authority.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next()?,
        None => authority
            .rsplit_once(':')
            .map_or(authority, |(host, _)| host),
    };
    (!host.is_empty()).then(|| host.to_owned())
}

fn random_unit() -> f64 {
    let mut bytes = [0u8; 8];
    use rand_core::{OsRng, RngCore};
    OsRng.fill_bytes(&mut bytes);
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

type Events<'a> = std::pin::Pin<
    Box<dyn Stream<Item = (optn_nostr::nostr::prelude::SubscriptionId, Event)> + Send + 'a>,
>;

/// Wait for the next relay event or `deadline` (host milliseconds), whichever
/// is first, checking for cancellation at least once a second.
async fn next_delivery(
    events: &mut Events<'_>,
    wire: &Wire,
    clocks: &Clocks,
    deadline: Option<u64>,
) -> Result<Option<Delivery>, String> {
    let now = clocks.now().ms;
    let wait = deadline.map_or(1_000, |due| due.saturating_sub(now).min(1_000));
    tokio::select! {
        next = events.next() => {
            let (_, event) = next.ok_or("the relay connection closed")?;
            Ok(wire.open(event, clocks.now().unix))
        }
        _ = tokio::time::sleep(Duration::from_millis(wait)) => Ok(None),
    }
}

/// Announce, gather the live pool, select the group and agree on a round.
/// Round messages that arrive for the agreed session before the round
/// starts are returned with it.
async fn gather_and_agree(
    events: &mut Events<'_>,
    wire: &Wire,
    pool: &mut PoolView,
    clocks: &Clocks,
    auto: bool,
    cancel: &optn_fusion::round_cancel::CancelFlag,
    status: &(dyn Fn(&str) + Send + Sync),
) -> Result<(Negotiated, Vec<(String, RoundMessage)>), String> {
    let announce = |pool: &PoolView, now_unix: u64| -> Result<(), String> {
        wire.announce(pool.announcement(&wire.keys, now_unix, false)?);
        Ok(())
    };
    announce(pool, clocks.now().unix)?;
    status("Pool announcement published; collecting peers…");
    let mut gather = Gather::new(clocks.now(), auto);
    let reannounce_ms = POOL_REANNOUNCE_SECONDS * 1_000;
    let mut next_announce = clocks.now().ms + reannounce_ms;
    let mut next_poll = clocks.now().ms + GATHER_POLL_MS;
    // Proposals can arrive before this peer finishes gathering.
    let mut early: Vec<(String, RoundMessage)> = Vec::new();
    let peers = loop {
        cancel.check()?;
        let clock = clocks.now();
        if clock.ms >= next_announce {
            announce(pool, clock.unix)?;
            next_announce = clock.ms + reannounce_ms;
        }
        if clock.ms >= next_poll {
            next_poll = clock.ms + GATHER_POLL_MS;
            match gather.poll(pool, clock, auto) {
                GatherStep::Locked(peers) => break peers,
                GatherStep::Failed(reason) => return Err(reason),
                GatherStep::Wait {
                    boost,
                    status: line,
                } => {
                    if boost {
                        announce(pool, clock.unix)?;
                    }
                    status(&line);
                }
            }
        }
        match next_delivery(events, wire, clocks, Some(next_poll.min(next_announce))).await? {
            Some(Delivery::Announcement(event)) => pool.admit(&event, clocks.now().unix),
            Some(Delivery::Message(from, message)) => {
                early.push((from, message));
                early.truncate(256);
            }
            Some(Delivery::Malformed(_)) | None => {}
        }
    };
    let candidates: Vec<GroupPeer> = peers
        .iter()
        .map(|peer| GroupPeer {
            pubkey: peer.pubkey.clone(),
            tiers: peer.tiers.clone(),
            num_inputs: peer.num_inputs,
        })
        .collect();
    let group = select_group(&candidates, MIN_PLAYERS, MAX_PLAYERS)
        .filter(|group| group.participants.contains(&pool.me))
        .ok_or_else(|| {
            format!(
                "No P2P peers found (only {} live wallet(s); need ≥{MIN_PLAYERS} on the same network with Tor and P2P on).",
                peers.len()
            )
        })?;
    status(&format!(
        "Proposing {} wallets at {} sats; waiting for every one to ACK…",
        group.participants.len(),
        group.tier
    ));

    let clock = clocks.now();
    let mut rendezvous = Rendezvous::start(
        &pool.me,
        &group.participants,
        pool.network,
        group.tier,
        pool_epoch(clock.unix),
        RENDEZVOUS_MS,
        clock,
    );
    for (from, message) in &early {
        rendezvous.on_message(from, message, clock);
    }
    let mut buffered: Vec<(String, RoundMessage)> = Vec::new();
    loop {
        for action in rendezvous.take_actions() {
            if let Action::Send { to, message } = action {
                wire.send(&to, &message);
            }
        }
        if let Some(outcome) = rendezvous.outcome() {
            let negotiated = outcome.clone()?;
            let early_round = early
                .into_iter()
                .chain(buffered)
                .filter(|(_, message)| message.session == negotiated.session)
                .collect();
            return Ok((negotiated, early_round));
        }
        cancel
            .check()
            .inspect_err(|_| rendezvous.cancel(clocks.now()))?;
        let clock = clocks.now();
        if clock.ms >= next_announce {
            announce(pool, clock.unix)?;
            next_announce = clock.ms + reannounce_ms;
        }
        let deadline = rendezvous.next_deadline().map(|due| due.min(next_announce));
        match next_delivery(events, wire, clocks, deadline.or(Some(next_announce))).await? {
            Some(Delivery::Message(from, message)) => {
                let clock = clocks.now();
                rendezvous.on_message(&from, &message, clock);
                buffered.push((from, message));
                if buffered.len() > 512 {
                    buffered.remove(0);
                }
            }
            Some(Delivery::Announcement(event)) => pool.admit(&event, clocks.now().unix),
            Some(Delivery::Malformed(_)) | None => {}
        }
        rendezvous.tick(clocks.now());
    }
}

/// Run the round until it settles, performing its actions.
async fn drive_round(
    round: &mut Round,
    events: &mut Events<'_>,
    wire: &Wire,
    clocks: &Clocks,
    broadcaster: &Arc<dyn Broadcaster>,
    cancel: &optn_fusion::round_cancel::CancelFlag,
    status: &(dyn Fn(&str) + Send + Sync),
) -> Result<optn_fusion::p2p::session::RoundResult, String> {
    loop {
        // Performing an action can queue more: a broadcast's outcome queues
        // the coordinator's `final` to every peer and settles the round in the
        // same call. So drain until nothing is left, and only then look at the
        // outcome, or those last messages are never sent.
        loop {
            let actions = round.take_actions();
            if actions.is_empty() {
                break;
            }
            for action in actions {
                perform(action, round, wire, clocks, broadcaster, status).await;
            }
        }
        if let Some(outcome) = round.outcome() {
            return outcome.clone();
        }
        if cancel.is_cancelled() {
            round.cancel(clocks.now());
            continue;
        }
        match next_delivery(events, wire, clocks, round.next_deadline()).await? {
            Some(Delivery::Message(from, message)) => {
                round.on_message(&from, &message, clocks.now())
            }
            Some(Delivery::Malformed(from)) => round.on_protocol_error(
                &from,
                "Invalid or oversized Fusion round message.",
                clocks.now(),
            ),
            Some(Delivery::Announcement(_)) | None => {}
        }
        round.tick(clocks.now());
    }
}

/// Carry out one of the round's actions.
async fn perform(
    action: Action,
    round: &mut Round,
    wire: &Wire,
    clocks: &Clocks,
    broadcaster: &Arc<dyn Broadcaster>,
    status: &(dyn Fn(&str) + Send + Sync),
) {
    match action {
        Action::Send { to, message } => wire.send(&to, &message),
        Action::Broadcast { tx_hex, .. } => {
            status("Broadcasting the CoinJoin over Tor…");
            let result = match optn_core::payment::decode_hex(&tx_hex) {
                Ok(raw) => broadcaster.broadcast(raw).await,
                Err(error) => Err(error),
            };
            round.on_broadcast(result, clocks.now());
        }
        Action::Rebroadcast { tx_hex, after_ms } => {
            let broadcaster = broadcaster.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(after_ms)).await;
                if let Ok(raw) = optn_core::payment::decode_hex(&tx_hex) {
                    let _ = broadcaster.broadcast(raw).await;
                }
            });
        }
        Action::Blame(report) => {
            ghosts()
                .lock()
                .expect("ghost registry")
                .blamed
                .insert(report.accused.clone(), Instant::now());
            status(&format!(
                "Recorded a protocol fault ({:?}); that round key is set aside for this attempt only.",
                report.code
            ));
        }
        Action::Status(line) => status(&line),
        Action::Phase(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn announcement(pubkey: &str, at: u64) -> Announcement {
        Announcement {
            pubkey: pubkey.into(),
            network: PoolNetwork::Chipnet,
            epoch: pool_epoch(at),
            tiers: vec![100_000],
            num_inputs: 1,
            at,
            expires_at: at + 180,
            seen_at: Some(at),
        }
    }

    fn pool_of(peers: usize, at: u64) -> PoolView {
        PoolView {
            network: PoolNetwork::Chipnet,
            me: "00".repeat(32),
            tiers: vec![100_000],
            num_inputs: 1,
            peers: (1..=peers)
                .map(|i| {
                    let key = format!("{i:02x}").repeat(32);
                    (key.clone(), announcement(&key, at))
                })
                .collect(),
        }
    }

    #[test]
    fn gather_locks_a_stable_legal_set_only_after_the_hold() {
        let start = Clock {
            ms: 0,
            unix: 1_800_000_000,
        };
        let mut gather = Gather::new(start, false);
        let pool = pool_of(5, start.unix);
        // Six with self: legal, but must stay stable through the hold.
        assert!(matches!(
            gather.poll(&pool, start, false),
            GatherStep::Wait { .. }
        ));
        let at = |ms: u64| Clock {
            ms,
            unix: start.unix + ms / 1_000,
        };
        assert!(matches!(
            gather.poll(&pool, at(GATHER_MIN_MS), false),
            GatherStep::Wait { .. }
        ));
        let locked = gather.poll(
            &pool_of(5, start.unix + 20),
            at(SMALL_SET_HOLD_MS + 1),
            false,
        );
        match locked {
            GatherStep::Locked(peers) => assert_eq!(peers.len(), 6),
            _ => panic!("a stable set of six locks after the hold"),
        }
    }

    #[test]
    fn a_lone_manual_gather_gives_up_after_its_budget() {
        let start = Clock {
            ms: 0,
            unix: 1_800_000_000,
        };
        let mut gather = Gather::new(start, false);
        let empty = pool_of(0, start.unix);
        assert!(matches!(
            gather.poll(&empty, start, false),
            GatherStep::Wait { .. }
        ));
        let late = Clock {
            ms: GATHER_ALONE_MS,
            unix: start.unix + GATHER_ALONE_MS / 1_000,
        };
        assert!(matches!(
            gather.poll(&empty, late, false),
            GatherStep::Failed(_)
        ));
    }

    #[test]
    fn only_mainnet_and_chipnet_pools_exist() {
        assert_eq!(
            pool_network(Network::Chipnet).unwrap(),
            PoolNetwork::Chipnet
        );
        assert!(pool_network(Network::Testnet4).is_err());
    }
}

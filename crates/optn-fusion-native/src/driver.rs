//! The one CashFusion driver every interface runs: the CLI, the docker lab
//! (which runs the CLI) and the desktop.
//!
//! Everything a wallet decides about fusing lives here, in Rust, once:
//! - which coins join, by `optn_core::fusion::coin_selection` over the
//!   runtime's own record ([`AppRuntime::fusion_candidates`]);
//! - holding them for the round ([`AppRuntime::hold_for_fusion`]), so a send
//!   cannot take them;
//! - the round itself, on a server ([`crate::server_round`]) or peer to peer
//!   ([`crate::p2p_round`]), with keys and fresh outputs from the runtime;
//! - the depth record, moved only by a transaction the network holds;
//! - Auto's timing, from `optn_app::fusion`: cooldown after a fee, retry after
//!   a free failure, idle once every coin is deep enough, and the shared UTC
//!   window P2P peers meet in.
//!
//! An interface supplies only its own I/O through [`FusionHost`]: how it brings
//! the runtime's coins up to date, which holds it keeps outside the runtime,
//! where progress goes, and how a holder stops it.

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};

use optn_app::fusion::{
    ms_until_auto_rendezvous_open, AUTO_FUSION_COOLDOWN_MS, AUTO_FUSION_DEPTH_MET_IDLE_MS,
    AUTO_FUSION_RETRY_MS,
};
use optn_core::fusion::coin_selection::{select_fusion_coins, FusionCoin, FusionTrigger};
use optn_core::fusion::FusionMode;
use optn_runtime::AppRuntime;
use serde_json::{json, Value};

use crate::p2p_round::{run_p2p_round, P2pRoundSettings};
use crate::server_round::{
    run_server_round, runtime_refusal, server_hello, FusedRound, ServerRoundSettings,
};

/// A boxed future an interface returns to the driver.
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What an interface provides. Nothing here decides anything.
///
/// The waits are plain futures, not boxed `Send` ones: whether a driver run
/// can move between threads is then exactly as true as it is for the
/// interface's own I/O. The desktop's is, so it runs the driver as a task; the
/// CLI's sync is not, and it does not need to be.
pub trait FusionHost: Sync {
    /// Bring the runtime's coins up to date for the next round, and return
    /// the wallet it holds ([`AppRuntime`] in every interface).
    fn refresh(&self) -> impl Future<Output = Result<&dyn FusionWallet, String>>;
    /// Coins this interface holds outside the runtime (the desktop's hold
    /// file), display-order `txid:vout`.
    fn held(&self) -> impl Future<Output = Result<BTreeSet<String>, String>>;
    /// A progress event, as a JSON object with an `event` field.
    fn report(&self, event: Value);
    /// Wait `ms`; `false` when the holder stopped meanwhile.
    fn pause(&self, ms: u64) -> impl Future<Output = bool>;
    /// The id a round is about to run under, so the holder can cancel it.
    fn round_started(&self, round_id: &str);
    /// Whether the holder has stopped.
    fn stopped(&self) -> bool;
}

/// What the driver asks of the wallet. [`AppRuntime`] is the one real
/// implementation; the seam exists so the loop that decides when to spend a
/// fee can be tested without a network.
pub trait FusionWallet: Sync {
    /// The depth record, as last saved.
    fn depth(&self) -> optn_core::fusion::depth::FusionDepthBook;
    /// Coins as selection sees them ([`AppRuntime::fusion_candidates`]).
    fn candidates(&self) -> Result<Vec<FusionCoin>, String>;
    /// Hold `outpoints` until the returned value is dropped.
    fn hold(&self, outpoints: &[String]) -> HostFuture<'_, Result<Box<dyn Send>, String>>;
    /// Record a round the network holds.
    fn record(
        &self,
        spent: Vec<String>,
        created: Vec<String>,
        at_ms: u64,
    ) -> HostFuture<'_, Result<(), String>>;
    /// Run one round at `venue` with `coins`. `status` hears short progress
    /// lines, and `phase` each step a P2P round reaches.
    fn fuse<'a>(
        &'a self,
        venue: &'a Venue,
        coins: &'a [String],
        round_id: &'a str,
        status: &'a (dyn Fn(&str) + Send + Sync),
        phase: &'a (dyn Fn(u8) + Send + Sync),
    ) -> HostFuture<'a, Result<FusedRound, String>>;
}

impl FusionWallet for AppRuntime {
    fn depth(&self) -> optn_core::fusion::depth::FusionDepthBook {
        self.fusion_depth()
    }

    fn candidates(&self) -> Result<Vec<FusionCoin>, String> {
        self.fusion_candidates().map_err(runtime_refusal)
    }

    fn hold(&self, outpoints: &[String]) -> HostFuture<'_, Result<Box<dyn Send>, String>> {
        let outpoints = outpoints.to_vec();
        Box::pin(async move {
            self.hold_for_fusion(&outpoints)
                .await
                .map(|hold| Box::new(hold) as Box<dyn Send>)
                .map_err(runtime_refusal)
        })
    }

    fn record(
        &self,
        spent: Vec<String>,
        created: Vec<String>,
        at_ms: u64,
    ) -> HostFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.record_fusion_round(spent, created, at_ms)
                .await
                .map_err(runtime_refusal)
        })
    }

    fn fuse<'a>(
        &'a self,
        venue: &'a Venue,
        coins: &'a [String],
        round_id: &'a str,
        status: &'a (dyn Fn(&str) + Send + Sync),
        phase: &'a (dyn Fn(u8) + Send + Sync),
    ) -> HostFuture<'a, Result<FusedRound, String>> {
        Box::pin(async move {
            match venue {
                Venue::Server(settings) => {
                    run_server_round(self, settings, coins, round_id, status).await
                }
                Venue::Failover(candidates) => {
                    // Chosen before the round asks for a single key, and never
                    // changed once it may have disclosed anything.
                    let settings = ready_server(candidates, status).await?;
                    run_server_round(self, settings, coins, round_id, status).await
                }
                Venue::P2p(settings) => {
                    run_p2p_round(self, settings, coins, round_id, status, phase).await
                }
            }
        })
    }
}

/// Where rounds meet.
pub enum Venue {
    /// One CashFusion server.
    Server(ServerRoundSettings),
    /// The holder's servers in order, the chosen one first: each round runs
    /// on the first that answers with a valid ServerHello.
    Failover(Vec<ServerRoundSettings>),
    P2p(P2pRoundSettings),
}

/// The first of `candidates` ready for a round. A single candidate is taken
/// as it is: its round fetches the ServerHello anyway, and probing first
/// would only add a connection.
async fn ready_server<'a>(
    candidates: &'a [ServerRoundSettings],
    status: &(dyn Fn(&str) + Send + Sync),
) -> Result<&'a ServerRoundSettings, String> {
    match candidates {
        [] => Err("no fusion server selected".into()),
        [only] => Ok(only),
        _ => {
            let mut last = String::new();
            for candidate in candidates {
                match server_hello(candidate).await {
                    Ok(_) => return Ok(candidate),
                    Err(error) => {
                        status(&format!(
                            "{}:{} is not ready ({error}); trying the next server",
                            candidate.server.host, candidate.server.port
                        ));
                        last = error;
                    }
                }
            }
            Err(format!("no configured fusion server is ready: {last}"))
        }
    }
}

impl Venue {
    pub fn mode(&self) -> FusionMode {
        match self {
            Venue::Server(_) | Venue::Failover(_) => FusionMode::Server,
            Venue::P2p(_) => FusionMode::P2p,
        }
    }

    /// The verified Tor proxy the rounds use, if any leg is remote.
    pub fn verified_proxy(&self) -> Option<u16> {
        match self {
            Venue::Server(settings) => settings.verified_proxy,
            Venue::Failover(candidates) => {
                candidates.first().and_then(|first| first.verified_proxy)
            }
            Venue::P2p(settings) => settings.verified_proxy,
        }
    }

    /// Where rounds meet, for progress and results.
    pub fn describe(&self) -> Value {
        match self {
            Venue::Server(settings) => json!({
                "mode": "server",
                "server": format!("{}:{}", settings.server.host, settings.server.port),
            }),
            Venue::Failover(candidates) => json!({
                "mode": "server",
                "server": candidates
                    .first()
                    .map(|first| format!("{}:{}", first.server.host, first.server.port)),
                "servers": candidates
                    .iter()
                    .map(|candidate| format!("{}:{}", candidate.server.host, candidate.server.port))
                    .collect::<Vec<_>>(),
            }),
            Venue::P2p(settings) => json!({"mode": "p2p", "relays": settings.relays}),
        }
    }

    /// Why no choice of `eligible` can fund a tier, when a server can say. A
    /// P2P pool has no server to ask.
    async fn unaffordable_reason(&self, eligible: &[&FusionCoin]) -> Option<String> {
        let settings = match self {
            Venue::Server(settings) => settings,
            Venue::Failover(candidates) => ready_server(candidates, &|_: &str| {}).await.ok()?,
            Venue::P2p(_) => return None,
        };
        let hello = server_hello(settings).await.ok()?;
        let addresses: BTreeSet<&str> = eligible.iter().map(|coin| coin.address.as_str()).collect();
        let values: Vec<u64> = eligible.iter().map(|coin| coin.value_sats).collect();
        optn_fusion::allocate::never_affordable(&hello, addresses.len(), &values)
            .ok()?
            .then(|| {
                format!(
                    "No choice of this wallet's {} eligible coin(s) ({} sats at {} address(es)) can fund a fusion tier on this server; waiting for the wallet to change.",
                    values.len(),
                    values.iter().sum::<u64>(),
                    addresses.len()
                )
            })
    }
}

/// How long and how often to fuse.
#[derive(Debug, Clone, Copy)]
pub struct DriverOptions {
    /// Keep fusing like Auto Fusion, rather than run once.
    pub auto: bool,
    /// Stop after this many completed rounds. Without `auto`, one by default.
    pub rounds: Option<u32>,
    /// Rounds each coin goes through before Auto leaves it alone.
    pub fuse_depth: u32,
}

/// Why the driver stopped with an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverError {
    /// A round run once (not Auto) failed.
    Round(String),
    /// Anything else: the wallet, its record, or the interface.
    Other(String),
}

impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DriverError::Round(message) | DriverError::Other(message) => f.write_str(message),
        }
    }
}

/// What a run of the driver did.
#[derive(Debug, Clone, PartialEq)]
pub struct DriverOutcome {
    /// Each completed round: `txid`, `seen`, `spent`, `created`.
    pub fused: Vec<Value>,
    /// Why it stopped without reaching its round count, if it did.
    pub stopped: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// A round id no other round in this process has used.
fn next_round_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!(
        "fusion-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// After `streak` rounds in a row that missed every tier by the draw: the
/// retry wait doubled each time, up to the idle wait.
fn unaffordable_backoff(streak: u32) -> u64 {
    AUTO_FUSION_RETRY_MS
        .saturating_mul(1u64 << streak.min(16))
        .min(AUTO_FUSION_DEPTH_MET_IDLE_MS)
}

const INTERRUPTED: &str = "interrupted";

/// Fuse the wallet `host` holds open: once, `rounds` times, or as Auto Fusion
/// until the holder stops.
pub async fn run<H: FusionHost>(
    host: &H,
    venue: &Venue,
    options: DriverOptions,
) -> Result<DriverOutcome, DriverError> {
    let trigger = if options.auto {
        FusionTrigger::Auto
    } else {
        FusionTrigger::Manual
    };
    // Without Auto, one round unless more were asked for.
    let wanted = options.rounds.or((!options.auto).then_some(1));
    let mut fused = Vec::new();
    // The eligible coins no choice of which can fund a tier, and how many
    // rounds in a row missed every tier by the draw.
    let mut never_for: Option<Vec<String>> = None;
    let mut unaffordable_streak = 0u32;
    let stop = |fused: Vec<Value>| {
        Ok(DriverOutcome {
            fused,
            stopped: Some(INTERRUPTED.into()),
        })
    };

    loop {
        if host.stopped() {
            return stop(fused);
        }
        // Auto keeps going through a failed refresh -- a sync already running,
        // a source briefly unreachable -- as it does through any free failure.
        let refreshed = match host.refresh().await {
            Ok(wallet) => host.held().await.map(|held| (wallet, held)),
            Err(error) => Err(error),
        };
        let (wallet, held) = match refreshed {
            Ok(refreshed) => refreshed,
            Err(error) if options.auto => {
                host.report(json!({"event": "retry", "error": error, "transient": true}));
                if !host.pause(AUTO_FUSION_RETRY_MS).await {
                    return stop(fused);
                }
                continue;
            }
            Err(error) => return Err(DriverError::Other(error)),
        };
        let book = wallet.depth();
        let mut coins = wallet.candidates().map_err(DriverError::Other)?;
        for coin in &mut coins {
            coin.frozen |= held.contains(&coin.outpoint);
        }
        let selection = select_fusion_coins(
            venue.mode(),
            trigger,
            &coins,
            options.fuse_depth,
            &mut optn_fusion::allocate::os_uniform(),
        )
        .map_err(DriverError::Other)?;
        let eligible: Vec<&FusionCoin> = selection
            .classification
            .iter()
            .flat_map(|split| split.eligible.iter().flat_map(|bucket| bucket.coins.iter()))
            .collect();
        let mut eligible_outpoints: Vec<String> =
            eligible.iter().map(|coin| coin.outpoint.clone()).collect();
        eligible_outpoints.sort();
        if never_for.as_ref() == Some(&eligible_outpoints) {
            match venue.unaffordable_reason(&eligible).await {
                Some(reason) => {
                    host.report(json!({"event": "idle", "reason": reason}));
                    if !host.pause(AUTO_FUSION_DEPTH_MET_IDLE_MS).await {
                        return stop(fused);
                    }
                    continue;
                }
                None => never_for = None,
            }
        } else if never_for.is_some() {
            // The wallet changed: rounds are worth trying again.
            never_for = None;
            unaffordable_streak = 0;
        }
        if selection.selected.is_empty() {
            let outpoints: Vec<String> = coins
                .iter()
                .filter(|coin| !coin.token && !coin.frozen)
                .map(|coin| coin.outpoint.clone())
                .collect();
            let reason = selection.empty_reason.clone().unwrap_or_else(|| {
                optn_core::fusion::depth::depth_met_message(
                    &book.eligibility(&outpoints, options.fuse_depth),
                )
            });
            if !options.auto {
                return Ok(DriverOutcome {
                    fused,
                    stopped: Some(reason),
                });
            }
            host.report(json!({"event": "idle", "reason": reason}));
            if !host.pause(AUTO_FUSION_DEPTH_MET_IDLE_MS).await {
                return stop(fused);
            }
            continue;
        }

        // Auto P2P enters gather only in the open part of the shared UTC
        // window, so independent wallets -- CLI, docker or desktop -- meet.
        if options.auto && venue.mode() == FusionMode::P2p {
            let wait = ms_until_auto_rendezvous_open(now_ms());
            if wait > 0 {
                host.report(json!({"event": "waiting", "reason": "the next P2P rendezvous", "next_in_ms": wait}));
                if !host.pause(wait).await {
                    return stop(fused);
                }
                continue;
            }
        }

        let outpoints: Vec<String> = selection
            .selected
            .iter()
            .map(|coin| coin.outpoint.clone())
            .collect();
        let round_id = next_round_id();
        let mut event = venue.describe();
        event["event"] = json!("round");
        event["coins"] = json!(outpoints.len());
        // Which coins the round holds, so an interface can show them held
        // until `released`. The hold itself is the runtime's.
        event["outpoints"] = json!(outpoints);
        host.report(event);
        host.round_started(&round_id);
        let status = |line: &str| host.report(json!({"event": "status", "message": line}));
        let phase = |step: u8| host.report(json!({"event": "phase", "phase": step}));
        let attempt = match wallet.hold(&outpoints).await {
            // Held for exactly as long as the round runs and its result is
            // recorded; released however it ends.
            Ok(hold) => {
                let attempt = wallet
                    .fuse(venue, &outpoints, &round_id, &status, &phase)
                    .await;
                let recorded = match &attempt {
                    // Only a transaction the network holds moves depth; a
                    // round the network never saw leaves its coins where
                    // they were.
                    Ok(round) if round.seen => wallet
                        .record(round.spent.clone(), round.created.clone(), now_ms())
                        .await
                        .map_err(DriverError::Other),
                    _ => Ok(()),
                };
                drop(hold);
                host.report(json!({"event": "released", "outpoints": outpoints}));
                recorded?;
                attempt
            }
            Err(error) => Err(error),
        };
        if host.stopped() {
            return stop(fused);
        }
        match attempt {
            Ok(round) => {
                unaffordable_streak = 0;
                let result = json!({
                    "txid": round.txid,
                    "seen": round.seen,
                    "spent": round.spent,
                    "created": round.created,
                });
                host.report(json!({"event": "fused", "round": result}));
                fused.push(result);
                if wanted.is_some_and(|wanted| fused.len() as u32 >= wanted) {
                    return Ok(DriverOutcome {
                        fused,
                        stopped: None,
                    });
                }
                if !host.pause(AUTO_FUSION_COOLDOWN_MS).await {
                    return stop(fused);
                }
            }
            Err(error) => {
                if !options.auto {
                    return Err(DriverError::Round(error));
                }
                if optn_fusion::allocate::is_unaffordable(&error) {
                    if let Some(reason) = venue.unaffordable_reason(&eligible).await {
                        never_for = Some(eligible_outpoints.clone());
                        host.report(json!({"event": "idle", "reason": reason}));
                        if !host.pause(AUTO_FUSION_DEPTH_MET_IDLE_MS).await {
                            return stop(fused);
                        }
                        continue;
                    }
                    // Above the floor, but the random output count missed
                    // every tier. Try again, less often each time.
                    unaffordable_streak += 1;
                    let delay = unaffordable_backoff(unaffordable_streak);
                    host.report(
                        json!({"event": "retry", "error": error, "transient": false, "next_in_ms": delay}),
                    );
                    if !host.pause(delay).await {
                        return stop(fused);
                    }
                    continue;
                }
                let transient = optn_app::fusion::is_auto_transient_failure(&error);
                host.report(json!({"event": "retry", "error": error, "transient": transient}));
                if !host.pause(AUTO_FUSION_RETRY_MS).await {
                    return stop(fused);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    /// What the fake wallet saw, in order.
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Call {
        Hold(Vec<String>),
        Fuse(Vec<String>),
        Record(Vec<String>),
        Release(Vec<String>),
    }

    struct Released(Vec<String>, Arc<Mutex<Vec<Call>>>);
    impl Drop for Released {
        fn drop(&mut self) {
            self.1
                .lock()
                .unwrap()
                .push(Call::Release(std::mem::take(&mut self.0)));
        }
    }

    /// A wallet with `coins`, whose rounds answer from `rounds` in turn.
    struct FakeWallet {
        coins: Vec<FusionCoin>,
        rounds: Mutex<Vec<Result<bool, String>>>,
        calls: Arc<Mutex<Vec<Call>>>,
        /// The steps each round reports reaching.
        phases: Vec<u8>,
    }

    fn coin(n: u8, value_sats: u64) -> FusionCoin {
        FusionCoin {
            outpoint: format!("{}:0", format!("{n:02x}").repeat(32)),
            address: format!("bchtest:address{n}"),
            value_sats,
            confirmed: true,
            token: false,
            frozen: false,
            depth: 0,
        }
    }

    impl FakeWallet {
        fn new(coins: Vec<FusionCoin>, rounds: Vec<Result<bool, String>>) -> Self {
            Self {
                coins,
                rounds: Mutex::new(rounds),
                calls: Arc::default(),
                phases: Vec::new(),
            }
        }
        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl FusionWallet for FakeWallet {
        fn depth(&self) -> optn_core::fusion::depth::FusionDepthBook {
            Default::default()
        }
        fn candidates(&self) -> Result<Vec<FusionCoin>, String> {
            Ok(self.coins.clone())
        }
        fn hold(&self, outpoints: &[String]) -> HostFuture<'_, Result<Box<dyn Send>, String>> {
            self.calls
                .lock()
                .unwrap()
                .push(Call::Hold(outpoints.to_vec()));
            let released = Released(outpoints.to_vec(), Arc::clone(&self.calls));
            Box::pin(async move { Ok(Box::new(released) as Box<dyn Send>) })
        }
        fn record(
            &self,
            spent: Vec<String>,
            _created: Vec<String>,
            _at_ms: u64,
        ) -> HostFuture<'_, Result<(), String>> {
            self.calls.lock().unwrap().push(Call::Record(spent));
            Box::pin(async { Ok(()) })
        }
        fn fuse<'a>(
            &'a self,
            _venue: &'a Venue,
            coins: &'a [String],
            _round_id: &'a str,
            _status: &'a (dyn Fn(&str) + Send + Sync),
            phase: &'a (dyn Fn(u8) + Send + Sync),
        ) -> HostFuture<'a, Result<FusedRound, String>> {
            self.calls.lock().unwrap().push(Call::Fuse(coins.to_vec()));
            for step in &self.phases {
                phase(*step);
            }
            let answer = self.rounds.lock().unwrap().remove(0);
            Box::pin(async move {
                answer.map(|seen| FusedRound {
                    txid: "ab".repeat(32),
                    tx_hex: String::new(),
                    spent: coins.to_vec(),
                    created: vec![format!("{}:0", "ab".repeat(32))],
                    seen,
                })
            })
        }
    }

    /// An interface that holds `held`, stops after `pauses` waits, and keeps
    /// every event.
    struct FakeHost<'w> {
        wallet: &'w FakeWallet,
        held: BTreeSet<String>,
        pauses_left: Mutex<u32>,
        stopped: AtomicBool,
        events: Mutex<Vec<Value>>,
    }

    impl<'w> FakeHost<'w> {
        fn new(wallet: &'w FakeWallet, held: &[&str], pauses: u32) -> Self {
            Self {
                wallet,
                held: held.iter().map(|outpoint| outpoint.to_string()).collect(),
                pauses_left: Mutex::new(pauses),
                stopped: AtomicBool::new(false),
                events: Mutex::default(),
            }
        }
        fn kinds(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .map(|event| event["event"].as_str().unwrap().to_owned())
                .collect()
        }
    }

    impl FusionHost for FakeHost<'_> {
        async fn refresh(&self) -> Result<&dyn FusionWallet, String> {
            Ok(self.wallet as &dyn FusionWallet)
        }
        async fn held(&self) -> Result<BTreeSet<String>, String> {
            Ok(self.held.clone())
        }
        fn report(&self, event: Value) {
            self.events.lock().unwrap().push(event);
        }
        async fn pause(&self, _ms: u64) -> bool {
            let mut left = self.pauses_left.lock().unwrap();
            let carry_on = *left > 0;
            *left = left.saturating_sub(1);
            if !carry_on {
                self.stopped.store(true, Ordering::SeqCst);
            }
            carry_on
        }
        fn round_started(&self, _round_id: &str) {}
        fn stopped(&self) -> bool {
            self.stopped.load(Ordering::SeqCst)
        }
    }

    fn p2p() -> Venue {
        Venue::P2p(P2pRoundSettings {
            network: optn_core::network::Network::Chipnet,
            relays: vec!["ws://127.0.0.1:9".into()],
            verified_proxy: None,
            lookup_servers: Vec::new(),
            auto: false,
        })
    }

    const ONCE: DriverOptions = DriverOptions {
        auto: false,
        rounds: None,
        fuse_depth: 3,
    };

    /// A manual round holds its coins for exactly the round, records it once
    /// the network holds it, and lets go after.
    #[tokio::test]
    async fn a_round_holds_its_coins_records_a_seen_result_and_lets_go() {
        let wallet = FakeWallet::new(vec![coin(1, 150_000)], vec![Ok(true)]);
        let host = FakeHost::new(&wallet, &[], 0);
        let outcome = run(&host, &p2p(), ONCE).await.unwrap();
        assert_eq!(outcome.fused.len(), 1);
        assert_eq!(outcome.stopped, None);
        let picked = vec![coin(1, 0).outpoint];
        assert_eq!(
            wallet.calls(),
            [
                Call::Hold(picked.clone()),
                Call::Fuse(picked.clone()),
                Call::Record(picked.clone()),
                Call::Release(picked),
            ]
        );
        assert_eq!(host.kinds(), ["round", "released", "fused"]);
        // The round names the coins it holds, and lets them go by name.
        let events = host.events.lock().unwrap().clone();
        assert_eq!(events[0]["outpoints"], json!([coin(1, 0).outpoint]));
        assert_eq!(events[1]["outpoints"], events[0]["outpoints"]);
    }

    /// The steps a round reaches reach the interface, in order, while the
    /// round holds its coins.
    #[tokio::test]
    async fn a_round_reports_the_steps_it_reaches() {
        let mut wallet = FakeWallet::new(vec![coin(1, 150_000)], vec![Ok(true)]);
        wallet.phases = vec![2, 3, 5, 7];
        let host = FakeHost::new(&wallet, &[], 0);
        run(&host, &p2p(), ONCE).await.unwrap();
        assert_eq!(
            host.kinds(),
            ["round", "phase", "phase", "phase", "phase", "released", "fused"]
        );
        let steps: Vec<Value> = host.events.lock().unwrap()[1..5]
            .iter()
            .map(|event| event["phase"].clone())
            .collect();
        assert_eq!(steps, [json!(2), json!(3), json!(5), json!(7)]);
    }

    /// A round the network never showed moves no depth, and its coins are
    /// still released.
    #[tokio::test]
    async fn an_unseen_round_records_nothing_and_still_lets_go() {
        let wallet = FakeWallet::new(vec![coin(1, 150_000)], vec![Ok(false)]);
        let host = FakeHost::new(&wallet, &[], 0);
        run(&host, &p2p(), ONCE).await.unwrap();
        assert!(!wallet
            .calls()
            .iter()
            .any(|call| matches!(call, Call::Record(_))));
        assert!(matches!(wallet.calls().last(), Some(Call::Release(_))));
    }

    /// A manual round that fails is an error, and its coins are released.
    #[tokio::test]
    async fn a_failed_manual_round_is_an_error_and_lets_go() {
        let wallet = FakeWallet::new(vec![coin(1, 150_000)], vec![Err("no peers".into())]);
        let host = FakeHost::new(&wallet, &[], 0);
        let error = run(&host, &p2p(), ONCE).await.unwrap_err();
        assert_eq!(error, DriverError::Round("no peers".into()));
        assert!(matches!(wallet.calls().last(), Some(Call::Release(_))));
    }

    /// A coin the interface holds -- the desktop's hold file -- never joins.
    #[tokio::test]
    async fn a_coin_the_interface_holds_never_joins() {
        let wallet = FakeWallet::new(vec![coin(1, 150_000), coin(2, 150_000)], vec![Ok(true)]);
        let held = coin(1, 0).outpoint;
        let host = FakeHost::new(&wallet, &[held.as_str()], 0);
        run(&host, &p2p(), ONCE).await.unwrap();
        for call in wallet.calls() {
            if let Call::Hold(coins) | Call::Fuse(coins) = call {
                assert!(!coins.contains(&held), "{coins:?}");
            }
        }
    }

    /// Nothing eligible -- a token coin never fuses: a manual run says why
    /// and spends nothing.
    #[tokio::test]
    async fn with_nothing_to_fuse_a_manual_run_says_why() {
        let mut token = coin(1, 150_000);
        token.token = true;
        let wallet = FakeWallet::new(vec![token], vec![]);
        let host = FakeHost::new(&wallet, &[], 0);
        let outcome = run(&host, &p2p(), ONCE).await.unwrap();
        assert!(outcome.fused.is_empty());
        assert!(outcome.stopped.is_some());
        assert!(wallet.calls().is_empty());
    }

    /// Auto retries a free failure, fuses, and stops when the holder does.
    /// Server timing keeps the shared P2P window out of the test's clock.
    #[tokio::test]
    async fn auto_retries_a_failure_then_fuses_until_stopped() {
        let wallet = FakeWallet::new(
            vec![coin(1, 150_000)],
            vec![Err("no peers".into()), Ok(true)],
        );
        // One pause after the failure, then stop at the cooldown.
        let host = FakeHost::new(&wallet, &[], 1);
        let server = Venue::Server(ServerRoundSettings {
            network: optn_core::network::Network::Chipnet,
            server: crate::server_round::ServerTarget::parse("127.0.0.1:8789").unwrap(),
            verified_proxy: None,
            lookup_servers: Vec::new(),
            wallet_tag: "test".into(),
            join_inactive_timeout: None,
            only_tiers: None,
        });
        let outcome = run(
            &host,
            &server,
            DriverOptions {
                auto: true,
                rounds: None,
                fuse_depth: 3,
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome.fused.len(), 1);
        assert_eq!(outcome.stopped.as_deref(), Some(INTERRUPTED));
        assert_eq!(
            host.kinds(),
            ["round", "released", "retry", "round", "released", "fused"]
        );
        let fuses = wallet
            .calls()
            .iter()
            .filter(|call| matches!(call, Call::Fuse(_)))
            .count();
        assert_eq!(fuses, 2);
    }

    /// An interface whose refresh fails until it doesn't.
    struct FlakyHost<'w> {
        inner: FakeHost<'w>,
        failures_left: Mutex<u32>,
    }

    impl FusionHost for FlakyHost<'_> {
        async fn refresh(&self) -> Result<&dyn FusionWallet, String> {
            let fail = {
                let mut left = self.failures_left.lock().unwrap();
                let fail = *left > 0;
                *left = left.saturating_sub(1);
                fail
            };
            if fail {
                return Err("A chain operation is already running. Please wait.".into());
            }
            self.inner.refresh().await
        }
        async fn held(&self) -> Result<BTreeSet<String>, String> {
            self.inner.held().await
        }
        fn report(&self, event: Value) {
            self.inner.report(event);
        }
        async fn pause(&self, ms: u64) -> bool {
            self.inner.pause(ms).await
        }
        fn round_started(&self, round_id: &str) {
            self.inner.round_started(round_id);
        }
        fn stopped(&self) -> bool {
            self.inner.stopped()
        }
    }

    /// Auto rides out a failed refresh; a single run reports it.
    #[tokio::test]
    async fn auto_rides_out_a_failed_refresh_and_a_single_run_reports_it() {
        let wallet = FakeWallet::new(vec![coin(1, 150_000)], vec![Ok(true)]);
        let flaky = FlakyHost {
            inner: FakeHost::new(&wallet, &[], 1),
            failures_left: Mutex::new(1),
        };
        let auto = DriverOptions {
            auto: true,
            rounds: Some(1),
            fuse_depth: 3,
        };
        let server = Venue::Server(ServerRoundSettings {
            network: optn_core::network::Network::Chipnet,
            server: crate::server_round::ServerTarget::parse("127.0.0.1:8789").unwrap(),
            verified_proxy: None,
            lookup_servers: Vec::new(),
            wallet_tag: "test".into(),
            join_inactive_timeout: None,
            only_tiers: None,
        });
        let outcome = run(&flaky, &server, auto).await.unwrap();
        assert_eq!(outcome.fused.len(), 1);
        assert_eq!(flaky.inner.kinds(), ["retry", "round", "released", "fused"]);

        let once = FlakyHost {
            inner: FakeHost::new(&wallet, &[], 0),
            failures_left: Mutex::new(1),
        };
        assert!(matches!(
            run(&once, &server, ONCE).await,
            Err(DriverError::Other(_))
        ));
    }

    fn server_at(target: &str) -> ServerRoundSettings {
        ServerRoundSettings {
            network: optn_core::network::Network::Chipnet,
            server: crate::server_round::ServerTarget::parse(target).unwrap(),
            verified_proxy: None,
            lookup_servers: Vec::new(),
            wallet_tag: "test".into(),
            join_inactive_timeout: None,
            only_tiers: None,
        }
    }

    /// One server is taken as it is; with several, an unreachable one is
    /// passed over for the next, and none ready is an error that names why.
    #[tokio::test]
    async fn failover_takes_the_first_server_that_answers() {
        let quiet = |_: &str| {};
        let only = [server_at("127.0.0.1:1")];
        assert_eq!(ready_server(&only, &quiet).await.unwrap().server.port, 1);
        assert!(ready_server(&[], &quiet).await.is_err());
        // Port 1 on loopback refuses at once: neither is ready.
        let none = [server_at("127.0.0.1:1"), server_at("127.0.0.1:2")];
        let error = ready_server(&none, &quiet).await.unwrap_err();
        assert!(
            error.contains("no configured fusion server is ready"),
            "{error}"
        );
        let venue = Venue::Failover(none.to_vec());
        assert_eq!(venue.mode(), FusionMode::Server);
        assert_eq!(venue.describe()["servers"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_missed_draw_backs_off_doubling_up_to_the_idle_wait() {
        assert_eq!(unaffordable_backoff(1), AUTO_FUSION_RETRY_MS * 2);
        assert_eq!(unaffordable_backoff(2), AUTO_FUSION_RETRY_MS * 4);
        assert_eq!(unaffordable_backoff(40), AUTO_FUSION_DEPTH_MET_IDLE_MS);
    }

    #[test]
    fn every_round_gets_its_own_id() {
        let first = next_round_id();
        let second = next_round_id();
        assert_ne!(first, second);
        assert!(first.starts_with(&format!("fusion-{}-", std::process::id())));
    }
}

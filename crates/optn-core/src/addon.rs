//! What a third-party add-on is allowed to do.
//!
//! Add-ons are other people's code running inside the wallet, so the boundary
//! is the feature. Two halves hold it up, and both are here because both are
//! decisions rather than drawing.
//!
//! **The sandbox has an opaque origin.** Add-on code runs in an iframe with
//! `sandbox="allow-scripts"` and deliberately *without* `allow-same-origin`,
//! which is what denies it the wallet's DOM, storage and memory. Adding that
//! one token would quietly hand it everything, and nothing would look
//! different, so [`SANDBOX_ATTRIBUTE`] is a constant and
//! [`check_sandbox_attribute`] refuses any attribute string carrying it. This
//! is already stronger than Electron Cash's plugin model, where plugins are
//! same-process Python with full keystore access.
//!
//! **A capability is spent, not merely held.** Declaring a capability in the
//! manifest is permission to ask; each call still passes a per-minute limit
//! scaled by how much the add-on is trusted, and an unknown trust tier falls
//! back to the most restricted one. Every decision — allowed, denied, rate
//! limited — lands in an audit trail, because "the add-on did something
//! strange" is only answerable if the wallet wrote down what it was asked for.
//!
//! There is no clock here. Callers pass the current time in milliseconds, the
//! same way the lock screen and the fusion timers do, so this stays testable
//! and free of I/O.

use crate::error::{CliError, Result};

/// The exact sandbox attribute an add-on frame carries.
///
/// One token, and the one that is missing matters more than the one present:
/// without `allow-same-origin` the frame's origin is opaque, so it can read
/// nothing of the wallet's.
pub const SANDBOX_ATTRIBUTE: &str = "allow-scripts";

/// The token that must never appear in an add-on frame's sandbox attribute.
pub const FORBIDDEN_SANDBOX_TOKEN: &str = "allow-same-origin";

/// Refuse a sandbox attribute that would give the frame a real origin.
///
/// Checked rather than trusted because the failure is silent: an add-on frame
/// with `allow-same-origin` looks and behaves exactly like one without it,
/// right up until the add-on reads the wallet's storage.
pub fn check_sandbox_attribute(attribute: &str) -> Result<()> {
    let normalised = attribute.to_ascii_lowercase();
    if normalised
        .split_whitespace()
        .any(|token| token == FORBIDDEN_SANDBOX_TOKEN)
    {
        return Err(CliError::Usage(format!(
            "an add-on frame must never carry '{FORBIDDEN_SANDBOX_TOKEN}': it would give the \
             frame a real origin and with it the wallet's DOM, storage and memory"
        )));
    }
    if !normalised
        .split_whitespace()
        .any(|token| token == SANDBOX_ATTRIBUTE)
    {
        return Err(CliError::Usage(format!(
            "an add-on frame needs '{SANDBOX_ATTRIBUTE}' to run at all"
        )));
    }
    Ok(())
}

/// Something an add-on can ask the wallet to do.
///
/// A closed set. An add-on cannot invent one, and a request naming anything
/// outside this list is refused before it reaches a handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Capability {
    WalletContextRead,
    WalletAddressesRead,
    UtxoWalletRead,
    UtxoAddressRead,
    UtxoAddressRefresh,
    ChainQuery,
    BcmrTokenRead,
    TokenIndexHoldersRead,
    TxBuild,
    TxAddOutput,
    TxBroadcast,
    ContractsDerive,
    UiConfirm,
    SigningMessageSign,
    SigningSignatureTemplate,
    HttpFetchJson,
}

impl Capability {
    pub const ALL: &'static [Self] = &[
        Self::WalletContextRead,
        Self::WalletAddressesRead,
        Self::UtxoWalletRead,
        Self::UtxoAddressRead,
        Self::UtxoAddressRefresh,
        Self::ChainQuery,
        Self::BcmrTokenRead,
        Self::TokenIndexHoldersRead,
        Self::TxBuild,
        Self::TxAddOutput,
        Self::TxBroadcast,
        Self::ContractsDerive,
        Self::UiConfirm,
        Self::SigningMessageSign,
        Self::SigningSignatureTemplate,
        Self::HttpFetchJson,
    ];

    /// The id a manifest writes.
    pub const fn id(self) -> &'static str {
        match self {
            Self::WalletContextRead => "wallet:context:read",
            Self::WalletAddressesRead => "wallet:addresses:read",
            Self::UtxoWalletRead => "utxo:wallet:read",
            Self::UtxoAddressRead => "utxo:address:read",
            Self::UtxoAddressRefresh => "utxo:address:refresh",
            Self::ChainQuery => "chain:query",
            Self::BcmrTokenRead => "bcmr:token:read",
            Self::TokenIndexHoldersRead => "tokenindex:holders:read",
            Self::TxBuild => "tx:build",
            Self::TxAddOutput => "tx:add_output",
            Self::TxBroadcast => "tx:broadcast",
            Self::ContractsDerive => "contracts:derive",
            Self::UiConfirm => "ui:confirm",
            Self::SigningMessageSign => "signing:message_sign",
            Self::SigningSignatureTemplate => "signing:signature_template",
            Self::HttpFetchJson => "http:fetch_json",
        }
    }

    /// An unknown id is refused rather than ignored, so a manifest asking for
    /// something this wallet has never heard of fails at install time instead
    /// of silently getting nothing.
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|cap| cap.id() == id)
    }

    /// Calls per minute at the `Reviewed` tier.
    ///
    /// The numbers are the shipped ones. They are not uniform because the calls
    /// are not: reading the wallet's context is cheap and constant, while
    /// broadcasting a transaction and signing a message are the two that move
    /// money or produce a signature, and both sit at 20.
    pub const fn base_limit_per_minute(self) -> u32 {
        match self {
            Self::WalletContextRead => 300,
            Self::TxAddOutput => 300,
            Self::WalletAddressesRead
            | Self::UtxoWalletRead
            | Self::UtxoAddressRead
            | Self::ChainQuery
            | Self::BcmrTokenRead
            | Self::ContractsDerive
            | Self::UiConfirm
            | Self::HttpFetchJson => 120,
            Self::TxBuild => 90,
            Self::UtxoAddressRefresh | Self::TokenIndexHoldersRead => 60,
            Self::TxBroadcast | Self::SigningMessageSign | Self::SigningSignatureTemplate => 20,
        }
    }

    /// Whether granting this lets the add-on move money or produce a signature.
    ///
    /// Not a rate-limit concern: it is what a consent prompt has to say plainly
    /// rather than listing an id the reader has to decode.
    pub const fn is_dangerous(self) -> bool {
        matches!(
            self,
            Self::TxBroadcast | Self::SigningMessageSign | Self::SigningSignatureTemplate
        )
    }
}

/// How much an add-on is trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub enum TrustTier {
    /// Sideloaded, or from a registry entry nobody has reviewed. The default,
    /// and the default matters: an unknown tier falls back here rather than to
    /// the middle.
    #[default]
    Restricted,
    /// Reviewed for the registry.
    Reviewed,
    /// Shipped with the wallet.
    Internal,
}

impl TrustTier {
    pub const ALL: &'static [Self] = &[Self::Restricted, Self::Reviewed, Self::Internal];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Restricted => "restricted",
            Self::Reviewed => "reviewed",
            Self::Internal => "internal",
        }
    }

    /// A tier from a manifest.
    ///
    /// Anything unrecognised — including absent — is `Restricted`. A manifest
    /// is written by the add-on's author, so a typo must not promote it.
    pub fn from_id(id: Option<&str>) -> Self {
        match id {
            Some("internal") => Self::Internal,
            Some("reviewed") => Self::Reviewed,
            _ => Self::Restricted,
        }
    }

    /// This tier's per-minute allowance for a capability.
    ///
    /// Halved for restricted, doubled for internal, and never less than one:
    /// a capability that was granted has to be usable at least once, or the
    /// grant was a lie.
    pub const fn limit_for(self, capability: Capability) -> u32 {
        let base = capability.base_limit_per_minute();
        let scaled = match self {
            Self::Internal => base * 2,
            Self::Reviewed => base,
            Self::Restricted => base / 2,
        };
        if scaled == 0 {
            1
        } else {
            scaled
        }
    }
}

/// What an add-on declared it needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddonManifest {
    pub id: String,
    pub tier: TrustTier,
    /// Every capability the add-on may ask for. Anything outside this is
    /// refused however the request arrives.
    pub capabilities: Vec<Capability>,
}

impl AddonManifest {
    pub fn new(id: impl Into<String>, tier: TrustTier, capabilities: Vec<Capability>) -> Self {
        Self {
            id: id.into(),
            tier,
            capabilities,
        }
    }

    pub fn declares(&self, capability: Capability) -> bool {
        self.capabilities.contains(&capability)
    }

    /// Capabilities an app inside this add-on wants that the manifest does not
    /// grant.
    ///
    /// Empty means the app is within its add-on's declared reach. Reported as a
    /// list rather than a yes/no so an install screen can name every one.
    pub fn ungranted<'a>(&self, wanted: &'a [Capability]) -> Vec<&'a Capability> {
        wanted
            .iter()
            .filter(|capability| !self.declares(**capability))
            .collect()
    }
}

/// What happened when an add-on asked for something.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    /// Not in the manifest at all.
    NotDeclared,
    /// Declared, but the user has not consented to it.
    NotGranted,
    /// Declared and granted, but asked for too often.
    RateLimited {
        limit_per_minute: u32,
    },
}

impl Decision {
    pub const fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }

    pub fn reason(self, capability: Capability, addon_id: &str) -> Option<String> {
        match self {
            Self::Allowed => None,
            Self::NotDeclared => Some(format!(
                "'{addon_id}' asked for '{}', which its manifest does not declare",
                capability.id()
            )),
            Self::NotGranted => Some(format!(
                "'{addon_id}' asked for '{}', which you have not allowed",
                capability.id()
            )),
            Self::RateLimited { limit_per_minute } => Some(format!(
                "'{addon_id}' asked for '{}' more than {limit_per_minute} times in a minute",
                capability.id()
            )),
        }
    }
}

/// One line of the audit trail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEntry {
    pub at_ms: u64,
    pub addon_id: String,
    pub capability: Capability,
    pub decision: Decision,
}

/// The window a rate limit is measured over.
const WINDOW_MS: u64 = 60_000;

/// The smallest audit trail worth keeping, whatever a caller asks for.
const MIN_AUDIT_ENTRIES: usize = 50;
/// How many entries are kept by default.
const DEFAULT_AUDIT_ENTRIES: usize = 300;

/// Decides what an add-on may do, and remembers what it asked.
#[derive(Debug, Clone)]
pub struct PolicyEngine {
    manifest: AddonManifest,
    /// What the user consented to. A subset of the manifest: declaring is
    /// asking, granting is answering.
    granted: Vec<Capability>,
    /// Timestamps of recent calls, per capability.
    calls: Vec<(Capability, Vec<u64>)>,
    audit: Vec<AuditEntry>,
    max_audit: usize,
}

impl PolicyEngine {
    pub fn new(manifest: AddonManifest, granted: Vec<Capability>) -> Self {
        Self {
            manifest,
            granted,
            calls: Vec::new(),
            audit: Vec::new(),
            max_audit: DEFAULT_AUDIT_ENTRIES,
        }
    }

    /// Keep a different number of audit entries. Never fewer than 50: a trail
    /// too short to hold the run-up to an incident is not a trail.
    pub fn keeping_audit_entries(mut self, entries: usize) -> Self {
        self.max_audit = entries.max(MIN_AUDIT_ENTRIES);
        self
    }

    pub fn tier(&self) -> TrustTier {
        self.manifest.tier
    }

    /// Decide one request, and record it.
    ///
    /// The order is the policy: declared, then granted, then within its rate.
    /// A capability that was never declared is refused without consulting the
    /// grant list at all, so a grant left over from an older manifest cannot
    /// resurrect a capability the add-on has since dropped.
    pub fn authorize(&mut self, capability: Capability, now_ms: u64) -> Decision {
        let decision = self.decide(capability, now_ms);
        if decision.is_allowed() {
            self.record_call(capability, now_ms);
        }
        self.push_audit(AuditEntry {
            at_ms: now_ms,
            addon_id: self.manifest.id.clone(),
            capability,
            decision,
        });
        decision
    }

    fn decide(&self, capability: Capability, now_ms: u64) -> Decision {
        if !self.manifest.declares(capability) {
            return Decision::NotDeclared;
        }
        if !self.granted.contains(&capability) {
            return Decision::NotGranted;
        }
        let limit = self.manifest.tier.limit_for(capability);
        if self.recent_calls(capability, now_ms) >= limit as usize {
            return Decision::RateLimited {
                limit_per_minute: limit,
            };
        }
        Decision::Allowed
    }

    /// Calls in the last minute. A sliding window, not a bucket that resets on
    /// the minute: a bucket lets an add-on spend its whole allowance twice
    /// across the boundary.
    fn recent_calls(&self, capability: Capability, now_ms: u64) -> usize {
        let floor = now_ms.saturating_sub(WINDOW_MS);
        self.calls
            .iter()
            .find(|(known, _)| *known == capability)
            .map_or(0, |(_, at)| at.iter().filter(|ms| **ms >= floor).count())
    }

    fn record_call(&mut self, capability: Capability, now_ms: u64) {
        let floor = now_ms.saturating_sub(WINDOW_MS);
        match self
            .calls
            .iter_mut()
            .find(|(known, _)| *known == capability)
        {
            Some((_, at)) => {
                at.retain(|ms| *ms >= floor);
                at.push(now_ms);
            }
            None => self.calls.push((capability, vec![now_ms])),
        }
    }

    fn push_audit(&mut self, entry: AuditEntry) {
        self.audit.push(entry);
        if self.audit.len() > self.max_audit {
            let excess = self.audit.len() - self.max_audit;
            self.audit.drain(..excess);
        }
    }

    /// Everything this add-on has asked for, oldest first.
    pub fn audit_trail(&self) -> &[AuditEntry] {
        &self.audit
    }

    /// Every request that was refused.
    pub fn refusals(&self) -> impl Iterator<Item = &AuditEntry> {
        self.audit
            .iter()
            .filter(|entry| !entry.decision.is_allowed())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> AddonManifest {
        AddonManifest::new(
            "com.example.addon",
            TrustTier::Reviewed,
            vec![
                Capability::WalletContextRead,
                Capability::TxBroadcast,
                Capability::HttpFetchJson,
            ],
        )
    }

    #[test]
    fn the_sandbox_never_gets_a_real_origin() {
        // The whole boundary is one absent token. An add-on frame carrying
        // allow-same-origin looks and behaves exactly like one without it,
        // right up to the point where it reads the wallet's storage.
        check_sandbox_attribute(SANDBOX_ATTRIBUTE).expect("the shipped attribute");

        for attempt in [
            "allow-scripts allow-same-origin",
            "allow-same-origin allow-scripts",
            "allow-scripts ALLOW-SAME-ORIGIN",
            "allow-scripts allow-forms allow-same-origin",
        ] {
            let error = check_sandbox_attribute(attempt).expect_err(attempt);
            assert!(
                error.to_string().contains(FORBIDDEN_SANDBOX_TOKEN),
                "{error}"
            );
        }

        // And a frame that cannot run scripts is not an add-on frame either.
        assert!(check_sandbox_attribute("allow-forms").is_err());
        assert!(check_sandbox_attribute("").is_err());
    }

    #[test]
    fn a_capability_must_be_declared_before_it_can_be_granted() {
        // Declared and granted are different questions, asked in that order. A
        // grant left over from an older manifest must not resurrect a
        // capability the add-on has since dropped.
        let mut engine = PolicyEngine::new(
            manifest(),
            vec![Capability::WalletContextRead, Capability::TxBuild],
        );

        assert_eq!(
            engine.authorize(Capability::WalletContextRead, 0),
            Decision::Allowed
        );
        assert_eq!(
            engine.authorize(Capability::TxBuild, 0),
            Decision::NotDeclared,
            "granted, but the manifest no longer asks for it"
        );
        assert_eq!(
            engine.authorize(Capability::HttpFetchJson, 0),
            Decision::NotGranted,
            "declared, but the user has not said yes"
        );
    }

    #[test]
    fn a_refusal_says_which_add_on_asked_for_what() {
        let refused = Decision::NotGranted
            .reason(Capability::TxBroadcast, "com.example.addon")
            .expect("a reason");
        assert!(refused.contains("com.example.addon"), "{refused}");
        assert!(refused.contains("tx:broadcast"), "{refused}");
        // Something that succeeded carries no reason, so a caller cannot show
        // an error for a request that worked.
        assert_eq!(
            Decision::Allowed.reason(Capability::TxBroadcast, "com.example.addon"),
            None
        );
    }

    #[test]
    fn the_rate_window_slides_rather_than_resetting_on_the_minute() {
        // A bucket that resets lets an add-on spend its whole allowance twice
        // across the boundary -- forty broadcasts in two seconds.
        let manifest = AddonManifest::new(
            "com.example.addon",
            TrustTier::Reviewed,
            vec![Capability::TxBroadcast],
        );
        let mut engine = PolicyEngine::new(manifest, vec![Capability::TxBroadcast]);
        let limit = TrustTier::Reviewed.limit_for(Capability::TxBroadcast);
        assert_eq!(limit, 20);

        for call in 0..limit {
            assert_eq!(
                engine.authorize(Capability::TxBroadcast, 1_000 + u64::from(call)),
                Decision::Allowed,
                "call {call} is within the allowance"
            );
        }
        assert_eq!(
            engine.authorize(Capability::TxBroadcast, 1_100),
            Decision::RateLimited {
                limit_per_minute: 20
            }
        );

        // Still refused just before the first call leaves the window, and
        // allowed once it has.
        assert!(!engine
            .authorize(Capability::TxBroadcast, 1_000 + WINDOW_MS - 1)
            .is_allowed());
        assert_eq!(
            engine.authorize(Capability::TxBroadcast, 1_001 + WINDOW_MS),
            Decision::Allowed
        );
    }

    #[test]
    fn trust_scales_the_allowance_and_an_unknown_tier_gets_the_smallest() {
        assert_eq!(TrustTier::Internal.limit_for(Capability::TxBroadcast), 40);
        assert_eq!(TrustTier::Reviewed.limit_for(Capability::TxBroadcast), 20);
        assert_eq!(TrustTier::Restricted.limit_for(Capability::TxBroadcast), 10);

        // A manifest is written by the add-on's author, so a typo must not
        // promote it.
        assert_eq!(TrustTier::from_id(Some("internal")), TrustTier::Internal);
        assert_eq!(TrustTier::from_id(Some("Internal")), TrustTier::Restricted);
        assert_eq!(TrustTier::from_id(Some("trusted")), TrustTier::Restricted);
        assert_eq!(TrustTier::from_id(None), TrustTier::Restricted);
        assert_eq!(TrustTier::default(), TrustTier::Restricted);

        // A granted capability is usable at least once, whatever the maths
        // says, or the grant was a lie.
        for tier in TrustTier::ALL {
            for capability in Capability::ALL {
                assert!(
                    tier.limit_for(*capability) >= 1,
                    "{tier:?} {capability:?} must allow at least one call"
                );
            }
        }
    }

    #[test]
    fn every_capability_round_trips_and_an_invented_one_is_refused() {
        for capability in Capability::ALL {
            assert_eq!(Capability::from_id(capability.id()), Some(*capability));
            assert!(capability.base_limit_per_minute() > 0);
        }
        assert_eq!(Capability::from_id("wallet:seed:read"), None);
        assert_eq!(Capability::from_id(""), None);

        // The three that move money or produce a signature are named, because
        // a consent prompt has to say so rather than print an id.
        let dangerous: Vec<&str> = Capability::ALL
            .iter()
            .filter(|c| c.is_dangerous())
            .map(|c| c.id())
            .collect();
        assert_eq!(
            dangerous,
            vec![
                "tx:broadcast",
                "signing:message_sign",
                "signing:signature_template"
            ]
        );
    }

    #[test]
    fn an_app_cannot_reach_past_the_add_on_that_hosts_it() {
        let manifest = manifest();
        assert!(manifest
            .ungranted(&[Capability::WalletContextRead, Capability::TxBroadcast])
            .is_empty());

        let over_reach =
            manifest.ungranted(&[Capability::TxBroadcast, Capability::SigningMessageSign]);
        assert_eq!(over_reach.len(), 1);
        assert_eq!(*over_reach[0], Capability::SigningMessageSign);
    }

    #[test]
    fn the_audit_trail_holds_what_was_asked_and_stays_bounded() {
        // "The add-on did something strange" is only answerable if the wallet
        // wrote down what it was asked for.
        let mut engine = PolicyEngine::new(manifest(), vec![Capability::WalletContextRead])
            .keeping_audit_entries(4);

        engine.authorize(Capability::WalletContextRead, 10);
        engine.authorize(Capability::HttpFetchJson, 20);
        engine.authorize(Capability::TxBuild, 30);

        assert_eq!(engine.audit_trail().len(), 3);
        assert_eq!(engine.audit_trail()[0].decision, Decision::Allowed);
        assert_eq!(engine.refusals().count(), 2);
        assert!(engine.refusals().all(|entry| !entry.decision.is_allowed()));

        // The floor holds: asking for four keeps fifty, because a trail too
        // short to cover the run-up to an incident is not a trail.
        for at in 40..90 {
            engine.authorize(Capability::WalletContextRead, at);
        }
        assert_eq!(engine.audit_trail().len(), MIN_AUDIT_ENTRIES);
        // And once it is full, the oldest go first.
        let first = engine.audit_trail()[0].at_ms;
        assert!(
            first > 10,
            "the earliest entries are dropped first: {first}"
        );
        assert_eq!(
            engine.audit_trail().last().expect("not empty").at_ms,
            89,
            "the newest is kept"
        );
    }
}

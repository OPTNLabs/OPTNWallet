#![forbid(unsafe_code)]

//! Apple-only capability provider behind `optn-platform`.
//!
//! Invariant:
//! `optn-core` -> `optn-app` -> `optn-runtime` -> `optn-platform`
//!     -> this crate -> Swift adapter -> optional Opal packages.
//!
//! This crate must not depend on `optn-core`, `optn-app`, or `optn-runtime`.
//! Opal packages must not depend on those crates either. Wallet, transaction,
//! PSBT, CashTokens, RPA, signing, Fusion, and application state stay in Rust.
//!
//! Opal is an optional Apple-native reference/oracle. It is not a second
//! wallet. Production seed, private-key, and signing paths must not route
//! through OpalCrypto. CashFusion stays authoritative Rust.

// The Apple capability contract, the differential-testing types and the
// SwiftFulcrum/Electrum routing. Written while this crate did not exist yet,
// so it landed in optn-platform; it belongs here, where the doc above already
// says Apple lives. optn-platform stays provider-agnostic, which is the
// boundary the architecture check exists to keep.
pub mod apple;

use optn_platform::{
    Biometrics, Capability, CapabilityProvider, ContactlessPresentment, NfcIso7816, NfcMessage,
    NfcTagIo, PlatformError, PlatformFuture, PlatformResult, ProviderDescriptor, ProviderKind,
    SecureStorage,
};
use std::sync::Arc;

/// Capacitor iOS shipping minimum, from `ios/App/App.xcodeproj/project.pbxproj`
/// (`IPHONEOS_DEPLOYMENT_TARGET = 14.0`) and `ios/App/Podfile` (`platform :ios, '14.0'`).
pub const OPTN_IOS_DEPLOYMENT_TARGET: &str = "14.0";

/// Authoritative iOS evidence file inside this repository.
pub const OPTN_IOS_DEPLOYMENT_EVIDENCE: &str = "ios/App/App.xcodeproj/project.pbxproj";

/// macOS minimum is not authored in `src-tauri/tauri.conf.json`. Tauri 2.11.5's
/// supported desktop floor is macOS 10.15. Do not raise it to satisfy Opal.
pub const OPTN_MACOS_DEPLOYMENT_TARGET: &str = "10.15";

/// Evidence that OPTN does not author a higher macOS minimum.
pub const OPTN_MACOS_DEPLOYMENT_EVIDENCE: &str =
    "src-tauri/tauri.conf.json (bundle.macOS.minimumSystemVersion unset)";

/// OpalBase `v0.4.1` tag (`606c188fea5a139a178fa38d962c61b80baa3a27`) and current
/// public `develop` manifests both declare these floors.
pub const OPAL_IOS_DEPLOYMENT_TARGET: &str = "26";
pub const OPAL_MACOS_DEPLOYMENT_TARGET: &str = "26";

/// Tagged OpalBase `v0.4.1` uses Swift tools 6.2. Public `develop` (inspected
/// 2026-09-03) uses Swift tools 6.4. Either way, this is newer than OPTN's
/// shipping iOS 14.0 / Tauri macOS 10.15 surfaces.
pub const OPAL_SWIFT_TOOLS_TAGGED: &str = "6.2";
pub const OPAL_SWIFT_TOOLS_DEVELOP: &str = "6.4";

/// Reviewed SemVer tags. Do not follow moving `develop` in release Apple builds.
pub const OPAL_BASE_PIN: &str = "v0.4.1";
pub const OPAL_BASE_PIN_SHA: &str = "606c188fea5a139a178fa38d962c61b80baa3a27";
pub const SWIFT_FULCRUM_PIN: &str = "v0.8.0";
pub const SWIFT_FULCRUM_PIN_SHA: &str = "611a53f2047660e0dd221f75526ce11335be901a";
pub const OPAL_CRYPTO_PIN: &str = "v0.2.0";
pub const OPAL_CRYPTO_PIN_SHA: &str = "9903d6fc6fb90f2a4e8e8a27319db9e2049ae5af";
pub const OPAL_FUSION_PIN: &str = "v0.1.0";
pub const OPAL_FUSION_PIN_SHA: &str = "808635ae5db8dcd5abfdbc83347099d6c751d405";
pub const OPAL_HEDGE_PIN: &str = "v0.1.0";
pub const OPAL_HEDGE_PIN_SHA: &str = "4abb1d4481d7026c1616563a2e4aab12b434d0f4";

/// Why Opal cannot be the default Apple provider on OPTN shipping surfaces.
pub fn opal_shipping_incompatibility_evidence() -> String {
    format!(
        "Opal is blocked on OPTN shipping Apple surfaces: OPTN iOS {} ({}) and macOS {} ({}) vs Opal iOS {} / macOS {} (OpalBase {} @ {}, Swift tools {} tagged / {} develop). Raising OPTN minimums to match Opal is forbidden.",
        OPTN_IOS_DEPLOYMENT_TARGET,
        OPTN_IOS_DEPLOYMENT_EVIDENCE,
        OPTN_MACOS_DEPLOYMENT_TARGET,
        OPTN_MACOS_DEPLOYMENT_EVIDENCE,
        OPAL_IOS_DEPLOYMENT_TARGET,
        OPAL_MACOS_DEPLOYMENT_TARGET,
        OPAL_BASE_PIN,
        OPAL_BASE_PIN_SHA,
        OPAL_SWIFT_TOOLS_TAGGED,
        OPAL_SWIFT_TOOLS_DEVELOP,
    )
}

/// Supply-chain fact: OpalBase `v0.4.1` `Package.swift` still depends on sibling
/// packages with `branch: "develop"` and records revisions in `Package.resolved`.
/// OPTN must pin exact revisions/tags and must not track moving `develop`.
pub const OPAL_BASE_TRACKS_DEVELOP: &str = "OpalBase v0.4.1 Package.swift depends on SwiftFulcrum, OpalCrypto, OpalFusion, OpalHedge, and OpalDiagnostics via branch: \"develop\". OPTN release Apple builds must pin exact tags/revisions instead.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpalFlavorStatus {
    /// Shipping iOS 14 / current macOS app must not link Opal.
    BlockedForShipping { evidence: String },
    /// Separate iOS 26 / macOS 26 flavor may use reviewed Opal packages as
    /// oracles/diagnostics, never as the wallet authority.
    IsolatedCompatibleOsFlavor,
}

impl OpalFlavorStatus {
    pub fn shipping() -> Self {
        Self::BlockedForShipping {
            evidence: opal_shipping_incompatibility_evidence(),
        }
    }
}

/// Typed native session implemented by the Swift adapter.
///
/// No JSON command bags, no stringly-typed operations, and no SwiftUI / Tauri /
/// Leptos / Opal / Apple framework types in this surface.
pub trait AppleNativeSession: Send + Sync {
    fn secure_get(&self, key: &str) -> PlatformResult<Option<Vec<u8>>>;
    fn secure_set(&self, key: &str, value: &[u8]) -> PlatformResult<()>;
    fn secure_delete(&self, key: &str) -> PlatformResult<()>;
    fn authenticate(&self, reason: &str) -> PlatformResult<()>;
    fn nfc_read(&self) -> PlatformResult<NfcMessage>;
    fn nfc_write(&self, message: &NfcMessage) -> PlatformResult<()>;
    fn iso7816_transceive(&self, command_apdu: &[u8]) -> PlatformResult<Vec<u8>>;
    fn present_contactless(&self, credential_id: &str) -> PlatformResult<()>;
}

/// Default session before the Swift adapter registers. Honest unavailability.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableAppleSession;

impl AppleNativeSession for UnavailableAppleSession {
    fn secure_get(&self, _key: &str) -> PlatformResult<Option<Vec<u8>>> {
        Err(PlatformError::Unavailable)
    }
    fn secure_set(&self, _key: &str, _value: &[u8]) -> PlatformResult<()> {
        Err(PlatformError::Unavailable)
    }
    fn secure_delete(&self, _key: &str) -> PlatformResult<()> {
        Err(PlatformError::Unavailable)
    }
    fn authenticate(&self, _reason: &str) -> PlatformResult<()> {
        Err(PlatformError::Unavailable)
    }
    fn nfc_read(&self) -> PlatformResult<NfcMessage> {
        Err(PlatformError::Unavailable)
    }
    fn nfc_write(&self, _message: &NfcMessage) -> PlatformResult<()> {
        Err(PlatformError::Unavailable)
    }
    fn iso7816_transceive(&self, _command_apdu: &[u8]) -> PlatformResult<Vec<u8>> {
        Err(PlatformError::Unavailable)
    }
    fn present_contactless(&self, _credential_id: &str) -> PlatformResult<()> {
        Err(PlatformError::Unavailable)
    }
}

/// NativeFfi Apple provider selected by the Apple host.
///
/// NFC protocol/state stays in Rust. Swift owns CoreNFC. Contactless
/// presentment is Apple NFC & SE Platform (entitlement/agreement), not
/// merchant Tap to Pay / ProximityReader.
pub struct ApplePlatformProvider {
    session: Arc<dyn AppleNativeSession>,
    opal: OpalFlavorStatus,
}

impl ApplePlatformProvider {
    pub fn new() -> Self {
        Self::with_session(Arc::new(UnavailableAppleSession))
    }

    pub fn with_session(session: Arc<dyn AppleNativeSession>) -> Self {
        Self {
            session,
            opal: OpalFlavorStatus::shipping(),
        }
    }

    pub fn opal_status(&self) -> &OpalFlavorStatus {
        &self.opal
    }

    pub fn isolate_opal_compatible_os_flavor(&mut self) {
        self.opal = OpalFlavorStatus::IsolatedCompatibleOsFlavor;
    }
}

impl Default for ApplePlatformProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl CapabilityProvider for ApplePlatformProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: "apple-native-ffi",
            kind: ProviderKind::NativeFfi,
            capabilities: &[
                Capability::SecureStorage,
                Capability::Biometrics,
                Capability::NfcTagIo,
                Capability::NfcIso7816,
                Capability::ContactlessPresentment,
            ],
        }
    }
}

impl SecureStorage for ApplePlatformProvider {
    fn get<'a>(&'a self, key: &'a str) -> PlatformFuture<'a, Option<Vec<u8>>> {
        let session = Arc::clone(&self.session);
        let key = key.to_owned();
        Box::pin(async move { session.secure_get(&key) })
    }

    fn set<'a>(&'a self, key: &'a str, value: &'a [u8]) -> PlatformFuture<'a, ()> {
        let session = Arc::clone(&self.session);
        let key = key.to_owned();
        let value = value.to_vec();
        Box::pin(async move { session.secure_set(&key, &value) })
    }

    fn delete<'a>(&'a self, key: &'a str) -> PlatformFuture<'a, ()> {
        let session = Arc::clone(&self.session);
        let key = key.to_owned();
        Box::pin(async move { session.secure_delete(&key) })
    }
}

impl Biometrics for ApplePlatformProvider {
    fn authenticate<'a>(&'a self, reason: &'a str) -> PlatformFuture<'a, ()> {
        let session = Arc::clone(&self.session);
        let reason = reason.to_owned();
        Box::pin(async move { session.authenticate(&reason) })
    }
}

impl NfcTagIo for ApplePlatformProvider {
    fn read<'a>(&'a self) -> PlatformFuture<'a, NfcMessage> {
        let session = Arc::clone(&self.session);
        Box::pin(async move { session.nfc_read() })
    }

    fn write<'a>(&'a self, message: &'a NfcMessage) -> PlatformFuture<'a, ()> {
        let session = Arc::clone(&self.session);
        let message = message.clone();
        Box::pin(async move { session.nfc_write(&message) })
    }
}

impl NfcIso7816 for ApplePlatformProvider {
    fn transceive<'a>(&'a self, command_apdu: &'a [u8]) -> PlatformFuture<'a, Vec<u8>> {
        let session = Arc::clone(&self.session);
        let command = command_apdu.to_vec();
        Box::pin(async move { session.iso7816_transceive(&command) })
    }
}

impl ContactlessPresentment for ApplePlatformProvider {
    fn present<'a>(&'a self, credential_id: &'a str) -> PlatformFuture<'a, ()> {
        let session = Arc::clone(&self.session);
        let credential_id = credential_id.to_owned();
        Box::pin(async move { session.present_contactless(&credential_id) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_platform::{NfcTechnology, PlatformError};
    use std::future::Future;

    fn ready<T>(fut: PlatformFuture<'_, T>) -> PlatformResult<T> {
        let mut fut = std::pin::pin!(fut);
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        match fut.as_mut().poll(&mut cx) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("apple provider futures must be ready in tests"),
        }
    }

    struct RecordingSession;

    impl AppleNativeSession for RecordingSession {
        fn secure_get(&self, key: &str) -> PlatformResult<Option<Vec<u8>>> {
            if key == "missing" {
                Ok(None)
            } else {
                Ok(Some(key.as_bytes().to_vec()))
            }
        }
        fn secure_set(&self, _key: &str, _value: &[u8]) -> PlatformResult<()> {
            Ok(())
        }
        fn secure_delete(&self, _key: &str) -> PlatformResult<()> {
            Ok(())
        }
        fn authenticate(&self, reason: &str) -> PlatformResult<()> {
            if reason.is_empty() {
                Err(PlatformError::InvalidData("empty biometric reason".into()))
            } else {
                Ok(())
            }
        }
        fn nfc_read(&self) -> PlatformResult<NfcMessage> {
            Ok(NfcMessage {
                technology: NfcTechnology::Ndef,
                payload: b"ndef".to_vec(),
            })
        }
        fn nfc_write(&self, message: &NfcMessage) -> PlatformResult<()> {
            if message.payload.is_empty() {
                Err(PlatformError::InvalidData("empty NFC payload".into()))
            } else {
                Ok(())
            }
        }
        fn iso7816_transceive(&self, command_apdu: &[u8]) -> PlatformResult<Vec<u8>> {
            let mut response = command_apdu.to_vec();
            response.extend_from_slice(&[0x90, 0x00]);
            Ok(response)
        }
        fn present_contactless(&self, credential_id: &str) -> PlatformResult<()> {
            if credential_id.is_empty() {
                Err(PlatformError::PermissionDenied)
            } else {
                Err(PlatformError::Unavailable)
            }
        }
    }

    #[test]
    fn shipping_opal_flavor_is_blocked_with_exact_version_evidence() {
        let provider = ApplePlatformProvider::new();
        match provider.opal_status() {
            OpalFlavorStatus::BlockedForShipping { evidence } => {
                assert!(evidence.contains(OPTN_IOS_DEPLOYMENT_TARGET), "{evidence}");
                assert!(
                    evidence.contains(OPTN_IOS_DEPLOYMENT_EVIDENCE),
                    "{evidence}"
                );
                assert!(evidence.contains("26"), "{evidence}");
                assert!(evidence.contains(OPAL_BASE_PIN), "{evidence}");
                assert!(
                    evidence.contains("forbidden") || evidence.contains("Raising"),
                    "{evidence}"
                );
            }
            other => panic!("shipping provider must block Opal, got {other:?}"),
        }
        assert!(opal_shipping_incompatibility_evidence().contains("14.0"));
        assert!(OPAL_BASE_TRACKS_DEVELOP.contains("develop"));
    }

    #[test]
    fn compatible_os_flavor_stays_isolated_from_shipping() {
        let mut provider = ApplePlatformProvider::new();
        provider.isolate_opal_compatible_os_flavor();
        assert_eq!(
            *provider.opal_status(),
            OpalFlavorStatus::IsolatedCompatibleOsFlavor
        );
    }

    #[test]
    fn descriptor_is_native_ffi_and_does_not_claim_wallet_authority() {
        let descriptor = ApplePlatformProvider::new().descriptor();
        assert_eq!(descriptor.id, "apple-native-ffi");
        assert_eq!(descriptor.kind, ProviderKind::NativeFfi);
        assert_eq!(
            descriptor.capabilities,
            &[
                Capability::SecureStorage,
                Capability::Biometrics,
                Capability::NfcTagIo,
                Capability::NfcIso7816,
                Capability::ContactlessPresentment,
            ]
        );
    }

    #[test]
    fn unregistered_session_is_unavailable_rather_than_a_fake_success() {
        let provider = ApplePlatformProvider::new();
        assert_eq!(ready(provider.get("k")), Err(PlatformError::Unavailable));
        assert_eq!(
            ready(provider.set("k", b"v")),
            Err(PlatformError::Unavailable)
        );
        assert_eq!(ready(provider.delete("k")), Err(PlatformError::Unavailable));
        assert_eq!(
            ready(provider.authenticate("unlock")),
            Err(PlatformError::Unavailable)
        );
        assert_eq!(ready(provider.read()), Err(PlatformError::Unavailable));
        assert_eq!(
            ready(provider.transceive(&[0x00])),
            Err(PlatformError::Unavailable)
        );
        assert_eq!(
            ready(provider.present("cred")),
            Err(PlatformError::Unavailable)
        );
    }

    #[test]
    fn registered_session_uses_typed_values_not_json_bags() {
        let provider = ApplePlatformProvider::with_session(Arc::new(RecordingSession));
        assert_eq!(ready(provider.get("missing")), Ok(None));
        assert_eq!(ready(provider.get("pin")), Ok(Some(b"pin".to_vec())));
        assert_eq!(ready(provider.set("pin", b"1")), Ok(()));
        assert_eq!(ready(provider.authenticate("sign in")), Ok(()));
        let message = ready(provider.read()).expect("nfc read");
        assert_eq!(message.technology, NfcTechnology::Ndef);
        assert_eq!(message.payload, b"ndef");
        assert_eq!(
            ready(provider.transceive(&[0xe0, 0x40])),
            Ok(vec![0xe0, 0x40, 0x90, 0x00])
        );
        assert_eq!(
            ready(provider.present("wallet-credential")),
            Err(PlatformError::Unavailable),
            "presentment stays unavailable without Apple NFC & SE entitlement"
        );
    }

    #[test]
    fn canonical_cashaddr_vector_is_public_spec_material() {
        let raw = include_str!("../../../test-vectors/bch-oracle-cashaddr.json");
        assert!(raw.contains("bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a"));
        assert!(raw.contains("bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvqcw003ap"));
        assert!(!raw.to_lowercase().contains("mnemonic"));
        assert!(!raw.to_lowercase().contains("xprv"));
    }

    #[test]
    fn cargo_toml_does_not_depend_on_core_app_or_runtime() {
        let manifest = include_str!("../Cargo.toml");
        for forbidden in [
            "optn-core",
            "optn-app",
            "optn-runtime",
            "optn-ui",
            "leptos",
            "tauri",
            "dioxus",
            "capacitor",
        ] {
            assert!(
                !manifest.contains(forbidden),
                "optn-platform-apple must not depend on {forbidden}"
            );
        }
        assert!(manifest.contains("optn-platform"));
    }
}

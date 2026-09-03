//! The Apple provider boundary.
//!
//! macOS and iOS can do things a generic shell plugin does either awkwardly or
//! unsafely — Secure Enclave keys, Keychain access control, OSLog-backed
//! diagnostics. Those are reached through this contract, implemented by a
//! Swift adapter, optionally on top of the 58 Opals packages.
//!
//! What this boundary is **not**: a second wallet. Rust stays the single
//! authoritative implementation of BCH truth — transactions, PSBT, CashTokens,
//! RPA, signing policy, CashFusion, application state. Nothing here returns a
//! wallet decision; it returns a platform capability result. An Opal type must
//! never appear above this line, and `xtask architecture` fails the build if
//! one reaches `optn-core`, `optn-app` or `optn-runtime`.
//!
//! Requests and results are typed for the same reason: a JSON command bag
//! across an FFI boundary turns every protocol mistake into a runtime string
//! error instead of a compile error.
//!
//! ## Why nothing is wired up yet
//!
//! Verified against upstream on 2026-09-03:
//!
//! | Package | Tag | Platforms | Note |
//! | --- | --- | --- | --- |
//! | OpalBase | v0.4.1 | macOS 26 / iOS 26 | developer preview; depends on five siblings by `branch: "develop"` |
//! | SwiftFulcrum | v0.8.0 | macOS 26 / iOS 26 | most mature; depends on OpalDiagnostics by SemVer |
//! | OpalCrypto | v0.2.0 | macOS 26 / iOS 26 | "do not use this preview for production key handling" |
//! | OpalFusion | v0.1.0 | macOS 26 / iOS 26 | initial scaffold |
//! | OpalDiagnostics | v0.2.0 | macOS 26 / iOS 26 | |
//!
//! OPTN's iOS deployment target is **14.0** (`ios/App/App.xcodeproj`), so
//! adopting any of them today would raise the product minimum by twelve major
//! versions. That is a product decision, not an implementation detail, so the
//! contract exists and stays unimplemented rather than the minimum being
//! quietly raised.

use crate::{PlatformFuture, PlatformResult};

/// Which Apple capability an adapter provides.
///
/// Named by capability rather than by package: the point of the boundary is
/// that a native implementation and an Opal-backed one are interchangeable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AppleCapability {
    /// Hardware-backed key storage (Secure Enclave).
    SecureEnclave,
    /// Keychain items with access control.
    Keychain,
    /// OSLog-backed structured diagnostics.
    Diagnostics,
    /// Fulcrum connectivity used as a reference/conformance implementation,
    /// never as an independent wallet state model.
    FulcrumReference,
}

impl AppleCapability {
    pub const ALL: &'static [Self] = &[
        Self::SecureEnclave,
        Self::Keychain,
        Self::Diagnostics,
        Self::FulcrumReference,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::SecureEnclave => "secure-enclave",
            Self::Keychain => "keychain",
            Self::Diagnostics => "diagnostics",
            Self::FulcrumReference => "fulcrum-reference",
        }
    }
}

/// Where an Apple capability is implemented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppleBacking {
    /// Apple frameworks directly.
    NativeApple,
    /// A 58 Opals package.
    Opal,
}

/// Minimum OS an adapter needs, so a caller can refuse before it calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct OsVersion {
    pub major: u32,
    pub minor: u32,
}

impl OsVersion {
    pub const fn new(major: u32, minor: u32) -> Self {
        Self { major, minor }
    }
}

/// What an Apple adapter says about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleProviderDescriptor {
    pub id: &'static str,
    pub backing: AppleBacking,
    pub capabilities: &'static [AppleCapability],
    /// Lowest macOS this adapter runs on.
    pub minimum_macos: OsVersion,
    /// Lowest iOS this adapter runs on.
    pub minimum_ios: OsVersion,
    /// True when every dependency is pinned to a reviewed release.
    ///
    /// False means some dependency floats on a branch, so two builds of the
    /// same commit can differ. A release build must refuse those.
    pub reproducible: bool,
}

/// Why a capability is unavailable. Each needs a different fix, so they are
/// distinct rather than one error string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppleUnavailable {
    /// This build has no adapter at all.
    NoProvider,
    /// The adapter exists but the OS is older than it needs.
    OsTooOld {
        required: OsVersion,
        running: OsVersion,
    },
    /// The adapter does not offer this capability.
    CapabilityMissing(AppleCapability),
    /// The adapter's dependencies are not pinned, so a release build refuses.
    NotReproducible,
}

/// An Apple-side capability provider.
///
/// Deliberately narrow: no method here decides anything about a wallet.
pub trait AppleProvider {
    fn descriptor(&self) -> AppleProviderDescriptor;

    /// Whether this capability can be used on a given OS, and why not.
    fn availability(
        &self,
        capability: AppleCapability,
        running_macos: OsVersion,
        require_reproducible: bool,
    ) -> Result<(), AppleUnavailable> {
        let descriptor = self.descriptor();
        if !descriptor.capabilities.contains(&capability) {
            return Err(AppleUnavailable::CapabilityMissing(capability));
        }
        if require_reproducible && !descriptor.reproducible {
            return Err(AppleUnavailable::NotReproducible);
        }
        if running_macos < descriptor.minimum_macos {
            return Err(AppleUnavailable::OsTooOld {
                required: descriptor.minimum_macos,
                running: running_macos,
            });
        }
        Ok(())
    }

    /// Emit a diagnostic event through the platform logger.
    ///
    /// Takes a category and message rather than a formatted line so the host
    /// can route by category and redact per its own policy.
    fn log_event<'a>(&'a self, category: &'a str, message: &'a str) -> PlatformFuture<'a, ()>;
}

/// Which BCH behaviours an independent implementation may be checked against.
///
/// Only deterministic, public-material behaviour appears here. Signing and
/// anything touching a secret scalar is absent on purpose: OpalCrypto states
/// that secret-scalar operations have not completed constant-time hardening or
/// security review, so it must not see production key material — and a
/// differential test that needed a secret would be exactly that.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ReferenceVector {
    CashAddr,
    PublicDerivation,
    AccountXpub,
    TransactionSerialization,
    Sighash,
    CashTokenEncoding,
    FulcrumResponseParsing,
}

impl ReferenceVector {
    /// Behaviours safe to check against an independent implementation.
    pub const ALL: &'static [Self] = &[
        Self::CashAddr,
        Self::PublicDerivation,
        Self::AccountXpub,
        Self::TransactionSerialization,
        Self::Sighash,
        Self::CashTokenEncoding,
        Self::FulcrumResponseParsing,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::CashAddr => "cashaddr",
            Self::PublicDerivation => "public-derivation",
            Self::AccountXpub => "account-xpub",
            Self::TransactionSerialization => "transaction-serialization",
            Self::Sighash => "sighash",
            Self::CashTokenEncoding => "cashtoken-encoding",
            Self::FulcrumResponseParsing => "fulcrum-response-parsing",
        }
    }

    /// Whether the behaviour requires a secret to exercise.
    ///
    /// Always false for everything offered. A differential test must never be
    /// the reason a preview crypto library sees a private key.
    pub const fn needs_secret_material(self) -> bool {
        false
    }
}

/// Outcome of checking one vector across implementations.
///
/// Both sides are compared to the canonical vector as well as to each other,
/// because two implementations can share a wrong assumption and agreeing
/// proves nothing on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DifferentialOutcome {
    pub vector: ReferenceVector,
    pub rust_matches_canonical: bool,
    pub reference_matches_canonical: bool,
    pub implementations_agree: bool,
}

impl DifferentialOutcome {
    /// A vector passes only when both sides match the canonical result.
    pub const fn passed(&self) -> bool {
        self.rust_matches_canonical
            && self.reference_matches_canonical
            && self.implementations_agree
    }

    /// Agreement with no canonical anchor. Not a pass — it is the shape a
    /// shared wrong assumption takes.
    pub const fn agrees_but_unanchored(&self) -> bool {
        self.implementations_agree && !self.rust_matches_canonical
    }
}

/// An adapter that can run a reference vector, for conformance testing only.
pub trait ReferenceImplementation {
    fn supported_vectors(&self) -> &'static [ReferenceVector];

    /// Run one vector and return the reference implementation's output.
    fn evaluate<'a>(
        &'a self,
        vector: ReferenceVector,
        input: &'a str,
    ) -> PlatformFuture<'a, String>;
}

/// A provider for builds with no Apple adapter, which is every non-Apple host
/// and, today, Apple too.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableAppleProvider;

impl AppleProvider for UnavailableAppleProvider {
    fn descriptor(&self) -> AppleProviderDescriptor {
        AppleProviderDescriptor {
            id: "apple-unavailable",
            backing: AppleBacking::NativeApple,
            capabilities: &[],
            // Never satisfiable, so availability() always refuses.
            minimum_macos: OsVersion::new(u32::MAX, 0),
            minimum_ios: OsVersion::new(u32::MAX, 0),
            reproducible: true,
        }
    }

    fn log_event<'a>(&'a self, _category: &'a str, _message: &'a str) -> PlatformFuture<'a, ()> {
        Box::pin(async { PlatformResult::Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for a Swift adapter built on the current Opal packages.
    struct OpalPreviewProvider;

    impl AppleProvider for OpalPreviewProvider {
        fn descriptor(&self) -> AppleProviderDescriptor {
            AppleProviderDescriptor {
                id: "opal-preview",
                backing: AppleBacking::Opal,
                capabilities: &[
                    AppleCapability::Diagnostics,
                    AppleCapability::FulcrumReference,
                ],
                // Verified from the upstream manifests, not assumed.
                minimum_macos: OsVersion::new(26, 0),
                minimum_ios: OsVersion::new(26, 0),
                // OpalBase pulls five siblings by `branch: "develop"`.
                reproducible: false,
            }
        }

        fn log_event<'a>(
            &'a self,
            _category: &'a str,
            _message: &'a str,
        ) -> PlatformFuture<'a, ()> {
            Box::pin(async { PlatformResult::Ok(()) })
        }
    }

    #[test]
    fn an_opal_backed_provider_is_refused_below_its_minimum_os() {
        // OPTN targets iOS 14; Opal requires 26. The boundary says so before
        // anything calls it, instead of the product minimum being raised.
        let provider = OpalPreviewProvider;
        let verdict =
            provider.availability(AppleCapability::Diagnostics, OsVersion::new(14, 0), false);
        assert_eq!(
            verdict,
            Err(AppleUnavailable::OsTooOld {
                required: OsVersion::new(26, 0),
                running: OsVersion::new(14, 0),
            })
        );

        // On a new enough OS the capability is available for a debug build.
        assert!(provider
            .availability(AppleCapability::Diagnostics, OsVersion::new(26, 0), false)
            .is_ok());
    }

    #[test]
    fn a_release_build_refuses_a_provider_whose_dependencies_float() {
        // OpalBase depends on SwiftFulcrum, OpalCrypto, OpalFusion, OpalHedge
        // and OpalDiagnostics by `branch: "develop"`, so two builds of the
        // same commit can differ. Pinning OpalBase to a tag does not fix it.
        let provider = OpalPreviewProvider;
        assert_eq!(
            provider.availability(AppleCapability::Diagnostics, OsVersion::new(26, 0), true),
            Err(AppleUnavailable::NotReproducible)
        );
    }

    #[test]
    fn a_capability_the_adapter_lacks_is_named_not_guessed() {
        let provider = OpalPreviewProvider;
        assert_eq!(
            provider.availability(AppleCapability::SecureEnclave, OsVersion::new(26, 0), false),
            Err(AppleUnavailable::CapabilityMissing(
                AppleCapability::SecureEnclave
            ))
        );
    }

    #[test]
    fn a_build_with_no_adapter_refuses_everything() {
        let provider = UnavailableAppleProvider;
        for capability in AppleCapability::ALL {
            assert_eq!(
                provider.availability(*capability, OsVersion::new(26, 0), false),
                Err(AppleUnavailable::CapabilityMissing(*capability))
            );
        }
    }

    #[test]
    fn no_reference_vector_needs_a_secret() {
        // OpalCrypto's own README: secret-scalar operations have not completed
        // constant-time hardening or security review. A differential test must
        // never become the reason it sees a private key.
        for vector in ReferenceVector::ALL {
            assert!(
                !vector.needs_secret_material(),
                "{} must not require secret material",
                vector.id()
            );
            assert!(!vector.id().is_empty());
        }
    }

    #[test]
    fn agreement_without_a_canonical_anchor_is_not_a_pass() {
        // Two implementations can share the same wrong assumption. Agreement
        // alone is the shape that takes, so it must not read as success.
        let shared_mistake = DifferentialOutcome {
            vector: ReferenceVector::Sighash,
            rust_matches_canonical: false,
            reference_matches_canonical: false,
            implementations_agree: true,
        };
        assert!(!shared_mistake.passed());
        assert!(shared_mistake.agrees_but_unanchored());

        let real_pass = DifferentialOutcome {
            vector: ReferenceVector::CashAddr,
            rust_matches_canonical: true,
            reference_matches_canonical: true,
            implementations_agree: true,
        };
        assert!(real_pass.passed());
        assert!(!real_pass.agrees_but_unanchored());

        // Disagreement is a failure even when Rust is right, because the
        // difference still has to be explained.
        let divergent = DifferentialOutcome {
            vector: ReferenceVector::CashAddr,
            rust_matches_canonical: true,
            reference_matches_canonical: false,
            implementations_agree: false,
        };
        assert!(!divergent.passed());
    }
}

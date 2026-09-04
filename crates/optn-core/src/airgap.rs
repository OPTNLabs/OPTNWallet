//! Adding an account the wallet can watch but not spend from.
//!
//! Two categories, and they are genuinely different things rather than a list
//! of brands:
//!
//! **Watch only wallets.** An account xPub arrives and the wallet watches it.
//! Where the xPub came from is not the wallet's business — a seed signer with
//! no firmware, another wallet's export, a piece of paper. SeedCash is one of
//! these and gets no special case: it hands over a bare base58 xPub, so the
//! master fingerprint is typed and the account path is chosen, which is
//! exactly what the generic path already does for anything else. Enumerating
//! it as a device would imply the wallet cares which seed signer produced the
//! key, and it does not.
//!
//! **Air-gapped hardware wallets.** Devices with firmware that never touch a
//! cable and never see a PSBT here: the account arrives as a QR and later
//! spends go back out as one. Keystone is the one supported today; others
//! exist. These are worth naming individually because their exports differ —
//! Keystone's BC-UR carries the key *and* its origin, so the fingerprint and
//! the full derivation path come with it and nothing is typed.
//!
//! Both categories accept the same three ways in: typed, uploaded from a file,
//! or scanned. That is [`AccountEntry`], shared rather than duplicated.
//!
//! This module only classifies a scanned payload. Decoding BC-UR needs a
//! CBOR/bytewords decoder this crate does not have yet, so a UR is reported
//! as such rather than being half-parsed into a plausible wrong key.

use crate::error::{CliError, Result};

/// A scanned air-gap payload, identified but not yet decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScannedAccount {
    /// A bare account xPub, usable immediately. SeedCash exports this.
    Xpub(String),
    /// A BC-UR fragment. Keystone exports these, usually animated across
    /// several frames.
    UniformResource {
        /// The registry type, e.g. `crypto-hdkey`.
        ur_type: String,
        /// `Some((index, total))` for an animated multi-part UR, 1-based.
        sequence: Option<(u32, u32)>,
    },
}

impl ScannedAccount {
    /// Whether this payload can be turned into a wallet right now.
    pub const fn is_usable(&self) -> bool {
        matches!(self, Self::Xpub(_))
    }
}

/// Which air-gapped device produced a payload, for the picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AirgapDevice {
    /// Keystone, over BC-UR. Its export carries its own origin.
    Keystone,
}

impl AirgapDevice {
    /// The devices this section offers.
    ///
    /// One today. A seed signer is deliberately not in here: it has no
    /// firmware and exports a plain xPub, so it is a watch-only wallet and
    /// belongs in that section rather than among devices.
    pub const OFFERED: &'static [Self] = &[Self::Keystone];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Keystone => "Keystone",
        }
    }

    pub const fn id(self) -> &'static str {
        match self {
            Self::Keystone => "keystone",
        }
    }

    /// One line under the name in the picker.
    pub const fn description(self) -> &'static str {
        match self {
            Self::Keystone => {
                "Scan account QR (path + fingerprint). Send & receive airgap — \
                 not USB, not PSBT."
            }
        }
    }

    /// Whether the device's export carries its own origin (fingerprint and
    /// derivation path). False means the user supplies them.
    ///
    /// A per-device property rather than a category one: another air-gapped
    /// device may well export a bare key, and it would still be a device.
    pub const fn carries_origin(self) -> bool {
        matches!(self, Self::Keystone)
    }
}

/// How an account gets into the wallet.
///
/// The same three for a watch-only wallet and for an air-gapped device: type
/// it, upload a file, or scan it. Shared because it is one decision the user
/// makes, not two that happen to look alike -- and a screen that offered scan
/// for one and paste for the other would be inventing a difference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AccountEntry {
    /// Typed or pasted.
    Typed,
    /// Read from a file the user picked.
    Uploaded,
    /// Read with the camera.
    Scanned,
}

impl AccountEntry {
    pub const ALL: &'static [Self] = &[Self::Typed, Self::Uploaded, Self::Scanned];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Typed => "Enter",
            Self::Uploaded => "Upload",
            Self::Scanned => "Scan",
        }
    }

    /// Whether this way in needs a camera.
    ///
    /// Only scanning does, which is what lets a build with no camera still add
    /// a cold wallet by paste or file.
    pub const fn needs_camera(self) -> bool {
        matches!(self, Self::Scanned)
    }
}

/// Headline for the air-gapped hardware section.
///
/// The shipped copy from the wallet this was ported from. The section holds
/// devices with firmware; a seed signer is a watch-only wallet and appears in
/// that section above.
pub const AIRGAP_TITLE: &str = "Airgap";
/// The line under it.
pub const AIRGAP_SUBTITLE: &str = "Not PSBT. Device stays offline; send & receive over QR airgap.";

/// Identify a scanned payload without decoding it.
pub fn classify_scanned_account(payload: &str) -> Result<ScannedAccount> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return Err(CliError::Usage("that QR code was empty".into()));
    }

    // BC-UR is `ur:<type>/<body>` or `ur:<type>/<seq>-<total>/<body>`, and the
    // scheme is case-insensitive because QR alphanumeric mode is uppercase.
    if let Some(rest) = strip_prefix_ignore_ascii_case(trimmed, "ur:") {
        let mut parts = rest.split('/');
        let ur_type = parts
            .next()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CliError::Usage("that QR is not a complete UR code".into()))?;
        let sequence = parts.next().and_then(parse_sequence);
        return Ok(ScannedAccount::UniformResource { ur_type, sequence });
    }

    // Otherwise it should be an account xPub. Validate it here so a QR of
    // something else entirely fails now rather than deeper in onboarding.
    crate::watch_only::parse_account_xpub(trimmed)?;
    Ok(ScannedAccount::Xpub(trimmed.to_owned()))
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&value[prefix.len()..])
    } else {
        None
    }
}

/// `2-5` from an animated UR. Anything else is not a sequence marker.
fn parse_sequence(segment: &str) -> Option<(u32, u32)> {
    let (index, total) = segment.split_once('-')?;
    let index = index.parse::<u32>().ok()?;
    let total = total.parse::<u32>().ok()?;
    // A zero index or a part beyond the total is a malformed marker, not a
    // frame we should count towards completion.
    if index == 0 || total == 0 || index > total {
        return None;
    }
    Some((index, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::Network;
    use bip32::{Prefix, XPrv};
    use bip39::{Language, Mnemonic};

    fn account_xpub() -> String {
        let mnemonic =
            Mnemonic::parse_in_normalized(Language::English, crate::hd::BIP39_TEST_VECTOR_MNEMONIC)
                .unwrap();
        let seed = mnemonic.to_seed_normalized("");
        let coin = Network::Mainnet.default_coin_type();
        let path = format!("m/44'/{coin}'/0'").parse().unwrap();
        XPrv::derive_from_path(seed, &path)
            .unwrap()
            .public_key()
            .to_string(Prefix::XPUB)
    }

    #[test]
    fn a_seedcash_export_is_a_bare_xpub_and_is_usable_now() {
        let xpub = account_xpub();
        let scanned = classify_scanned_account(&xpub).expect("an account xPub must classify");
        assert_eq!(scanned, ScannedAccount::Xpub(xpub.clone()));
        assert!(scanned.is_usable());
        // Surrounding whitespace from a scanner is not a different key.
        assert_eq!(
            classify_scanned_account(&format!("  {xpub}\n")).unwrap(),
            ScannedAccount::Xpub(xpub)
        );
    }

    #[test]
    fn a_keystone_export_is_recognised_but_not_decoded() {
        // Reported as a UR rather than half-parsed: guessing at CBOR would
        // produce a plausible wrong key, which is the worst outcome here.
        let single =
            classify_scanned_account("ur:crypto-hdkey/oyadgdaobncpftlnyljzrurewmtkmnbbtakb")
                .unwrap();
        assert_eq!(
            single,
            ScannedAccount::UniformResource {
                ur_type: "crypto-hdkey".into(),
                sequence: None,
            }
        );
        assert!(!single.is_usable(), "a UR cannot open a wallet yet");

        let animated = classify_scanned_account("ur:crypto-account/2-5/oyadgdaobncpftln").unwrap();
        assert_eq!(
            animated,
            ScannedAccount::UniformResource {
                ur_type: "crypto-account".into(),
                sequence: Some((2, 5)),
            }
        );
    }

    #[test]
    fn the_ur_scheme_is_case_insensitive_because_qr_encodes_uppercase() {
        // QR alphanumeric mode has no lowercase, so scanners often hand back
        // an uppercased UR. Failing on that would break every Keystone scan.
        for raw in [
            "UR:CRYPTO-HDKEY/OYADGDAOBNCPFTLN",
            "Ur:Crypto-HdKey/oyadgd",
            "ur:crypto-hdkey/oyadgd",
        ] {
            match classify_scanned_account(raw).unwrap() {
                ScannedAccount::UniformResource { ur_type, .. } => {
                    assert_eq!(ur_type, "crypto-hdkey", "{raw}");
                }
                other => panic!("{raw} should be a UR, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_malformed_sequence_marker_is_not_counted_as_a_frame() {
        for body in ["0-3", "4-3", "x-3", "3", "3-", "-3"] {
            let scanned =
                classify_scanned_account(&format!("ur:crypto-hdkey/{body}/oyadgd")).unwrap();
            match scanned {
                ScannedAccount::UniformResource { sequence, .. } => {
                    assert_eq!(sequence, None, "{body} must not parse as a frame marker");
                }
                other => panic!("expected a UR, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_qr_of_something_else_fails_at_the_scan_not_later() {
        for junk in [
            "",
            "   ",
            "bitcoincash:qqjyery2ktqc6aps363cnukdaq8z25kefyyf894dak",
            "hello world",
            "ur:",
        ] {
            assert!(
                classify_scanned_account(junk).is_err(),
                "{junk:?} must be refused"
            );
        }
    }

    #[test]
    fn a_seed_signer_is_not_a_device_and_is_not_offered_as_one() {
        // SeedCash has no firmware and exports a plain xPub, so it is a
        // watch-only wallet like any other. Listing it among devices would
        // imply the wallet cares which seed signer produced a key, and it does
        // not -- the generic watch-only path already types the fingerprint and
        // chooses the account path, which is the whole of what it needs.
        assert_eq!(AirgapDevice::OFFERED, &[AirgapDevice::Keystone]);
        for device in AirgapDevice::OFFERED {
            assert_ne!(device.id(), "seedcash");
            assert_ne!(device.label(), "SeedCash");
        }
    }

    #[test]
    fn both_categories_take_the_same_three_ways_in() {
        // Enter, upload, scan -- for a watch-only xPub and for a device's QR
        // alike. A screen offering scan for one and paste for the other would
        // be inventing a difference the user does not experience.
        assert_eq!(AccountEntry::ALL.len(), 3);
        assert_eq!(
            AccountEntry::ALL
                .iter()
                .map(|entry| entry.label())
                .collect::<Vec<_>>(),
            vec!["Enter", "Upload", "Scan"]
        );

        // Only one of them needs a camera, which is what lets a build without
        // one still add a cold wallet.
        assert!(AccountEntry::Scanned.needs_camera());
        assert!(!AccountEntry::Typed.needs_camera());
        assert!(!AccountEntry::Uploaded.needs_camera());
        assert_eq!(
            AccountEntry::ALL
                .iter()
                .filter(|entry| !entry.needs_camera())
                .count(),
            2,
            "two ways in survive a build with no camera"
        );
    }

    #[test]
    fn the_offered_devices_read_the_way_the_product_says() {
        assert_eq!(AirgapDevice::OFFERED, &[AirgapDevice::Keystone]);
        assert_eq!(AIRGAP_TITLE, "Airgap");
        assert_eq!(
            AIRGAP_SUBTITLE,
            "Not PSBT. Device stays offline; send & receive over QR airgap."
        );
        assert_eq!(
            AirgapDevice::Keystone.description(),
            "Scan account QR (path + fingerprint). Send & receive airgap — not USB, not PSBT."
        );
        // Keystone's export carries its own origin, so nothing is typed. A
        // watch-only wallet is the other case -- the key arrives alone and the
        // fingerprint and path are supplied here -- and that is the generic
        // path, not a device with this flag turned off.
        assert!(AirgapDevice::Keystone.carries_origin());
        for device in AirgapDevice::OFFERED {
            assert!(!device.label().is_empty());
            assert!(!device.description().is_empty());
        }
    }
}

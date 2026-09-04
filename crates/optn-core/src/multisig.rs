//! P2SH m-of-n multisig from cosigner account xPubs.
//!
//! The redeem script is `OP_m <pubkey>... <pubkey> OP_n OP_CHECKMULTISIG` with
//! the compressed public keys sorted lexicographically (BIP-67) — the ordering
//! Paytaca uses, and the one the TypeScript `psbtMultisig` module already
//! builds. Addresses are P2SH20 of that script.
//!
//! Ordering is not cosmetic: the same cosigners in a different order would
//! otherwise produce a different script, a different hash, and a different
//! address. BIP-67 is what lets every cosigner independently arrive at the
//! same wallet.
//!
//! No private key material enters this module.

use bip32::{ChildNumber, XPub};

use crate::cashaddr::{Address, AddressKind};
use crate::error::{CliError, Result};
use crate::hd::{hash160, AccountPath};
use crate::network::Network;
use crate::watch_only::{normalize_master_fingerprint, parse_account_xpub, PublicAddressPreview};

pub const OP_CHECKMULTISIG: u8 = 0xae;
/// `OP_1` is 0x51; `OP_n` is `0x50 + n` for n in 1..=16.
const OP_1: u8 = 0x51;
/// A compressed public key is 33 bytes, pushed with its own length.
const PUSH_33: u8 = 0x21;

/// Script thresholds are small integers, so `OP_16` is the ceiling.
pub const MAX_COSIGNERS: usize = 16;

/// One participant's public account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cosigner {
    pub name: String,
    pub account_xpub: String,
    pub master_fingerprint: Option<String>,
}

/// An m-of-n policy with its participants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultisigPreview {
    pub required: u8,
    pub total: u8,
    /// `2 of 3`, for display.
    pub policy: String,
    pub receive: PublicAddressPreview,
    pub change: PublicAddressPreview,
    /// Cosigner names in the order the user entered them. The script order is
    /// BIP-67 and deliberately not exposed as if it were the user's.
    pub cosigner_names: Vec<String>,
}

/// `OP_n` for a small integer, refusing anything a script cannot encode.
fn small_integer_opcode(value: usize) -> Result<u8> {
    if !(1..=MAX_COSIGNERS).contains(&value) {
        return Err(CliError::Usage(format!(
            "multisig thresholds must be between 1 and {MAX_COSIGNERS} (got {value})"
        )));
    }
    Ok(OP_1 - 1 + value as u8)
}

/// BIP-67: lexicographic ordering of compressed public keys.
pub fn sort_public_keys_bip67(keys: &mut [[u8; 33]]) {
    keys.sort_unstable();
}

/// `OP_m <keys...> OP_n OP_CHECKMULTISIG`, keys BIP-67 sorted.
pub fn redeem_script(required: u8, keys: &[[u8; 33]]) -> Result<Vec<u8>> {
    if keys.is_empty() {
        return Err(CliError::Usage(
            "a multisig redeem script needs at least one public key".into(),
        ));
    }
    if usize::from(required) > keys.len() {
        return Err(CliError::Usage(format!(
            "cannot require {required} signatures from {} cosigners",
            keys.len()
        )));
    }
    let m = small_integer_opcode(usize::from(required))?;
    let n = small_integer_opcode(keys.len())?;

    let mut sorted = keys.to_vec();
    sort_public_keys_bip67(&mut sorted);

    let mut script = Vec::with_capacity(3 + sorted.len() * 34);
    script.push(m);
    for key in &sorted {
        script.push(PUSH_33);
        script.extend_from_slice(key);
    }
    script.push(n);
    script.push(OP_CHECKMULTISIG);
    Ok(script)
}

/// P2SH address for a redeem script.
pub fn p2sh_address(network: Network, redeem: &[u8], token_aware: bool) -> String {
    let kind = if token_aware {
        AddressKind::P2shToken
    } else {
        AddressKind::P2sh
    };
    Address::from_hash(network.prefix(), kind, hash160(redeem)).encode()
}

/// Derive one cosigner's compressed public key at `<branch>/<index>`.
fn cosigner_public_key(account: &XPub, branch: u32, index: u32) -> Result<[u8; 33]> {
    let branch_key = account
        .derive_child(
            ChildNumber::new(branch, false)
                .map_err(|e| CliError::Internal(format!("invalid branch index: {e}")))?,
        )
        .map_err(|e| CliError::Usage(format!("could not derive cosigner branch: {e}")))?;
    let child = branch_key
        .derive_child(
            ChildNumber::new(index, false)
                .map_err(|e| CliError::Internal(format!("invalid address index: {e}")))?,
        )
        .map_err(|e| CliError::Usage(format!("could not derive cosigner address: {e}")))?;
    Ok(child.to_bytes())
}

fn branch_address(
    network: Network,
    required: u8,
    accounts: &[XPub],
    branch: u32,
    index: u32,
) -> Result<PublicAddressPreview> {
    let keys = accounts
        .iter()
        .map(|account| cosigner_public_key(account, branch, index))
        .collect::<Result<Vec<_>>>()?;
    let script = redeem_script(required, &keys)?;
    Ok(PublicAddressPreview {
        path: format!("{branch}/{index}"),
        address: p2sh_address(network, &script, false),
        token_address: p2sh_address(network, &script, true),
    })
}

/// Validate a cosigner set and derive the first receive/change addresses.
pub fn multisig_preview(
    network: Network,
    required: u8,
    cosigners: &[Cosigner],
) -> Result<MultisigPreview> {
    if cosigners.len() < 2 {
        return Err(CliError::Usage(
            "a multisig wallet needs at least two cosigners".into(),
        ));
    }
    if cosigners.len() > MAX_COSIGNERS {
        return Err(CliError::Usage(format!(
            "a multisig wallet supports at most {MAX_COSIGNERS} cosigners"
        )));
    }
    if required == 0 || usize::from(required) > cosigners.len() {
        return Err(CliError::Usage(format!(
            "require between 1 and {} signatures",
            cosigners.len()
        )));
    }

    let mut accounts = Vec::with_capacity(cosigners.len());
    for cosigner in cosigners {
        // Validate the fingerprint even though it is not in the script: a
        // malformed one would break PSBT key origins later, and finding that
        // out at signing time is far worse than finding it out here.
        normalize_master_fingerprint(cosigner.master_fingerprint.as_deref().unwrap_or(""))?;
        accounts.push(parse_account_xpub(&cosigner.account_xpub)?);
    }

    // Duplicate keys would make an "m of n" that is really "m of fewer": two
    // slots that one signer can satisfy alone.
    let mut seen: Vec<[u8; 33]> = accounts
        .iter()
        .map(|account| account.to_bytes())
        .collect::<Vec<_>>();
    seen.sort_unstable();
    let unique = {
        let mut deduped = seen.clone();
        deduped.dedup();
        deduped.len()
    };
    if unique != seen.len() {
        return Err(CliError::Usage(
            "two cosigners share an account xPub; each cosigner needs a distinct key".into(),
        ));
    }

    Ok(MultisigPreview {
        required,
        total: cosigners.len() as u8,
        policy: format!("{required} of {}", cosigners.len()),
        receive: branch_address(network, required, &accounts, 0, 0)?,
        change: branch_address(network, required, &accounts, 1, 0)?,
        cosigner_names: cosigners
            .iter()
            .enumerate()
            .map(|(position, cosigner)| {
                let trimmed = cosigner.name.trim();
                if trimmed.is_empty() {
                    format!("Cosigner {}", position + 1)
                } else {
                    trimmed.to_owned()
                }
            })
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// Descriptors, so the wallet is not the only thing that can open it
// ---------------------------------------------------------------------------

/// The characters a descriptor may contain, in checksum order.
const DESCRIPTOR_INPUT_CHARSET: &str =
    "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
/// The alphabet the eight checksum characters are drawn from.
const DESCRIPTOR_CHECKSUM_CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// BIP-380 checksum polynomial.
fn descriptor_polymod(chk: u64, value: u64) -> u64 {
    const GENERATOR: [u64; 5] = [
        0x00f5_dee5_1989,
        0x00a9_fdca_3312,
        0x001b_ab10_e32d,
        0x0037_06b1_677a,
        0x0064_4d62_6ffd,
    ];
    let top = chk >> 35;
    let mut chk = ((chk & 0x07_ffff_ffff) << 5) ^ value;
    for (bit, generator) in GENERATOR.iter().enumerate() {
        if (top >> bit) & 1 == 1 {
            chk ^= generator;
        }
    }
    chk
}

/// The eight-character checksum a descriptor carries after `#`.
///
/// Not decoration. A descriptor is a long string of base58 that people copy
/// between wallets by hand or by QR, and a single wrong character yields a
/// different, valid-looking wallet whose addresses nobody can spend from. The
/// checksum is what turns that into an error message.
///
/// `None` when the descriptor contains a character the format does not allow.
pub fn descriptor_checksum(descriptor: &str) -> Option<String> {
    let mut chk: u64 = 1;
    let mut groups: Vec<u64> = Vec::with_capacity(3);

    for character in descriptor.chars() {
        let position = DESCRIPTOR_INPUT_CHARSET
            .chars()
            .position(|c| c == character)? as u64;
        chk = descriptor_polymod(chk, position & 31);
        groups.push(position >> 5);
        if groups.len() == 3 {
            chk = descriptor_polymod(chk, groups[0] * 9 + groups[1] * 3 + groups[2]);
            groups.clear();
        }
    }
    match groups.len() {
        1 => chk = descriptor_polymod(chk, groups[0]),
        2 => chk = descriptor_polymod(chk, groups[0] * 3 + groups[1]),
        _ => {}
    }
    for _ in 0..8 {
        chk = descriptor_polymod(chk, 0);
    }
    chk ^= 1;

    Some(
        (0..8)
            .map(|index| {
                let symbol = (chk >> (5 * (7 - index))) & 31;
                DESCRIPTOR_CHECKSUM_CHARSET[symbol as usize] as char
            })
            .collect(),
    )
}

/// A descriptor with its checksum appended.
pub fn with_descriptor_checksum(descriptor: &str) -> Result<String> {
    let checksum = descriptor_checksum(descriptor).ok_or_else(|| {
        CliError::Internal("descriptor contains a character the format does not allow".into())
    })?;
    Ok(format!("{descriptor}#{checksum}"))
}

/// The receive and change descriptors for a policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptorSet {
    /// `sh(sortedmulti(...))` over branch 0, checksummed.
    pub receive: String,
    /// The same over branch 1.
    pub change: String,
}

/// Export the policy as BIP-380 / BIP-383 descriptors.
///
/// This is what makes a wallet created here openable somewhere else, and a
/// wallet created elsewhere openable here. `sh(sortedmulti(...))` is the same
/// thing this module builds natively: P2SH over BIP-67-sorted keys, which is
/// exactly what `sortedmulti` means. So the descriptor is a translation rather
/// than a second implementation, and a wallet loaded from one in Electron
/// Cash, Sparrow or anything else arrives at the same addresses.
///
/// Every cosigner needs a master fingerprint here, even though the script does
/// not use one: a descriptor without key origins can be loaded but not signed
/// against, because a signer cannot tell which key in it is its own.
///
/// The order of the keys *in the text* is canonical -- fingerprint then xPub --
/// so two wallets describing the same policy produce the same string. It is
/// deliberately not the script order: `sortedmulti` sorts per derived address,
/// which is the whole point of BIP-67 and cannot be done once at the top.
pub fn descriptor_set(
    required: u8,
    cosigners: &[Cosigner],
    account: AccountPath,
) -> Result<DescriptorSet> {
    if cosigners.len() < 2 {
        return Err(CliError::Usage(
            "a multisig wallet needs at least two cosigners".into(),
        ));
    }
    if required == 0 || usize::from(required) > cosigners.len() {
        return Err(CliError::Usage(format!(
            "threshold {required} is outside 1..={}",
            cosigners.len()
        )));
    }

    // `m/44'/145'/0'` becomes `44'/145'/0'`: a key origin carries the path
    // below the master, and the leading `m/` is the master itself.
    let origin_path = account.path();
    let origin_path = origin_path.strip_prefix("m/").unwrap_or(&origin_path);

    let mut keys: Vec<(String, String)> = Vec::with_capacity(cosigners.len());
    for (index, cosigner) in cosigners.iter().enumerate() {
        let fingerprint =
            normalize_master_fingerprint(cosigner.master_fingerprint.as_deref().unwrap_or(""))?
                .ok_or_else(|| {
                    CliError::Usage(format!(
                "cosigner {} needs a master fingerprint before the wallet can be exported: a \
                 descriptor without key origins loads but cannot be signed against, because a \
                 signer cannot tell which key is its own",
                index + 1
            ))
                })?;
        let xpub = parse_account_xpub(&cosigner.account_xpub)
            .map(|_| cosigner.account_xpub.trim().to_string())?;
        keys.push((
            format!("{fingerprint}{xpub}"),
            format!("[{fingerprint}/{origin_path}]{xpub}"),
        ));
    }
    keys.sort_by(|left, right| left.0.cmp(&right.0));

    let body = |branch: u32| {
        let listed = keys
            .iter()
            .map(|(_, key)| format!("{key}/{branch}/*"))
            .collect::<Vec<_>>()
            .join(",");
        format!("sh(sortedmulti({required},{listed}))")
    };

    Ok(DescriptorSet {
        receive: with_descriptor_checksum(&body(0))?,
        change: with_descriptor_checksum(&body(1))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bip32::{Prefix, XPrv};
    use bip39::{Language, Mnemonic};

    const TEST_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn account_xpub(account: u32) -> String {
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, TEST_MNEMONIC).unwrap();
        let seed = mnemonic.to_seed_normalized("");
        let path = format!("m/44'/145'/{account}'").parse().unwrap();
        XPrv::derive_from_path(seed, &path)
            .unwrap()
            .public_key()
            .to_string(Prefix::XPUB)
    }

    fn cosigner(name: &str, account: u32) -> Cosigner {
        Cosigner {
            name: name.into(),
            account_xpub: account_xpub(account),
            master_fingerprint: None,
        }
    }

    /// Two cosigners with fingerprints, for the descriptor tests.
    fn two_cosigners() -> Vec<Cosigner> {
        let wallet = crate::hd::Wallet::from_mnemonic(crate::hd::BIP39_TEST_VECTOR_MNEMONIC, "")
            .expect("mnemonic");
        vec![
            Cosigner {
                name: "Ada".into(),
                account_xpub: wallet.account_xpub(Network::Chipnet, 0).expect("xpub"),
                master_fingerprint: Some("4c9a1f7b".into()),
            },
            Cosigner {
                name: "Bo".into(),
                account_xpub: wallet.account_xpub(Network::Chipnet, 1).expect("xpub"),
                master_fingerprint: Some("0f1e2d3c".into()),
            },
        ]
    }
    #[test]
    fn the_descriptor_checksum_matches_the_published_vector() {
        // From BIP-380 itself. A wrong implementation here would produce
        // descriptors every other wallet rejects, and the failure would look
        // like the other wallet being broken.
        assert_eq!(
            with_descriptor_checksum("raw(deadbeef)").expect("valid"),
            "raw(deadbeef)#89f8spxm"
        );

        // A character outside the charset is refused rather than checksummed
        // into something that looks fine.
        assert_eq!(descriptor_checksum("raw(deadbeef)\u{00e9}"), None);
    }

    #[test]
    fn a_policy_exports_as_something_another_wallet_can_open() {
        // sortedmulti is BIP-67 by another name, so the descriptor is a
        // translation of what this module already builds rather than a second
        // implementation of it.
        let cosigners = two_cosigners();
        let account = AccountPath::new(145, 0).expect("in range");
        let set = descriptor_set(2, &cosigners, account).expect("exports");

        assert!(
            set.receive.starts_with("sh(sortedmulti(2,"),
            "{}",
            set.receive
        );
        assert!(set.receive.contains("/0/*"), "receive is branch 0");
        assert!(set.change.contains("/1/*"), "change is branch 1");
        assert_ne!(set.receive, set.change);

        // Key origins are present and carry the path below the master.
        assert!(
            set.receive.contains("[4c9a1f7b/44'/145'/0']"),
            "{}",
            set.receive
        );
        assert!(!set.receive.contains("[4c9a1f7b/m/"), "no leading m/");

        // Both halves are checksummed, and the checksum verifies.
        for descriptor in [&set.receive, &set.change] {
            let (body, checksum) = descriptor.rsplit_once('#').expect("checksummed");
            assert_eq!(checksum.len(), 8);
            assert_eq!(descriptor_checksum(body).as_deref(), Some(checksum));
        }
    }

    #[test]
    fn the_text_order_is_canonical_so_two_wallets_agree_on_the_string() {
        // Not the script order -- sortedmulti sorts per derived address, which
        // is what BIP-67 is for and cannot be done once at the top. This is so
        // the same policy described twice reads identically.
        let account = AccountPath::new(145, 0).expect("in range");
        let forwards = two_cosigners();
        let mut backwards = forwards.clone();
        backwards.reverse();

        assert_eq!(
            descriptor_set(2, &forwards, account).expect("exports"),
            descriptor_set(2, &backwards, account).expect("exports"),
            "entry order must not change the descriptor"
        );
    }

    #[test]
    fn a_cosigner_without_a_fingerprint_cannot_be_exported() {
        // The script does not use one, so the wallet works locally. A
        // descriptor without key origins loads elsewhere and then cannot be
        // signed against, because a signer cannot find its own key in it --
        // which is a worse outcome than refusing the export.
        let mut cosigners = two_cosigners();
        cosigners[1].master_fingerprint = None;
        let account = AccountPath::new(145, 0).expect("in range");

        let error = descriptor_set(2, &cosigners, account).expect_err("no fingerprint");
        assert!(error.to_string().contains("master fingerprint"), "{error}");
        assert!(
            error.to_string().contains("cannot tell which key"),
            "{error}"
        );

        // And it still builds addresses perfectly well without one.
        assert!(multisig_preview(Network::Chipnet, 2, &cosigners).is_ok());
    }

    #[test]
    fn this_agrees_with_optn_multisig_core_byte_for_byte() {
        // PR #65 adds `optn-multisig-core`, a second Rust implementation of
        // this same derivation, and it merges before #63. Two implementations
        // that disagree would put a wallet's coins at an address it does not
        // watch, so these are *its* published vectors run against this code --
        // not vectors generated here, which would only prove self-consistency.
        //
        // From crates/optn-multisig-core/src/lib.rs, VECTOR_1.
        const KEY_A: &str = "02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8";
        const KEY_B: &str = "02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f";
        const EXPECTED_SCRIPT: &str = "522102fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f2102ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f852ae";
        const EXPECTED_ADDRESS: &str = "bchtest:ppttar4f8yf0xa592s4z4pj22cq03zn82syer0akm8";
        const EXPECTED_TOKEN_ADDRESS: &str = "bchtest:rpttar4f8yf0xa592s4z4pj22cq03zn82srns3nsy5";

        fn key(hex: &str) -> [u8; 33] {
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
                .collect();
            let mut out = [0u8; 33];
            out.copy_from_slice(&bytes);
            out
        }

        let script = redeem_script(2, &[key(KEY_A), key(KEY_B)]).expect("2-of-2");
        let script_hex: String = script.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(script_hex, EXPECTED_SCRIPT, "the redeem script must match");

        // BIP-67 put B before A, because fe sorts before ff. The input order
        // was the other way round, which is the whole point of sorting.
        assert!(
            script_hex.find(KEY_B).expect("B is present")
                < script_hex.find(KEY_A).expect("A is present"),
            "sorted, not input order"
        );

        assert_eq!(
            p2sh_address(Network::Chipnet, &script, false),
            EXPECTED_ADDRESS
        );
        assert_eq!(
            p2sh_address(Network::Chipnet, &script, true),
            EXPECTED_TOKEN_ADDRESS
        );
    }

    #[test]
    fn redeem_script_has_the_documented_shape() {
        let keys = [[2u8; 33], [3u8; 33]];
        let script = redeem_script(2, &keys).expect("2-of-2");
        assert_eq!(script[0], 0x52, "OP_2 threshold");
        assert_eq!(script[1], PUSH_33);
        assert_eq!(script[script.len() - 2], 0x52, "OP_2 total");
        assert_eq!(script[script.len() - 1], OP_CHECKMULTISIG);
        // OP_m + n*(push + 33 bytes) + OP_n + OP_CHECKMULTISIG
        assert_eq!(script.len(), 3 + keys.len() * 34);
    }

    #[test]
    fn cosigner_order_does_not_change_the_wallet() {
        // The property BIP-67 exists for: every cosigner types the others in
        // whatever order they like and still lands on the same address. If
        // this ever fails, cosigners silently create separate wallets.
        let forward = vec![cosigner("A", 0), cosigner("B", 1), cosigner("C", 2)];
        let mut reversed = forward.clone();
        reversed.reverse();

        let a = multisig_preview(Network::Mainnet, 2, &forward).expect("forward");
        let b = multisig_preview(Network::Mainnet, 2, &reversed).expect("reversed");
        assert_eq!(a.receive.address, b.receive.address);
        assert_eq!(a.change.address, b.change.address);
        assert_eq!(a.policy, "2 of 3");
        assert_ne!(a.receive.address, a.change.address);
    }

    #[test]
    fn a_multisig_address_is_p2sh_and_network_correct() {
        let signers = vec![cosigner("A", 0), cosigner("B", 1)];
        let main = multisig_preview(Network::Mainnet, 2, &signers).expect("mainnet");
        assert!(
            main.receive.address.starts_with("bitcoincash:p"),
            "mainnet receive must be P2SH cashaddr"
        );
        assert!(main.receive.token_address.starts_with("bitcoincash:r"));

        let chip = multisig_preview(Network::Chipnet, 2, &signers).expect("chipnet");
        assert!(chip.receive.address.starts_with("bchtest:p"));
        assert_ne!(main.receive.address, chip.receive.address);
    }

    #[test]
    fn the_threshold_changes_the_address() {
        let signers = vec![cosigner("A", 0), cosigner("B", 1), cosigner("C", 2)];
        let two = multisig_preview(Network::Mainnet, 2, &signers).unwrap();
        let three = multisig_preview(Network::Mainnet, 3, &signers).unwrap();
        assert_ne!(
            two.receive.address, three.receive.address,
            "the threshold is in the script, so it must change the address"
        );
        assert_eq!(three.policy, "3 of 3");
    }

    #[test]
    fn refuses_policies_that_cannot_be_signed() {
        let two = vec![cosigner("A", 0), cosigner("B", 1)];
        assert!(multisig_preview(Network::Mainnet, 0, &two).is_err());
        assert!(multisig_preview(Network::Mainnet, 3, &two).is_err());
        assert!(multisig_preview(Network::Mainnet, 1, &two[..1]).is_err());

        // A repeated xPub is two slots one signer can fill alone.
        let duplicate = vec![cosigner("A", 0), cosigner("A again", 0)];
        assert!(multisig_preview(Network::Mainnet, 2, &duplicate).is_err());
    }

    #[test]
    fn unnamed_cosigners_get_positional_names() {
        let signers = vec![cosigner("", 0), cosigner("  ", 1)];
        let preview = multisig_preview(Network::Mainnet, 2, &signers).unwrap();
        assert_eq!(preview.cosigner_names, vec!["Cosigner 1", "Cosigner 2"]);
    }

    #[test]
    fn a_bad_fingerprint_is_caught_at_setup_not_at_signing() {
        let mut signers = vec![cosigner("A", 0), cosigner("B", 1)];
        signers[0].master_fingerprint = Some("nothex!!".into());
        assert!(multisig_preview(Network::Mainnet, 2, &signers).is_err());
    }
}

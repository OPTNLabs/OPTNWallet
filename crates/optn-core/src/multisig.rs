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
use crate::hd::hash160;
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
            "{main:?}"
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

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

use sha2::{Digest, Sha256};

use crate::cashaddr::{Address, AddressKind};
use crate::error::{CliError, Result};
use crate::hd::{hash160, AccountPath};
use crate::network::Network;
use crate::watch_only::{
    normalize_master_fingerprint, parse_multisig_account_xpub, PublicAddressPreview,
};

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
        accounts.push(parse_multisig_account_xpub(&cosigner.account_xpub)?);
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
        let xpub = parse_multisig_account_xpub(&cosigner.account_xpub)
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

/// The longest descriptor this will look at.
///
/// Bounded because the input is someone else's file. BIP-380's checksum
/// guarantees it catches up to four errors in a descriptor of 501 characters
/// or fewer, and a 4-of-N with key origins is longer than that -- so the cap
/// is generous rather than 501, and the weaker guarantee on long descriptors
/// is a fact about the format rather than something to enforce away.
const MAX_DESCRIPTOR_LEN: usize = 10_000;

/// A cosigner as a descriptor described it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptorKey {
    pub master_fingerprint: String,
    /// The account path, as `m/44'/145'/0'`.
    pub account_path: String,
    pub account_xpub: String,
}

/// What a `sh(sortedmulti(...))` descriptor said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDescriptor {
    pub required: u8,
    pub keys: Vec<DescriptorKey>,
    /// The branches this descriptor covers: 0 is receive, 1 is change.
    ///
    /// One entry for an ordinary descriptor. Two for a BIP-389 multipath one,
    /// which writes `<0;1>/*` and means receive and change in a single string.
    /// That is the form Paytaca's BSMS records use, so refusing it would mean
    /// being unable to read the setup of the wallet we interoperate with most.
    pub branches: Vec<u32>,
    /// Whether the input carried a checksum that verified.
    ///
    /// A descriptor without one is accepted, because the format makes it
    /// optional -- but the caller should say so, since an unchecked descriptor
    /// is a wallet nobody proved was typed correctly.
    pub checksum_verified: bool,
}

/// Read a multisig descriptor someone else produced.
///
/// This is the hostile-input direction. Getting it wrong does not fail loudly:
/// a descriptor misread produces a *valid* wallet at addresses that are not
/// the ones the money is at, and the symptom is an empty balance. So the rule
/// throughout is to refuse anything not understood exactly, rather than to
/// interpret generously.
///
/// Accepted: `sh(sortedmulti(m, key, key, ...))`, optionally checksummed.
/// Everything else is refused with the reason, including several things that
/// look close enough to be dangerous.
pub fn parse_descriptor(input: &str) -> Result<ParsedDescriptor> {
    let input = input.trim();
    if input.is_empty() {
        return Err(CliError::Usage("no descriptor was given".into()));
    }
    if input.len() > MAX_DESCRIPTOR_LEN {
        return Err(CliError::Usage(format!(
            "that descriptor is {} characters; the longest accepted is {MAX_DESCRIPTOR_LEN}",
            input.len()
        )));
    }

    // The checksum first, because it is the cheapest way to catch a mistyped
    // key and everything after this trusts the characters.
    let (body, checksum_verified) = match input.rsplit_once('#') {
        Some((body, checksum)) => {
            let expected = descriptor_checksum(body).ok_or_else(|| {
                CliError::Usage(
                    "that descriptor contains a character the format does not allow".into(),
                )
            })?;
            if expected != checksum {
                return Err(CliError::Usage(format!(
                    "that descriptor's checksum does not match: it reads '{checksum}' and should \
                     be '{expected}'. One character is wrong somewhere, and loading it anyway \
                     would build a different wallet."
                )));
            }
            (body, true)
        }
        None => (input, false),
    };

    // Only P2SH. Bitcoin Cash has no witness scripts, so a wsh() or tr()
    // descriptor is not a BCH wallet at all -- it is a Bitcoin one, and
    // opening it here would present someone else's addresses as ours.
    let inner = body
        .strip_prefix("sh(")
        .and_then(|rest| rest.strip_suffix(')'))
        .ok_or_else(|| {
            if body.starts_with("wsh(") || body.starts_with("tr(") {
                CliError::Usage(
                    "that is a SegWit or Taproot descriptor. Bitcoin Cash has neither, so this \
                     describes a Bitcoin wallet rather than a Bitcoin Cash one."
                        .into(),
                )
            } else {
                CliError::Usage(
                    "only sh(sortedmulti(...)) multisig descriptors can be opened here".into(),
                )
            }
        })?;

    // sortedmulti, never multi. They differ only in whether the keys are
    // sorted per address, and they produce *different addresses* from the same
    // keys -- so reading one as the other silently points the wallet at an
    // empty set.
    let args = inner
        .strip_prefix("sortedmulti(")
        .and_then(|rest| rest.strip_suffix(')'))
        .ok_or_else(|| {
            if inner.starts_with("multi(") {
                CliError::Usage(
                    "that descriptor uses multi(), which keeps the keys in the order written. \
                     This wallet builds sortedmulti() addresses (BIP-67), and the two produce \
                     different addresses from the same keys -- so it is not the same wallet."
                        .into(),
                )
            } else {
                CliError::Usage(
                    "only sh(sortedmulti(...)) multisig descriptors can be opened here".into(),
                )
            }
        })?;

    let mut parts = args.split(',');
    let threshold = parts
        .next()
        .ok_or_else(|| CliError::Usage("that descriptor has no threshold".into()))?
        .trim();
    let required: u8 = threshold
        .parse()
        .map_err(|_| CliError::Usage(format!("'{threshold}' is not a threshold this can read")))?;

    let mut keys = Vec::new();
    let mut branches: Option<Vec<u32>> = None;
    for (index, part) in parts.enumerate() {
        let (key, key_branches) = parse_descriptor_key(part.trim(), index)?;
        match &branches {
            None => branches = Some(key_branches),
            // Every key must cover the same branches, or the descriptor
            // describes receive addresses for one cosigner and change for
            // another, which is not a wallet.
            Some(known) if *known != key_branches => {
                return Err(CliError::Usage(format!(
                    "cosigner {} covers branches {key_branches:?} while the first covers \
                     {known:?}; every key in one descriptor shares them",
                    index + 1
                )))
            }
            Some(_) => {}
        }
        keys.push(key);
    }

    if keys.len() < 2 {
        return Err(CliError::Usage(
            "a multisig descriptor needs at least two cosigners".into(),
        ));
    }
    if keys.len() > MAX_COSIGNERS {
        return Err(CliError::Usage(format!(
            "that descriptor has {} cosigners; a script can encode at most {MAX_COSIGNERS}",
            keys.len()
        )));
    }
    if required == 0 || usize::from(required) > keys.len() {
        return Err(CliError::Usage(format!(
            "threshold {required} is outside 1..={}",
            keys.len()
        )));
    }

    // Two cosigners with one key is a wallet fewer people control than it
    // appears to. The same refusal the local path makes.
    let mut seen: Vec<&str> = keys.iter().map(|key| key.account_xpub.as_str()).collect();
    seen.sort_unstable();
    let before = seen.len();
    seen.dedup();
    if seen.len() != before {
        return Err(CliError::Usage(
            "that descriptor lists the same key twice; each cosigner needs a distinct one".into(),
        ));
    }

    Ok(ParsedDescriptor {
        required,
        keys,
        branches: branches.unwrap_or_else(|| vec![0]),
        checksum_verified,
    })
}

/// One `[fingerprint/path]xpub/branch/*` key expression.
///
/// The branch may be a single number or a BIP-389 multipath `<0;1>`, so this
/// returns however many branches the expression covers.
fn parse_descriptor_key(part: &str, index: usize) -> Result<(DescriptorKey, Vec<u32>)> {
    let position = index + 1;
    let rest = part.strip_prefix('[').ok_or_else(|| {
        CliError::Usage(format!(
            "cosigner {position} has no key origin. A descriptor without one loads but cannot be \
             signed against, because a signer cannot tell which key is its own."
        ))
    })?;
    let (origin, key_and_path) = rest.split_once(']').ok_or_else(|| {
        CliError::Usage(format!("cosigner {position}'s key origin is not closed"))
    })?;

    let (fingerprint, origin_path) = origin.split_once('/').ok_or_else(|| {
        CliError::Usage(format!(
            "cosigner {position}'s key origin has no derivation path"
        ))
    })?;
    let fingerprint = normalize_master_fingerprint(fingerprint)?.ok_or_else(|| {
        CliError::Usage(format!(
            "cosigner {position} has an empty master fingerprint"
        ))
    })?;

    // The key's own derivation follows the xpub. Everything after the first
    // '/' is the branch and the wildcard.
    let (xpub, derivation) = key_and_path.split_once('/').ok_or_else(|| {
        CliError::Usage(format!(
            "cosigner {position} has no branch after its key: expected something like /0/*"
        ))
    })?;

    // Hardened derivation below an xpub is impossible -- it needs the private
    // key -- so a descriptor asking for it is malformed rather than merely
    // unsupported.
    if derivation.contains('\'') || derivation.contains('h') || derivation.contains('H') {
        return Err(CliError::Usage(format!(
            "cosigner {position} asks for hardened derivation below its xPub, which needs the \
             private key. A public descriptor cannot do that."
        )));
    }
    let (branch_text, wildcard) = derivation.split_once('/').unwrap_or((derivation, ""));
    if wildcard != "*" {
        return Err(CliError::Usage(format!(
            "cosigner {position} does not end in /*, so it names one address rather than a wallet"
        )));
    }
    // BIP-389 multipath: `<0;1>` is receive and change in one string, and it
    // is what Paytaca's BSMS records carry -- so this is an ordinary form to
    // meet rather than an exotic one.
    let listed = match branch_text
        .strip_prefix('<')
        .and_then(|rest| rest.strip_suffix('>'))
    {
        Some(inner) => {
            let listed: Vec<&str> = inner.split(';').collect();
            if listed.len() < 2 {
                return Err(CliError::Usage(format!(
                    "cosigner {position} writes a multipath of one branch, which is just a branch"
                )));
            }
            listed
        }
        None => vec![branch_text],
    };

    let mut branches = Vec::with_capacity(listed.len());
    for text in listed {
        let text = text.trim();
        let branch: u32 = text.parse().map_err(|_| {
            CliError::Usage(format!(
                "cosigner {position}'s branch '{text}' is not a number"
            ))
        })?;
        // A repeated branch would derive the same address twice and call it
        // two wallets.
        if branches.contains(&branch) {
            return Err(CliError::Usage(format!(
                "cosigner {position} lists branch {branch} twice"
            )));
        }
        branches.push(branch);
    }

    // The xPub itself is validated by the same parser the local path uses, so
    // a descriptor cannot introduce a key the wallet would otherwise refuse.
    parse_multisig_account_xpub(xpub)?;

    Ok((
        DescriptorKey {
            master_fingerprint: fingerprint,
            account_path: format!("m/{origin_path}"),
            account_xpub: xpub.to_string(),
        },
        branches,
    ))
}

impl ParsedDescriptor {
    /// The cosigners, ready for [`multisig_preview`].
    ///
    /// Names are positional: a descriptor carries no names, and inventing ones
    /// that look like people's would be worse than saying so.
    pub fn cosigners(&self) -> Vec<Cosigner> {
        self.keys
            .iter()
            .enumerate()
            .map(|(index, key)| Cosigner {
                name: format!("Cosigner {}", index + 1),
                account_xpub: key.account_xpub.clone(),
                master_fingerprint: Some(key.master_fingerprint.clone()),
            })
            .collect()
    }
}

/// A BSMS 1.0 round-two record: a multisig setup, as one file.
///
/// BIP-129, and what Paytaca exchanges when a multisig wallet is being agreed
/// (`src/lib/multisig/bsms.js`). Four lines:
///
/// ```text
/// BSMS 1.0
/// sh(sortedmulti(2,[fp/44'/145'/0']xpub/<0;1>/*,...))
/// /0/*,/1/*
/// bchtest:...
/// ```
///
/// The fourth line is the interesting one. It is the first receive address the
/// policy produces, and it is there so the *receiving* side can derive that
/// address itself and compare. A cosigner sent a subtly different policy -- one
/// key swapped, a threshold edited in transit -- gets a mismatch here instead
/// of a wallet that quietly watches the wrong addresses. The format carries its
/// own conformance check, and [`BsmsRecord::verify_first_address`] is what
/// makes it worth having.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BsmsRecord {
    pub version: String,
    pub descriptor: ParsedDescriptor,
    /// The allowed derivation paths, as written: `/0/*`, `/1/*`.
    pub path_restrictions: Vec<String>,
    /// The first receive address, as the sender derived it.
    pub first_address: String,
}

impl BsmsRecord {
    /// Derive the first receive address ourselves and compare.
    ///
    /// The whole point of the fourth line. Skipping this check makes it
    /// decoration; running it is what turns a policy altered in transit into an
    /// error rather than a wallet watching an empty set of addresses.
    pub fn verify_first_address(&self, network: Network) -> Result<()> {
        let cosigners = self.descriptor.cosigners();
        let preview = multisig_preview(network, self.descriptor.required, &cosigners)?;
        if preview.receive.address != self.first_address {
            return Err(CliError::Usage(format!(
                "this setup's first address does not match the policy it carries. It says {}, \
                 and these keys produce {}. Something changed between the sender and here, so \
                 the wallet is not the one they described.",
                self.first_address, preview.receive.address
            )));
        }
        Ok(())
    }
}

/// Read a BSMS 1.0 record.
///
/// Hostile input, like any descriptor: a setup file arrives from someone else's
/// wallet, and misreading it produces a wallet watching addresses the money is
/// not at.
pub fn parse_bsms_record(text: &str) -> Result<BsmsRecord> {
    let mut lines = text.trim().lines();

    let header = lines
        .next()
        .ok_or_else(|| CliError::Usage("that file is empty".into()))?
        .trim();
    let version = header.strip_prefix("BSMS ").ok_or_else(|| {
        CliError::Usage(
            "that does not start with a BSMS version line, so it is not a multisig setup record"
                .into(),
        )
    })?;
    let version = version.trim();
    if version != "1.0" {
        return Err(CliError::Usage(format!(
            "this reads BSMS 1.0 records; that one says {version}"
        )));
    }

    let descriptor = parse_descriptor(
        lines
            .next()
            .ok_or_else(|| CliError::Usage("that record has no descriptor".into()))?
            .trim(),
    )?;

    let path_restrictions: Vec<String> = lines
        .next()
        .ok_or_else(|| CliError::Usage("that record has no path restrictions".into()))?
        .trim()
        .split(',')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();
    if path_restrictions.is_empty() {
        return Err(CliError::Usage(
            "that record has no path restrictions".into(),
        ));
    }

    let first_address = lines
        .next()
        .ok_or_else(|| {
            CliError::Usage(
                "that record has no first address, so nothing can check the policy survived the \
                 trip"
                    .into(),
            )
        })?
        .trim()
        .to_string();
    if first_address.is_empty() {
        return Err(CliError::Usage(
            "that record's first address is blank, so nothing can check the policy survived the \
             trip"
                .into(),
        ));
    }

    Ok(BsmsRecord {
        version: version.to_string(),
        descriptor,
        path_restrictions,
        first_address,
    })
}

/// The legacy signed-message prefix, as Bitcoin has always spelled it.
///
/// The leading `\x18` is the length of the text that follows, and is part of
/// the constant rather than computed, because that is how every implementation
/// writes it.
pub const BITCOIN_SIGNED_MESSAGE_PREFIX: &[u8] = b"\x18Bitcoin Signed Message:\n";

/// A BSMS 1.0 round-one key record: one cosigner offering their key.
///
/// BIP-129's first round. Five lines:
///
/// ```text
/// BSMS 1.0
/// 00                                    <- token; 00 means unencrypted
/// [0f1e2d3c/44'/145'/0']xpub6C...       <- key descriptor
/// Ada's phone                           <- description, at most 80 characters
/// 3045022100...                         <- signature over the four lines above
/// ```
///
/// The signature is the point. BIP-129 requires the coordinator to check "that
/// the included `SIG` is valid given the `KEY`", and that check is what stops a
/// substitution attack: without it, anyone who can edit a record in transit can
/// replace a cosigner's key with their own, and the resulting wallet is one
/// they can spend from. Reading these records without verifying them would be
/// worse than not reading them, because it would look like participation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BsmsKeyRecord {
    pub version: String,
    /// Hex token. `00` means the record is not encrypted.
    pub token: String,
    /// The cosigner's key, with its origin.
    pub key: DescriptorKey,
    /// Free text, at most 80 characters per the spec.
    pub description: String,
    /// The signature over [`Self::preimage`], in whichever encoding it arrived.
    pub signature: BsmsSignature,
}

/// How a key record's signature was written.
///
/// Two encodings are in use and a reader that knows only one is a reader that
/// rejects real records.
///
/// BIP-129 says "the signature should follow BIP-0322, legacy format
/// accepted", and every record in the BIP's own test vectors uses that legacy
/// format: base64, 65 bytes, a header byte carrying the recovery id and then
/// r and s. That is what `signmessage` has produced since Bitcoin-Qt.
///
/// Paytaca writes DER hex instead -- `secp256k1.signMessageHashDER` in
/// `bsms.js`. Also a valid ECDSA signature over the same digest, just written
/// differently.
///
/// Both are accepted. Neither is guessed at: the two are told apart by shape,
/// and a string that is neither is refused rather than coerced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BsmsSignature {
    /// 65 bytes, base64: header, then r and s. BIP-129's own vectors.
    Recoverable(Vec<u8>),
    /// DER, hex-encoded. What Paytaca writes.
    Der(Vec<u8>),
}

/// A legacy signed-message signature is a header byte plus r and s.
const RECOVERABLE_SIGNATURE_LEN: usize = 65;
/// Header bytes Bitcoin's legacy signing has ever produced.
const RECOVERABLE_HEADER_RANGE: std::ops::RangeInclusive<u8> = 27..=34;

impl BsmsKeyRecord {
    /// The four lines the signature covers.
    pub fn preimage(&self) -> String {
        format!(
            "BSMS {}\n{}\n[{}/{}]{}\n{}",
            self.version,
            self.token,
            self.key.master_fingerprint,
            self.key
                .account_path
                .strip_prefix("m/")
                .unwrap_or(&self.key.account_path),
            self.key.account_xpub,
            self.description
        )
    }

    /// The digest actually signed: double SHA-256 of the prefixed preimage.
    ///
    /// The length is a **CompactSize**, not a single byte. Paytaca says why in
    /// its own comment -- "Adopting Electron Cash's message len encoding to
    /// accomodate longer messages, i.e. varsize int … Mainnet-js just uses the
    /// length as is" -- and the two encodings agree only below 253 bytes.
    ///
    /// For a key record they always agree, and that is worth stating rather
    /// than leaving as a hazard to worry about: BIP-129 caps the description
    /// at 80 characters, and a record carrying that, an xPub and an origin
    /// comes to 224 bytes. The test pins that number, so if the format ever
    /// grows past 252 the divergence stops being theoretical and something
    /// fails loudly here.
    ///
    /// CompactSize is used anyway. It is what Electron Cash, Paytaca and the
    /// rest of the ecosystem write, it is correct at every length, and picking
    /// the encoding that only works for short messages would be choosing to be
    /// wrong later.
    pub fn signing_digest(&self) -> [u8; 32] {
        let message = self.preimage();
        let body = message.as_bytes();

        let mut buffer = Vec::with_capacity(BITCOIN_SIGNED_MESSAGE_PREFIX.len() + body.len() + 9);
        buffer.extend_from_slice(BITCOIN_SIGNED_MESSAGE_PREFIX);
        buffer.extend_from_slice(&crate::psbt::compact_size(body.len() as u64));
        buffer.extend_from_slice(body);

        let digest = Sha256::digest(Sha256::digest(&buffer));
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    /// Check the signature against the key the record itself carries.
    ///
    /// This proves the sender held the private key for the xPub they offered.
    /// It does **not** prove they are who they say they are -- nothing in the
    /// record does -- so it is a defence against a key swapped in transit, not
    /// against a cosigner who was the wrong person from the start.
    pub fn verify_signature(&self) -> Result<()> {
        use k256::ecdsa::signature::hazmat::PrehashVerifier;

        let account = parse_multisig_account_xpub(&self.key.account_xpub)?;
        let verifying = k256::ecdsa::VerifyingKey::from_sec1_bytes(&account.to_bytes())
            .map_err(|e| CliError::Usage(format!("that record's key is not usable: {e}")))?;
        let signature = match &self.signature {
            BsmsSignature::Der(der) => k256::ecdsa::Signature::from_der(der).map_err(|e| {
                CliError::Usage(format!("that record's signature is not valid DER: {e}"))
            })?,
            BsmsSignature::Recoverable(bytes) => {
                // The header byte carries the recovery id, which is only
                // needed to *derive* the public key. The record already names
                // the key, so r and s are verified against it directly and the
                // header is checked for plausibility rather than used.
                if !RECOVERABLE_HEADER_RANGE.contains(&bytes[0]) {
                    return Err(CliError::Usage(format!(
                        "that signature's header byte is {}, which no legacy signer produces",
                        bytes[0]
                    )));
                }
                k256::ecdsa::Signature::from_slice(&bytes[1..]).map_err(|e| {
                    CliError::Usage(format!(
                        "that record's signature is not a valid r,s pair: {e}"
                    ))
                })?
            }
        };

        verifying
            .verify_prehash(&self.signing_digest(), &signature)
            .map_err(|_| {
                CliError::Usage(
                    "that key record's signature does not match the key it carries. Someone \
                     changed the record between the sender and here, and the key in it is not \
                     the one they signed for."
                        .into(),
                )
            })
    }
}

/// Read a BSMS 1.0 round-one key record.
pub fn parse_bsms_key_record(text: &str) -> Result<BsmsKeyRecord> {
    let mut lines = text.trim().lines();

    let header = lines
        .next()
        .ok_or_else(|| CliError::Usage("that file is empty".into()))?
        .trim();
    let version = header
        .strip_prefix("BSMS ")
        .ok_or_else(|| {
            CliError::Usage(
                "that does not start with a BSMS version line, so it is not a key record".into(),
            )
        })?
        .trim();
    if version != "1.0" {
        return Err(CliError::Usage(format!(
            "this reads BSMS 1.0 records; that one says {version}"
        )));
    }

    let token = lines
        .next()
        .ok_or_else(|| CliError::Usage("that record has no token".into()))?
        .trim()
        .to_string();
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CliError::Usage(format!(
            "'{token}' is not a hex token; BSMS uses 00 for an unencrypted record"
        )));
    }
    if token != "00" {
        return Err(CliError::Usage(
            "that key record is encrypted. Only unencrypted records (token 00) are read here; \
             BSMS encrypts round one with ECIES."
                .into(),
        ));
    }

    let descriptor_line = lines
        .next()
        .ok_or_else(|| CliError::Usage("that record has no key descriptor".into()))?
        .trim();
    // Reuse the key-expression parser, which already refuses a missing origin,
    // an unclosed bracket, hardened derivation below an xPub and a key this
    // wallet would not otherwise accept. A key record carries no branch, so a
    // wildcard is appended to meet the same parser rather than writing a
    // second, laxer one.
    let (key, _) = parse_descriptor_key(&format!("{descriptor_line}/0/*"), 0)?;

    let description = lines
        .next()
        .ok_or_else(|| CliError::Usage("that record has no description line".into()))?
        .trim()
        .to_string();
    if description.chars().count() > BSMS_MAX_DESCRIPTION_CHARS {
        return Err(CliError::Usage(format!(
            "that record's description is {} characters; BSMS allows {BSMS_MAX_DESCRIPTION_CHARS}",
            description.chars().count()
        )));
    }

    let signature_hex = lines
        .next()
        .ok_or_else(|| {
            CliError::Usage(
                "that record has no signature, so nothing proves the sender holds the key they \
                 offered"
                    .into(),
            )
        })?
        .trim();
    let signature = parse_bsms_signature(signature_hex)?;

    Ok(BsmsKeyRecord {
        version: version.to_string(),
        token,
        key,
        description,
        signature,
    })
}

/// Read a signature in either encoding the ecosystem writes.
///
/// Base64 first, because that is what BIP-129's own vectors use and its
/// alphabet overlaps hex's -- a 65-byte base64 string is never valid hex of
/// the right length, so trying it first cannot misread a DER one.
fn parse_bsms_signature(text: &str) -> Result<BsmsSignature> {
    use base64::Engine as _;

    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(text) {
        if bytes.len() == RECOVERABLE_SIGNATURE_LEN {
            return Ok(BsmsSignature::Recoverable(bytes));
        }
    }

    match decode_hex(text) {
        Some(der) if !der.is_empty() => Ok(BsmsSignature::Der(der)),
        _ => Err(CliError::Usage(
            "that record's signature is neither a 65-byte base64 legacy signature nor DER hex, \
             so nothing proves the sender holds the key they offered"
                .into(),
        )),
    }
}

/// BIP-129 caps the description at 80 characters.
pub const BSMS_MAX_DESCRIPTION_CHARS: usize = 80;

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || text.is_empty() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(text.get(index..index + 2)?, 16).ok())
        .collect()
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

    /// The first receive address the two test cosigners produce as a 2-of-2.
    ///
    /// Pinned rather than derived in the test, so a change to derivation breaks
    /// this instead of quietly agreeing with itself.
    const BSMS_FIRST_ADDRESS: &str = "bchtest:pr09rncy7wrmcz4qvp36w4y3xcsfk38m559jqz3kz4";

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
    fn a_descriptor_this_wallet_wrote_reads_back_as_the_same_wallet() {
        // The round trip is the real test of both halves: whatever the text
        // means, it has to mean the same thing to us twice.
        let cosigners = two_cosigners();
        let account = AccountPath::new(145, 0).expect("in range");
        let set = descriptor_set(2, &cosigners, account).expect("exports");

        let parsed = parse_descriptor(&set.receive).expect("parses");
        assert_eq!(parsed.required, 2);
        assert_eq!(parsed.branches, vec![0]);
        assert!(parsed.checksum_verified);
        assert_eq!(parsed.keys.len(), 2);
        assert_eq!(parsed.keys[0].account_path, "m/44'/145'/0'");

        // And the addresses agree, which is the thing that actually matters.
        let original = multisig_preview(Network::Chipnet, 2, &cosigners).expect("preview");
        let reopened = multisig_preview(Network::Chipnet, 2, &parsed.cosigners()).expect("preview");
        assert_eq!(original.receive.address, reopened.receive.address);
        assert_eq!(original.change.address, reopened.change.address);

        assert_eq!(
            parse_descriptor(&set.change).expect("parses").branches,
            vec![1]
        );
    }

    #[test]
    fn a_mistyped_descriptor_is_refused_rather_than_opened_as_another_wallet() {
        // The failure this protects against is silent: a misread descriptor
        // builds a valid wallet at addresses the money is not at, and the
        // symptom is an empty balance.
        let cosigners = two_cosigners();
        let account = AccountPath::new(145, 0).expect("in range");
        let set = descriptor_set(2, &cosigners, account).expect("exports");

        let mut broken: Vec<char> = set.receive.chars().collect();
        let spot = 20;
        broken[spot] = if broken[spot] == 'q' { 'p' } else { 'q' };
        let broken: String = broken.into_iter().collect();

        let error = parse_descriptor(&broken).expect_err("must not open");
        assert!(
            error.to_string().contains("checksum does not match"),
            "{error}"
        );
        assert!(error.to_string().contains("different wallet"), "{error}");
    }

    #[test]
    fn multi_is_not_sortedmulti_and_saying_so_is_the_whole_point() {
        // They differ only in whether the keys are sorted per address, and
        // produce different addresses from the same keys. Reading one as the
        // other points the wallet at an empty set.
        let cosigners = two_cosigners();
        let account = AccountPath::new(145, 0).expect("in range");
        let sorted = descriptor_set(2, &cosigners, account).expect("exports");
        let body = sorted.receive.rsplit_once('#').expect("checksummed").0;
        let unsorted = body.replace("sortedmulti(", "multi(");
        let unsorted = with_descriptor_checksum(&unsorted).expect("checksums");

        let error = parse_descriptor(&unsorted).expect_err("must not open");
        assert!(error.to_string().contains("multi()"), "{error}");
        assert!(error.to_string().contains("different addresses"), "{error}");
    }

    #[test]
    fn a_bitcoin_descriptor_is_refused_as_being_for_another_chain() {
        // Bitcoin Cash has no witness scripts, so wsh() and tr() are not BCH
        // wallets. Opening one would present someone else's addresses as ours.
        for foreign in [
            "wsh(sortedmulti(2,[4c9a1f7b/48'/0'/0'/2']xpub661MyMwAqRbcF/0/*))",
            "tr(xpub661MyMwAqRbcF)",
        ] {
            let error = parse_descriptor(foreign).expect_err("wrong chain");
            assert!(
                error.to_string().contains("Bitcoin Cash has neither")
                    || error.to_string().contains("sortedmulti"),
                "{error}"
            );
        }
    }

    #[test]
    fn a_key_expression_has_to_be_exactly_what_it_claims() {
        let account = AccountPath::new(145, 0).expect("in range");
        let good = descriptor_set(2, &two_cosigners(), account).expect("exports");
        let body = good
            .receive
            .rsplit_once('#')
            .expect("checksummed")
            .0
            .to_string();

        // No key origin: loads elsewhere and cannot be signed against.
        let no_origin = body.replace("[4c9a1f7b/44'/145'/0']", "");
        assert!(parse_descriptor(&no_origin).is_err());

        // Hardened below the xPub needs the private key, so it is malformed
        // rather than merely unsupported.
        let hardened = body.replace("/0/*", "/0'/*");
        let error = parse_descriptor(&hardened).expect_err("hardened");
        assert!(
            error.to_string().contains("needs the private key"),
            "{error}"
        );

        // A key naming one address rather than a range is not a wallet.
        let single = body.replace("/0/*", "/0/7");
        assert!(parse_descriptor(&single).is_err());

        // Mixed branches describe receive for one cosigner and change for
        // another, which is not a wallet either.
        let mixed = body.replacen("/0/*", "/1/*", 1);
        let error = parse_descriptor(&mixed).expect_err("mixed branches");
        assert!(
            error
                .to_string()
                .contains("every key in one descriptor shares"),
            "{error}"
        );
    }

    #[test]
    fn the_same_refusals_apply_however_the_policy_arrives() {
        // A descriptor must not be a way around the checks the local path
        // makes -- otherwise "import" becomes the hole.
        let account = AccountPath::new(145, 0).expect("in range");
        let body = descriptor_set(2, &two_cosigners(), account)
            .expect("exports")
            .receive
            .rsplit_once('#')
            .expect("checksummed")
            .0
            .to_string();

        // Threshold above the cosigner count.
        let impossible = body.replace("sortedmulti(2,", "sortedmulti(5,");
        assert!(parse_descriptor(&impossible).is_err());

        // Zero threshold.
        let zero = body.replace("sortedmulti(2,", "sortedmulti(0,");
        assert!(parse_descriptor(&zero).is_err());

        // The same key twice is a wallet fewer people control than it looks.
        let keys: Vec<&str> = body
            .strip_prefix("sh(sortedmulti(2,")
            .and_then(|rest| rest.strip_suffix("))"))
            .expect("shape")
            .split(',')
            .collect();
        let duplicated = format!("sh(sortedmulti(2,{},{}))", keys[0], keys[0]);
        let error = parse_descriptor(&duplicated).expect_err("duplicate key");
        assert!(error.to_string().contains("same key twice"), "{error}");

        // And nothing enormous is parsed at all.
        assert!(parse_descriptor(&"a".repeat(MAX_DESCRIPTOR_LEN + 1)).is_err());
        assert!(parse_descriptor("").is_err());
    }

    #[test]
    fn a_descriptor_without_a_checksum_opens_but_says_it_was_unchecked() {
        // The format makes the checksum optional, so refusing would lock out
        // legitimate wallets. Reporting it lets the caller say the wallet was
        // never proved to be typed correctly.
        let account = AccountPath::new(145, 0).expect("in range");
        let body = descriptor_set(2, &two_cosigners(), account)
            .expect("exports")
            .receive
            .rsplit_once('#')
            .expect("checksummed")
            .0
            .to_string();

        let parsed = parse_descriptor(&body).expect("opens");
        assert!(!parsed.checksum_verified, "and the caller can tell");
        assert_eq!(parsed.required, 2);
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

    /// A BSMS record in Paytaca's shape, over the same two cosigners.
    ///
    /// Multipath `<0;1>/*`, `sh(sortedmulti(...))`, `/0/*,/1/*` -- built the way
    /// `paytaca-app`'s `BsmsDescriptor.toString()` builds it, so what is being
    /// tested is their format rather than a convenient version of it.
    fn paytaca_shaped_record(first_address: &str) -> String {
        let account = AccountPath::new(145, 0).expect("in range");
        let set = descriptor_set(2, &two_cosigners(), account).expect("exports");
        let body = set.receive.rsplit_once('#').expect("checksummed").0;
        let multipath = body.replace("/0/*", "/<0;1>/*");
        format!("BSMS 1.0\n{multipath}\n/0/*,/1/*\n{first_address}")
    }

    #[test]
    fn a_multipath_descriptor_is_read_rather_than_refused() {
        // BIP-389. `<0;1>/*` is receive and change in one string, and it is
        // what Paytaca writes -- so refusing it would mean being unable to open
        // a wallet agreed with the wallet we interoperate with most.
        let account = AccountPath::new(145, 0).expect("in range");
        let set = descriptor_set(2, &two_cosigners(), account).expect("exports");
        let body = set.receive.rsplit_once('#').expect("checksummed").0;
        let multipath = body.replace("/0/*", "/<0;1>/*");

        let parsed = parse_descriptor(&multipath).expect("multipath parses");
        assert_eq!(parsed.branches, vec![0, 1], "receive and change, in order");
        assert_eq!(parsed.required, 2);
        assert_eq!(parsed.keys.len(), 2);

        // And the keys are the same ones the single-branch form carries, so
        // the two spellings describe one wallet rather than two.
        let single = parse_descriptor(&set.receive).expect("parses");
        assert_eq!(parsed.keys, single.keys);

        // A single-branch descriptor still reports one branch.
        assert_eq!(single.branches, vec![0]);
    }

    #[test]
    fn a_malformed_multipath_is_refused_rather_than_guessed_at() {
        let account = AccountPath::new(145, 0).expect("in range");
        let set = descriptor_set(2, &two_cosigners(), account).expect("exports");
        let body = set.receive.rsplit_once('#').expect("checksummed").0;

        // One branch in multipath brackets is just a branch written oddly, and
        // accepting it would mean accepting a form no wallet emits.
        let error = parse_descriptor(&body.replace("/0/*", "/<0>/*")).expect_err("one branch");
        assert!(
            error.to_string().contains("multipath of one branch"),
            "{error}"
        );

        // The same branch twice would derive one address and call it two.
        let error = parse_descriptor(&body.replace("/0/*", "/<0;0>/*")).expect_err("repeated");
        assert!(error.to_string().contains("twice"), "{error}");

        // Still not a number.
        let error = parse_descriptor(&body.replace("/0/*", "/<0;x>/*")).expect_err("not a number");
        assert!(error.to_string().contains("is not a number"), "{error}");

        // And cosigners that disagree about which branches they cover are not
        // one wallet, whichever spelling they disagree in.
        let mixed = body.replacen("/0/*", "/<0;1>/*", 1);
        let error = parse_descriptor(&mixed).expect_err("mixed");
        assert!(
            error
                .to_string()
                .contains("every key in one descriptor shares"),
            "{error}"
        );
    }

    /// Sign a key record the way BSMS does, so the digest is exercised in both
    /// directions rather than only asserted.
    ///
    /// The wallet crate never signs a key record in production -- a cosigner's
    /// own device does -- so this lives in the test, and it is what makes
    /// `verify_signature` a claim about bytes rather than about intent.
    fn signed_key_record(description: &str) -> (String, String) {
        use k256::ecdsa::signature::hazmat::PrehashSigner;

        let wallet = crate::hd::Wallet::from_mnemonic(crate::hd::BIP39_TEST_VECTOR_MNEMONIC, "")
            .expect("mnemonic");
        let xpub = wallet.account_xpub(Network::Chipnet, 0).expect("xpub");
        // The private key for that exact account, which is the key BIP-129
        // says signs: "the private key associated with the public key or XPUB".
        let signing = wallet
            .signing_key("m/44'/1'/0'")
            .expect("account signing key");

        let unsigned = BsmsKeyRecord {
            version: "1.0".into(),
            token: "00".into(),
            key: DescriptorKey {
                master_fingerprint: "4c9a1f7b".into(),
                account_path: "m/44'/1'/0'".into(),
                account_xpub: xpub.clone(),
            },
            description: description.to_string(),
            signature: BsmsSignature::Der(Vec::new()),
        };

        let (signature, _): (k256::ecdsa::Signature, _) = signing
            .sign_prehash(&unsigned.signing_digest())
            .expect("signs");
        let der: String = signature
            .to_der()
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();

        let record = format!("BSMS 1.0\n00\n[4c9a1f7b/44'/1'/0']{xpub}\n{description}\n{der}");
        (record, xpub)
    }

    /// BIP-129's own key records, from its Test Vectors section.
    ///
    /// Every test above signs a record here and verifies it, which proves the
    /// digest is built consistently but not that it is built *correctly* --
    /// two mistakes that cancel look exactly like success. These records were
    /// produced by someone else's signer against the published specification,
    /// so verifying them is the first evidence that this reads what the rest
    /// of the ecosystem writes.
    ///
    /// NO_ENCRYPTION mode, the xPub pair. Both use the legacy base64
    /// signature BIP-129 calls for, not the DER hex Paytaca writes.
    const BIP129_SIGNER_1: &str = concat!(
        "BSMS 1.0\n",
        "00\n",
        "[1cf0bf7e/48'/0'/0'/2']xpub6FL8FhxNNUVnG64YurPd16AfGyvFLhh7S2uSsDqR3Qfcm6o9jtcMYwh6DvmcBF9qozxNQmTCVvWtxLpKTnhVLN3Pgnu2D3pAoXYFgVyd8Yz\n",
        "Signer 1 key\n",
        "IB7v+qi1b+Xrwm/3bF+Rjl8QbIJ/FMQ40kUsOOQo1SqUWn5QlFWbBD8BKPRetfo1L1N7DmYjVscZNsmMrqRJGWw="
    );

    const BIP129_SIGNER_2: &str = concat!(
        "BSMS 1.0\n",
        "00\n",
        "[4fc1dd4a/48'/0'/0'/2']xpub6EebMbEps7ZcV3FYEnddRsvrFWDrt2tiPmCeM7pPXQEmphvq9ZfJ1LWFUDjf3vxCeBuPrfyGrMazWUsYsetrnHatQZVLJH7LsgCjtMqdzgj\n",
        "Signer 2 key\n",
        "HzUa4Z76PFHMl54flIIF3XKiHZ+KbWjjxCEG5G3ZqZSqTd6OgTiFFLqq9PXJXdfYm6/cnL8IVWQgjFF9DQhIqQs="
    );

    #[test]
    fn the_bip_129_key_record_vectors_are_read_and_verify() {
        for (label, raw, fingerprint, path) in [
            ("signer 1", BIP129_SIGNER_1, "1cf0bf7e", "m/48'/0'/0'/2'"),
            ("signer 2", BIP129_SIGNER_2, "4fc1dd4a", "m/48'/0'/0'/2'"),
        ] {
            let record = parse_bsms_key_record(raw)
                .unwrap_or_else(|error| panic!("{label} must parse: {error}"));

            assert_eq!(record.version, "1.0", "{label}");
            assert_eq!(record.token, "00", "{label}");
            assert_eq!(record.key.master_fingerprint, fingerprint, "{label}");
            assert_eq!(record.key.account_path, path, "{label}");
            assert!(
                matches!(record.signature, BsmsSignature::Recoverable(_)),
                "{label}: BIP-129's vectors are base64 legacy signatures"
            );

            record
                .verify_signature()
                .unwrap_or_else(|error| panic!("{label} must verify: {error}"));
        }
    }

    #[test]
    fn a_bip_129_vector_stops_verifying_once_it_is_edited() {
        // The vectors verifying is only worth something if a changed one does
        // not. This is the substitution BIP-129's round one exists to catch.
        let swapped = BIP129_SIGNER_1.replace(
            "xpub6FL8FhxNNUVnG64YurPd16AfGyvFLhh7S2uSsDqR3Qfcm6o9jtcMYwh6DvmcBF9qozxNQmTCVvWtxLpKTnhVLN3Pgnu2D3pAoXYFgVyd8Yz",
            "xpub6EebMbEps7ZcV3FYEnddRsvrFWDrt2tiPmCeM7pPXQEmphvq9ZfJ1LWFUDjf3vxCeBuPrfyGrMazWUsYsetrnHatQZVLJH7LsgCjtMqdzgj",
        );
        assert_ne!(swapped, BIP129_SIGNER_1);
        assert!(parse_bsms_key_record(&swapped)
            .expect("still parses")
            .verify_signature()
            .is_err());

        // The description is inside the signed preimage too.
        let reworded = BIP129_SIGNER_1.replace("Signer 1 key", "Signer 9 key");
        assert!(parse_bsms_key_record(&reworded)
            .expect("still parses")
            .verify_signature()
            .is_err());
    }

    #[test]
    fn a_key_record_round_trips_and_its_signature_verifies() {
        let (text, xpub) = signed_key_record("Ada's phone");
        let record = parse_bsms_key_record(&text).expect("reads");

        assert_eq!(record.version, "1.0");
        assert_eq!(record.token, "00");
        assert_eq!(record.description, "Ada's phone");
        assert_eq!(record.key.account_xpub, xpub);
        assert_eq!(record.key.master_fingerprint, "4c9a1f7b");
        assert_eq!(record.key.account_path, "m/44'/1'/0'");

        // The preimage is the four lines above the signature, exactly.
        assert_eq!(
            record.preimage(),
            format!("BSMS 1.0\n00\n[4c9a1f7b/44'/1'/0']{xpub}\nAda's phone")
        );

        record
            .verify_signature()
            .expect("a record signed by its own key verifies");
    }

    #[test]
    fn a_substituted_key_is_caught_which_is_why_the_signature_is_there() {
        // BIP-129's reason for round one carrying a signature at all: without
        // it, anyone who can edit a record in transit swaps in their own key
        // and the wallet that results is one they can spend from.
        let (text, _) = signed_key_record("Ada's phone");
        let wallet = crate::hd::Wallet::from_mnemonic(crate::hd::BIP39_TEST_VECTOR_MNEMONIC, "")
            .expect("mnemonic");
        let attacker = wallet.account_xpub(Network::Chipnet, 7).expect("xpub");

        let original = parse_bsms_key_record(&text).expect("reads");
        let swapped = text.replace(&original.key.account_xpub, &attacker);
        assert_ne!(swapped, text, "the swap has to change something");

        let tampered = parse_bsms_key_record(&swapped).expect("still parses");
        let error = tampered
            .verify_signature()
            .expect_err("a swapped key must not verify");
        assert!(
            error.to_string().contains("does not match the key"),
            "{error}"
        );
        assert!(error.to_string().contains("changed the record"), "{error}");

        // Editing the description is caught too: it is inside the preimage.
        let reworded = text.replace("Ada's phone", "Ada's laptop");
        assert!(parse_bsms_key_record(&reworded)
            .expect("parses")
            .verify_signature()
            .is_err());
    }

    #[test]
    fn a_key_record_never_reaches_the_length_where_encodings_diverge() {
        // Written first as "a maximal record crosses 253 bytes, which is what
        // proves CompactSize was implemented". It does not: a record with the
        // full 80-character description BIP-129 allows, an xPub and an origin
        // comes to 224 bytes, and both length encodings are a single byte
        // there.
        //
        // So the Electron Cash / mainnet-js divergence Paytaca warns about
        // cannot affect a key record, and this wallet interoperates with a
        // signer of either persuasion. That is a better thing to know than the
        // hazard it was mistaken for, and it is pinned here so that it stops
        // being true loudly rather than quietly if the format grows.
        let (text, _) = signed_key_record(&"x".repeat(BSMS_MAX_DESCRIPTION_CHARS));
        let record = parse_bsms_key_record(&text).expect("reads");
        assert_eq!(record.preimage().len(), 224);
        assert!(
            record.preimage().len() <= 0xfc,
            "a key record has grown past the CompactSize boundary: the length prefix now              differs between Electron Cash and mainnet-js signers, and this must be checked              against a real one rather than assumed"
        );
        record
            .verify_signature()
            .expect("a maximal record verifies");

        // The encoder itself is right on both sides of the boundary, which is
        // what makes the choice safe when a longer message does come along.
        assert_eq!(crate::psbt::compact_size(0xfc), vec![0xfc]);
        assert_eq!(crate::psbt::compact_size(0xfd), vec![0xfd, 0xfd, 0x00]);

        // One character over the spec is refused.
        let (too_long, _) = signed_key_record(&"x".repeat(BSMS_MAX_DESCRIPTION_CHARS + 1));
        let error = parse_bsms_key_record(&too_long).expect_err("over the cap");
        assert!(error.to_string().contains("BSMS allows 80"), "{error}");
    }

    #[test]
    fn a_key_record_is_refused_rather_than_half_read() {
        let (good, _) = signed_key_record("Ada's phone");

        // An encrypted record is named as such rather than failing on the
        // descriptor line, because "token 01" is a different situation from a
        // corrupt file.
        let encrypted = good.replacen("\n00\n", "\n01\n", 1);
        let error = parse_bsms_key_record(&encrypted).expect_err("encrypted");
        assert!(error.to_string().contains("encrypted"), "{error}");
        assert!(error.to_string().contains("ECIES"), "{error}");

        // A missing signature is the whole point of the record.
        let unsigned = good.rsplit_once('\n').expect("has lines").0.to_string();
        let error = parse_bsms_key_record(&unsigned).expect_err("no signature");
        assert!(error.to_string().contains("nothing proves"), "{error}");

        // Not hex, and not a version this reads.
        assert!(parse_bsms_key_record(&good.replace("BSMS 1.0", "BSMS 2.0")).is_err());
        assert!(parse_bsms_key_record("").is_err());
        let (base, _) = signed_key_record("Ada's phone");
        let bad_sig = base.rsplit_once('\n').expect("lines").0.to_string() + "\nnothex";
        assert!(parse_bsms_key_record(&bad_sig).is_err());

        // A key descriptor with no origin cannot be signed against later.
        let no_origin = good.replace("[4c9a1f7b/44'/1'/0']", "");
        assert!(parse_bsms_key_record(&no_origin).is_err());
    }

    #[test]
    fn a_bsms_record_is_read_whole() {
        let record = parse_bsms_record(&paytaca_shaped_record(BSMS_FIRST_ADDRESS)).expect("reads");

        assert_eq!(record.version, "1.0");
        assert_eq!(record.path_restrictions, vec!["/0/*", "/1/*"]);
        assert_eq!(record.first_address, BSMS_FIRST_ADDRESS);
        assert_eq!(record.descriptor.required, 2);
        assert_eq!(record.descriptor.branches, vec![0, 1]);

        // Trailing whitespace and a trailing newline are how files arrive.
        let padded = format!("  {}  \n", paytaca_shaped_record(BSMS_FIRST_ADDRESS));
        assert_eq!(parse_bsms_record(&padded).expect("reads"), record);
    }

    #[test]
    fn the_first_address_is_checked_against_the_policy_rather_than_trusted() {
        // The reason BSMS carries a fourth line at all. A policy altered in
        // transit -- a key swapped, a threshold edited -- produces a different
        // first address, and the mismatch is the only warning anyone gets.
        let record = parse_bsms_record(&paytaca_shaped_record(BSMS_FIRST_ADDRESS)).expect("reads");
        record
            .verify_first_address(Network::Chipnet)
            .expect("the record describes the wallet it claims to");

        // Now the same policy with the address of a *different* wallet, which
        // is what an altered record looks like from here.
        let tampered = parse_bsms_record(&paytaca_shaped_record(
            "bchtest:ppttar4f8yf0xa592s4z4pj22cq03zn82syer0akm8",
        ))
        .expect("reads");
        let error = tampered
            .verify_first_address(Network::Chipnet)
            .expect_err("must not accept an address the policy does not produce");
        assert!(error.to_string().contains("does not match"), "{error}");
        assert!(error.to_string().contains("Something changed"), "{error}");

        // Mainnet derives different addresses, so the record does not verify
        // against the wrong network either.
        assert!(record.verify_first_address(Network::Mainnet).is_err());
    }

    #[test]
    fn a_record_missing_the_check_is_refused() {
        let full = paytaca_shaped_record(BSMS_FIRST_ADDRESS);
        let lines: Vec<&str> = full.lines().collect();

        // No fourth line: nothing can check the policy survived the trip, so
        // the record is not usable even though the descriptor in it parses.
        let truncated = lines[..3].join("\n");
        let error = parse_bsms_record(&truncated).expect_err("no first address");
        assert!(error.to_string().contains("first address"), "{error}");

        // A blank one is the same thing, spelled differently.
        let blank = format!("{}\n   ", lines[..3].join("\n"));
        assert!(parse_bsms_record(&blank).is_err());

        // Wrong header, and a version this does not know.
        assert!(parse_bsms_record("BSMS 2.0\nx\ny\nz").is_err());
        let error =
            parse_bsms_record(&full.replace("BSMS 1.0", "BSMS 1.0.1")).expect_err("version");
        assert!(error.to_string().contains("BSMS 1.0"), "{error}");
        assert!(parse_bsms_record(&full.replace("BSMS 1.0\n", "")).is_err());
        assert!(parse_bsms_record("").is_err());
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
    fn this_agrees_with_electron_cash_byte_for_byte() {
        // An implementation nobody here wrote. Electron Cash 4.4.5 was asked
        // for the same 2-of-2 on chipnet and returned the same redeem script
        // and the same address; the commands and output are in
        // docs/multisig-interop.md.
        //
        // Its createmultisig does *not* sort -- multisig_script keeps the order
        // it is given -- so the keys are handed over already BIP-67 sorted.
        // That is deliberate: it checks our script construction against theirs
        // without our sorting and their lack of it covering for each other.
        const SORTED_KEYS: [&str; 2] = [
            "02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f",
            "02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8",
        ];
        const EC_REDEEM_SCRIPT: &str = "522102fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f2102ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f852ae";
        const EC_CASHADDR: &str = "bchtest:ppttar4f8yf0xa592s4z4pj22cq03zn82syer0akm8";

        fn key(hex: &str) -> [u8; 33] {
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
                .collect();
            let mut out = [0u8; 33];
            out.copy_from_slice(&bytes);
            out
        }

        let script = redeem_script(2, &[key(SORTED_KEYS[0]), key(SORTED_KEYS[1])]).expect("2-of-2");
        let script_hex: String = script.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            script_hex, EC_REDEEM_SCRIPT,
            "Electron Cash builds this script"
        );
        assert_eq!(p2sh_address(Network::Chipnet, &script, false), EC_CASHADDR);

        // And handing it the keys the other way round still lands here,
        // because this sorts and Electron Cash does not. Reversed, its own
        // answer is a different address entirely -- which is what BIP-67 is
        // for, and why the sort cannot be skipped.
        let reversed =
            redeem_script(2, &[key(SORTED_KEYS[1]), key(SORTED_KEYS[0])]).expect("2-of-2");
        assert_eq!(reversed, script, "input order must not reach the script");
    }

    #[test]
    fn this_agrees_with_optn_multisig_core_byte_for_byte() {
        // `optn-multisig-core` is a second Rust implementation of this same
        // derivation, merged in #65. Two implementations that disagree would
        // put a wallet's coins at an address it does not watch, so these are
        // *its* published vectors run against this code -- not vectors
        // generated here, which would only prove self-consistency.
        //
        // These are transcribed, and transcription only proves the copy was
        // accurate. Now that both crates are in the tree, the two are also
        // run against each other directly in
        // crates/optn-cli/tests/multisig_cross_implementation.rs, which is the
        // only crate depending on both. This test stays because optn-core
        // carries no dev-dependencies and should still fail on its own if the
        // derivation moves.
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

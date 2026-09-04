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
    parse_account_xpub(xpub)?;

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

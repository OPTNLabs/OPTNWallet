//! BCH Reusable Payment Addresses — cashcodes.
//!
//! Spec: <https://github.com/imaginaryusername/Reusable_specs/blob/master/reusable_addresses.md>
//!
//! The recipient publishes one static code carrying a scan pubkey and a spend
//! pubkey. Each sender derives a fresh one-time P2PKH from ECDH against the
//! scan key plus the first input's outpoint, so nothing on chain links two
//! payments to the same code.
//!
//! Keys are compressed everywhere, including the CKD_pub child that gets
//! hashed into the payment address. The spec says so in as many words —
//! "Addresses should always be generated from compressed pubkeys" — and
//! Selene's bch-rpa hashes the compressed child. Electron Cash's `paycode.py`
//! sets `use_uncompressed = True` two lines under a comment saying it uses
//! compressed keys; upstream PR #3225 calls that unintentional. We follow the
//! spec, matching the desktop wallet's `RpaService.ts`.
//!
//! The name shown to a user is **Cash Code**, and `cashcode:` /
//! `cashcodetest:` is the only prefix family this module encodes or accepts.
//!
//! `paycode:` / `paycodetest:` is Electron Cash's **legacy PayCode**, a
//! different implementation, and it is rejected outright. That is not
//! backward compatibility and the two prefixes are not interchangeable: a
//! legacy PayCode carries keys its owner derived under the legacy rules,
//! including `use_uncompressed = True`. Decoding one here and then deriving
//! the destination with the compressed Cash Code rules above yields a P2PKH
//! address the legacy recipient never derived and cannot scan for, so the
//! payment would be unspendable by them while looking perfectly successful to
//! the sender. Rejecting the prefix is the only safe reading of it; the
//! distinct `cashcode:` prefix exists precisely to keep the two apart.
//!
//! Supporting legacy PayCode would mean implementing its semantics, not
//! relabelling its prefix. This module does not do that.

use hmac::{Hmac, Mac};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, ProjectivePoint, PublicKey, Scalar};
use sha2::{Digest, Sha256, Sha512};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::cashaddr::{encode_payload, Address, AddressKind, CHARSET};
use crate::error::{CliError, Result};
use crate::hd::{hash160, Wallet};
use crate::network::Network;

/// RPA rides the wallet's BIP44 account as a third unhardened chain, sibling
/// to receive(0)/change(1). Same as the desktop wallet, and what
/// CHIP-2026-paths converges on.
pub const RPA_BRANCH: u32 = 3;

/// Bits of the scan pubkey senders grind into the input hash. 16 is the
/// Electron Cash default and what the desktop wallet emits.
pub const RPA_PREFIX_BITS: u8 = 16;

const VERSION_MAINNET: u8 = 0x01;
const VERSION_TESTNET: u8 = 0x05;

const CASHCODE_MAINNET: &str = "cashcode";
const CASHCODE_TESTNET: &str = "cashcodetest";

/// Electron Cash's legacy PayCode prefixes. Recognised only so a legacy
/// string can be refused by name — never to decode one. Keeping them out of
/// the accepted-prefix lists below is what makes the refusal structural
/// rather than a check someone can forget to call.
const LEGACY_MAINNET: &str = "paycode";
const LEGACY_TESTNET: &str = "paycodetest";

const MAINNET_PREFIXES: [&str; 1] = [CASHCODE_MAINNET];
const TESTNET_PREFIXES: [&str; 1] = [CASHCODE_TESTNET];

/// The message a user sees when they paste a legacy PayCode.
///
/// Deliberately not phrased as a temporary limitation: OPTN does not
/// implement legacy PayCode, so there is nothing here to wait for.
pub const LEGACY_PAYCODE_REJECTION: &str =
    "Legacy PayCode addresses are not supported. Use a Cash Code address.";

/// True if the string carries a legacy PayCode prefix.
///
/// Callers use this to explain the refusal. It is deliberately separate from
/// [`looks_like_rpa`], which answers "is this a recipient we can pay" — and
/// for a legacy PayCode the answer to that is no.
pub fn is_legacy_paycode(candidate: &str) -> bool {
    let bare = candidate
        .trim()
        .split('?')
        .next()
        .unwrap_or("")
        .to_lowercase();
    bare.starts_with(&format!("{LEGACY_MAINNET}:"))
        || bare.starts_with(&format!("{LEGACY_TESTNET}:"))
}

/// Payload is version + prefix_bits + scan(33) + spend(33) + expiry(4).
const PAYLOAD_LEN: usize = 72;

/// `m/44'/<coin>'/<account>'/3/0`
pub fn scan_path(coin_type: u32, account: u32) -> String {
    format!("m/44'/{coin_type}'/{account}'/{RPA_BRANCH}/0")
}

/// `m/44'/<coin>'/<account>'/3/1`
pub fn spend_path(coin_type: u32, account: u32) -> String {
    format!("m/44'/{coin_type}'/{account}'/{RPA_BRANCH}/1")
}

/// RPA key material derived once in the shared core for CLI and app surfaces.
///
/// Deliberately has no `Debug` implementation: it contains private keys.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct RpaKeys {
    pub scan_privkey: [u8; 32],
    pub scan_pubkey: [u8; 33],
    pub spend_privkey: [u8; 32],
    pub spend_pubkey: [u8; 33],
}

pub fn derive_keys_from_paths(
    mnemonic: &str,
    passphrase: &str,
    scan_path: &str,
    spend_path: &str,
) -> Result<RpaKeys> {
    let wallet = Wallet::from_mnemonic(mnemonic, passphrase)?;
    Ok(RpaKeys {
        scan_privkey: wallet.signing_key(scan_path)?.to_bytes().into(),
        scan_pubkey: wallet.public_key(scan_path)?,
        spend_privkey: wallet.signing_key(spend_path)?.to_bytes().into(),
        spend_pubkey: wallet.public_key(spend_path)?,
    })
}

/// A decoded cashcode.
///
/// There is no `legacy` flag: a legacy PayCode never decodes, so every value
/// of this type came from a `cashcode:` / `cashcodetest:` string. A flag
/// would only invite a caller to decode one and then decide what to do,
/// which is the mistake this module exists to prevent.
#[derive(Debug, Clone)]
pub struct Cashcode {
    pub version: u8,
    pub prefix_bits: u8,
    pub scan_pubkey: [u8; 33],
    pub spend_pubkey: [u8; 33],
    pub expiry: u32,
    /// The prefix the string actually carried.
    pub prefix: String,
}

impl Cashcode {
    pub fn network(&self) -> Network {
        if self.version == 0x01 || self.version == 0x02 {
            Network::Mainnet
        } else {
            Network::Chipnet
        }
    }
}

/// Encode a scan/spend pair as a `cashcode:` string.
///
/// Not standard CashAddr: the usual version byte packs the payload size into
/// three bits and caps it at 64 bytes, and this payload is 73 with the kind
/// byte. Electron Cash's `cashaddr.py` added encode_rpa/decode_rpa for the
/// same reason — same charset and checksum, no version byte, no length cap.
///
/// There is no prefix-family parameter: `cashcode:` / `cashcodetest:` is the
/// only prefix this crate emits, and no caller — production or test — can ask
/// it for a legacy PayCode.
pub fn encode(
    scan_pubkey: &[u8; 33],
    spend_pubkey: &[u8; 33],
    network: Network,
    prefix_bits: u8,
) -> String {
    let mut payload = [0u8; PAYLOAD_LEN];
    payload[0] = match network {
        Network::Mainnet => VERSION_MAINNET,
        // Regtest shares the testnet payload version, as it shares the
        // testnet coin type.
        Network::Chipnet | Network::Regtest => VERSION_TESTNET,
    };
    payload[1] = prefix_bits;
    payload[2..35].copy_from_slice(scan_pubkey);
    payload[35..68].copy_from_slice(spend_pubkey);
    // 68..72 stay zero: no expiry.

    let prefix = match network {
        Network::Mainnet => CASHCODE_MAINNET,
        Network::Chipnet | Network::Regtest => CASHCODE_TESTNET,
    };

    // Leading kind byte, as the desktop wallet and Electron Cash both write.
    let mut with_kind = Vec::with_capacity(PAYLOAD_LEN + 1);
    with_kind.push(0x00);
    with_kind.extend_from_slice(&payload);
    encode_payload(prefix, &with_kind)
}

/// True if the string carries a prefix this wallet can actually pay — that
/// is, a Cash Code.
///
/// A legacy PayCode returns false. The question this answers is "route this
/// recipient down the RPA path", and routing a legacy PayCode there is the
/// bug. Use [`is_legacy_paycode`] to tell a user *why* their string was
/// refused.
pub fn looks_like_rpa(candidate: &str) -> bool {
    let bare = candidate
        .trim()
        .split('?')
        .next()
        .unwrap_or("")
        .to_lowercase();
    MAINNET_PREFIXES
        .iter()
        .chain(TESTNET_PREFIXES.iter())
        .any(|p| bare.starts_with(&format!("{p}:")))
}

/// Decode a Cash Code. Rejects a bad checksum before any sender-side work
/// happens.
///
/// A legacy PayCode is refused here, first, by prefix — before the checksum
/// is even looked at. A legacy string is perfectly well-formed and would pass
/// every structural check below, so nothing later in this function would stop
/// it; the refusal has to be up front or it does not happen at all.
pub fn decode(code: &str) -> Result<Cashcode> {
    if is_legacy_paycode(code) {
        return Err(CliError::Usage(LEGACY_PAYCODE_REJECTION.to_string()));
    }
    let bare = code.trim().split('?').next().unwrap_or("");
    let has_lower = bare != bare.to_uppercase();
    let has_upper = bare != bare.to_lowercase();
    if has_lower && has_upper {
        return Err(CliError::Usage(
            "a payment code must not mix upper and lower case".to_string(),
        ));
    }
    let normalized = bare.to_lowercase();
    let (prefix, body) = normalized
        .split_once(':')
        .ok_or_else(|| CliError::Usage(format!("'{code}' has no prefix")))?;
    if body.len() <= 8 {
        return Err(CliError::Usage("payment code is too short".to_string()));
    }

    let values: Vec<u8> = body
        .chars()
        .map(|c| {
            CHARSET
                .iter()
                .position(|&x| x == c as u8)
                .map(|i| i as u8)
                .ok_or_else(|| CliError::Usage(format!("'{c}' is not a CashAddr character")))
        })
        .collect::<Result<_>>()?;

    // Same prefix-expanded polymod as an ordinary CashAddr. One changed
    // character has to fail here, not later.
    let checksum_input: Vec<u8> = prefix
        .bytes()
        .map(|b| b & 0x1f)
        .chain(std::iter::once(0))
        .chain(values.iter().copied())
        .collect();
    if crate::cashaddr::polymod(&checksum_input) != 0 {
        return Err(CliError::Usage(
            "payment code checksum does not match — it was mistyped or truncated".to_string(),
        ));
    }

    let payload8 = crate::cashaddr::convert_bits(&values[..values.len() - 8], 5, 8, false)
        .ok_or_else(|| CliError::Usage("payment code does not convert to bytes".to_string()))?;

    if payload8.len() != PAYLOAD_LEN + 1 || payload8[0] != 0x00 {
        return Err(CliError::Usage(
            "payment code is not a reusable payment address".to_string(),
        ));
    }
    let p = &payload8[1..];

    let is_mainnet_version = p[0] == 0x01 || p[0] == 0x02;
    let is_testnet_version = p[0] == 0x05 || p[0] == 0x06;
    let prefix_is_mainnet = MAINNET_PREFIXES.contains(&prefix);
    let prefix_is_testnet = TESTNET_PREFIXES.contains(&prefix);
    if !((prefix_is_mainnet && is_mainnet_version) || (prefix_is_testnet && is_testnet_version)) {
        return Err(CliError::Usage(format!(
            "payment code prefix '{prefix}' does not match its version byte {:#04x}",
            p[0]
        )));
    }
    if ![0u8, 4, 8, 12, 16].contains(&p[1]) {
        return Err(CliError::Usage(format!(
            "prefix size {} is not one of 0, 4, 8, 12, 16 bits",
            p[1]
        )));
    }

    let mut scan_pubkey = [0u8; 33];
    let mut spend_pubkey = [0u8; 33];
    scan_pubkey.copy_from_slice(&p[2..35]);
    spend_pubkey.copy_from_slice(&p[35..68]);
    if PublicKey::from_sec1_bytes(&scan_pubkey).is_err() {
        return Err(CliError::Usage(
            "scan pubkey is not a curve point".to_string(),
        ));
    }
    if PublicKey::from_sec1_bytes(&spend_pubkey).is_err() {
        return Err(CliError::Usage(
            "spend pubkey is not a curve point".to_string(),
        ));
    }

    Ok(Cashcode {
        version: p[0],
        prefix_bits: p[1],
        scan_pubkey,
        spend_pubkey,
        // Little-endian, matching the desktop wallet's decoder.
        expiry: u32::from_le_bytes([p[68], p[69], p[70], p[71]]),
        prefix: prefix.to_string(),
    })
}

/// Why this code must not be paid on-chain, if it must not be.
///
/// Mirrors `getRpaSendBlockReason` in the desktop wallet's RpaService.ts. Both
/// refusals are about a recipient who is not watching the chain, so a payment
/// would be theirs to spend and yet never looked for.
///
/// Electron Cash does neither check: `paycode.py` assigns
/// `paycode_field_version` and never reads it again, so it pays these on-chain
/// regardless.
pub fn send_block_reason(code: &Cashcode) -> Option<String> {
    // Spec: "1 and 2 for p2pkh (mainnet), 5 and 6 for p2pkh (testnet), among
    // them 2 and 6 to force offline-communication only", and an offchain relay
    // is "a necessity for version 2, 4, 6 and 8".
    if code.version == 0x02 || code.version == 0x06 {
        return Some(
            "this Cash Code is marked offline-only: the recipient expects payment \
             details out of band, not on-chain"
                .to_string(),
        );
    }
    // Spec: prefix_size 0 is "no-filter for full-node or offline-communications".
    // decode() accepts it, but grind_string rejects it, and grinding only
    // happens after coin selection - so without this the refusal arrives late
    // and reads as an internal error rather than a declined code.
    if code.prefix_bits == 0 {
        return Some(
            "this Cash Code carries no scan prefix, so the recipient is not watching \
             the chain for it"
                .to_string(),
        );
    }
    None
}

/// How many nSequence values a sender should be willing to try before giving
/// up on one transaction shape.
///
/// The grind looks for an input hash whose hex begins with `prefix_bits/4`
/// characters, so each attempt succeeds with probability 2^-prefix_bits and
/// the count needed is geometric with mean 2^prefix_bits. A fixed budget is
/// therefore wrong at both ends: 100_000 was ~1.5x the mean at 16 bits, which
/// exhausts about 21.7% of the time (1 - e^-1.53), while at 4 bits the same
/// number is 6000x more than could ever be needed.
///
/// Eight times the mean puts exhaustion near 1 in 2900 (e^-8). That is the
/// useful knob: an attempt costs a signature and two SHA-256s, about 36us
/// measured, and the *typical* grind still stops at the mean — roughly 2.4s
/// at 16 bits — no matter how high the ceiling is. Raising it only lengthens
/// the rare unlucky tail, to about 19s, and the caller is expected to reshape
/// the transaction rather than surface even that.
///
/// Kept here rather than in each sender so the CLI and the wallet cannot
/// disagree about how hard they try; both had their own `MAX_GRIND_TRIES` of
/// 100_000, which is exactly the sort of drift this crate exists to stop.
pub fn grind_budget(prefix_bits: u8) -> Result<u32> {
    if !matches!(prefix_bits, 4 | 8 | 12 | 16) {
        return Err(CliError::Usage(format!(
            "unsupported Cash Code prefix size: {prefix_bits} bits"
        )));
    }
    Ok(8u32 << prefix_bits)
}

/// The nSequence to try on attempt `offset`, counting down from `0xffffffff`.
///
/// Staying at or above `0x8000_0000` keeps bit 31 set, which is what marks a
/// sequence BIP68-final: below it the value becomes a relative timelock and
/// the transaction stops being spendable on the terms the sender intended.
/// That leaves 2^31 usable values, far more than any budget above, but the
/// bound has to be enforced rather than assumed — the desktop sender already
/// says so in a comment, and this is that comment made executable.
pub fn grind_sequence(offset: u32) -> Result<u32> {
    0xffff_ffffu32
        .checked_sub(offset)
        .filter(|s| *s >= 0x8000_0000)
        .ok_or_else(|| {
            CliError::Usage("RPA grind exhausted BIP68-final nSequence values".to_string())
        })
}

/// What a successful grind produces.
pub struct GroundTransaction {
    /// The signed transaction, ready to broadcast.
    pub raw: Vec<u8>,
    /// Attempts used, counting the one that matched.
    pub grind_tries: u32,
    /// The nSequence that matched.
    pub sequence: u32,
}

/// Grind `transaction`'s nSequence until input 0 hashes to the recipient's
/// scan prefix, and return the signed result.
///
/// This is the loop itself, not just a constant, and it lives here because the
/// alternative is what the repository actually had: one copy in the CLI and
/// another in the desktop sender, each signing and hashing independently and
/// each with its own ceiling. A sender that grinds differently from the
/// recipient's expectations does not fail loudly — it produces a payment that
/// is on chain, correct, and invisible to the person who was paid.
///
/// `Ok(None)` means the budget ran out. That is a reshape signal, not an
/// error: the caller should choose different coins, which changes input 0 and
/// so re-rolls the search, and only report failure once it is out of coins.
pub fn grind_transaction(
    transaction: &mut crate::tx::Transaction,
    keys: &[k256::ecdsa::SigningKey],
    scan_pubkey: &[u8; 33],
    prefix_bits: u8,
) -> Result<Option<GroundTransaction>> {
    let target = grind_string(scan_pubkey, prefix_bits)?.to_lowercase();
    let budget = grind_budget(prefix_bits)?;
    for offset in 0..budget {
        transaction.sequence = grind_sequence(offset)?;
        let (raw, script_sigs) = transaction.sign_detailed(keys)?;
        let serialized = transaction.serialize_input(0, &script_sigs[0])?;
        let digest: String = crate::tx::double_sha256(&serialized)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if digest.starts_with(&target) {
            return Ok(Some(GroundTransaction {
                raw,
                grind_tries: offset + 1,
                sequence: transaction.sequence,
            }));
        }
    }
    Ok(None)
}

/// The hex a sender grinds the input hash to match: the scan pubkey's hex
/// after the 02/03 byte, truncated to `prefix_bits`.
pub fn grind_string(scan_pubkey: &[u8; 33], prefix_bits: u8) -> Result<String> {
    if !matches!(prefix_bits, 4 | 8 | 12 | 16) {
        return Err(CliError::Usage(format!(
            "unsupported Cash Code prefix size: {prefix_bits} bits"
        )));
    }
    let chars = (prefix_bits / 4) as usize;
    let hex: String = scan_pubkey.iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex[2..2 + chars].to_uppercase())
}

/// Add two 32-byte big-endian integers, returning the minimal big-endian
/// encoding of the sum.
///
/// Length here is load-bearing, not cosmetic. The reference hashes the sum's
/// natural byte length, so a carry makes it 33 bytes and a small sum makes it
/// fewer than 32 — and the digest changes with it. Both sides must agree or
/// no payment is ever detected.
fn add_be_minimal(a: &[u8; 32], b: &[u8; 32]) -> Vec<u8> {
    let mut sum = [0u8; 33];
    let mut carry: u16 = 0;
    for i in (0..32).rev() {
        let total = u16::from(a[i]) + u16::from(b[i]) + carry;
        sum[i + 1] = (total & 0xff) as u8;
        carry = total >> 8;
    }
    sum[0] = carry as u8;
    let first = sum.iter().position(|&b| b != 0).unwrap_or(sum.len() - 1);
    sum[first..].to_vec()
}

/// The shared secret both sides compute, from Electron Cash's paycode.py:
///
/// ```text
/// ecdh      = privkey * pubkey
/// sha_ecdh  = SHA256(0x00 || ecdh.x)
/// hash_out  = SHA256(utf8(txid_display || vout))
/// secret    = SHA256(be_bytes(int(sha_ecdh) + int(hash_out)))
/// ```
///
/// `txid` is the display (Electrum) form, and `vout` is decimal with no
/// separator — the string is hashed exactly as written.
pub fn shared_secret(
    privkey: &[u8; 32],
    counterpart_pubkey: &[u8; 33],
    txid: &str,
    vout: u32,
) -> Result<[u8; 32]> {
    let point = PublicKey::from_sec1_bytes(counterpart_pubkey)
        .map_err(|_| CliError::Usage("counterpart pubkey is not a curve point".to_string()))?;
    let scalar = scalar_from_bytes(privkey)?;
    let product = (point.to_projective() * scalar).to_affine();
    let encoded = product.to_encoded_point(false);
    let x = encoded
        .x()
        .ok_or_else(|| CliError::Internal("ECDH product has no x coordinate".to_string()))?;

    let mut ecdh_x = [0u8; 33];
    ecdh_x[1..].copy_from_slice(x);
    let sha_ecdh: [u8; 32] = Sha256::digest(ecdh_x).into();

    let hash_out: [u8; 32] = Sha256::digest(format!("{txid}{vout}").as_bytes()).into();

    let grand_sum = add_be_minimal(&sha_ecdh, &hash_out);
    Ok(Sha256::digest(grand_sum).into())
}

fn scalar_from_bytes(bytes: &[u8; 32]) -> Result<Scalar> {
    let opt = Scalar::from_repr((*bytes).into());
    Option::from(opt).ok_or_else(|| CliError::Usage("private key is out of range".to_string()))
}

/// I = HMAC-SHA512(key = secret, data = pubkey || index_be32); IL is the tweak.
fn ckd_tweak(secret: &[u8; 32], pubkey: &[u8; 33], index: u32) -> Result<[u8; 32]> {
    let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(secret)
        .map_err(|e| CliError::Internal(format!("HMAC key rejected: {e}")))?;
    mac.update(pubkey);
    mac.update(&index.to_be_bytes());
    let out = mac.finalize().into_bytes();
    let mut tweak = [0u8; 32];
    tweak.copy_from_slice(&out[..32]);
    Ok(tweak)
}

/// The one-time P2PKH a sender pays, `CKD_pub(spend_pubkey, secret, index)`
/// hashed **compressed**.
pub fn payment_address(
    spend_pubkey: &[u8; 33],
    secret: &[u8; 32],
    network: Network,
    index: u32,
) -> Result<Address> {
    let parent = PublicKey::from_sec1_bytes(spend_pubkey)
        .map_err(|_| CliError::Usage("spend pubkey is not a curve point".to_string()))?;
    let tweak = scalar_from_bytes(&ckd_tweak(secret, spend_pubkey, index)?)?;
    let child: AffinePoint =
        (parent.to_projective() + ProjectivePoint::GENERATOR * tweak).to_affine();
    let compressed = child.to_encoded_point(true);
    Ok(Address::from_hash(
        network.prefix(),
        AddressKind::P2pkh,
        hash160(compressed.as_bytes()),
    ))
}

/// The private key for a payment at `index`: `(spend_privkey + tweak) mod n`.
pub fn spending_key(spend_privkey: &[u8; 32], secret: &[u8; 32], index: u32) -> Result<[u8; 32]> {
    let parent = scalar_from_bytes(spend_privkey)?;
    let pubkey = k256::SecretKey::from_slice(spend_privkey)
        .map_err(|e| CliError::Usage(format!("invalid spend private key: {e}")))?
        .public_key()
        .to_encoded_point(true);
    let mut parent_pub = [0u8; 33];
    parent_pub.copy_from_slice(pubkey.as_bytes());

    let tweak = scalar_from_bytes(&ckd_tweak(secret, &parent_pub, index)?)?;
    let child = parent + tweak;
    if bool::from(child.is_zero()) {
        return Err(CliError::Internal(
            "derived spending key is zero — astronomically unlikely".to_string(),
        ));
    }
    Ok(child.to_bytes().into())
}

/// The address the derived spending key actually controls.
///
/// Detecting a payment is not the same as being able to move it. Comparing
/// this against the address that was paid turns "we think this is ours" into
/// proof, and it is the check that would have failed had the compressed /
/// uncompressed question been decided wrongly.
pub fn spending_key_address(
    spend_privkey: &[u8; 32],
    secret: &[u8; 32],
    index: u32,
    network: Network,
) -> Result<Address> {
    let key = spending_key(spend_privkey, secret, index)?;
    let pubkey = k256::SecretKey::from_slice(&key)
        .map_err(|e| CliError::Internal(format!("derived key rejected: {e}")))?
        .public_key()
        .to_encoded_point(true);
    Ok(Address::from_hash(
        network.prefix(),
        AddressKind::P2pkh,
        hash160(pubkey.as_bytes()),
    ))
}

/// One payment to this wallet found inside a transaction.
#[derive(Debug, Clone)]
pub struct RpaMatch {
    pub output_index: u32,
    pub address: String,
    pub value: u64,
    /// Display-order txid of the input the secret was derived from.
    pub prevout_txid: String,
    pub prevout_index: u32,
    /// The sender's compressed pubkey on that input, hex.
    ///
    /// Public, and the other half of the ECDH. A wallet that records this
    /// alongside the outpoint can rebuild the secret later without refetching
    /// the funding transaction — which is what lets a received payment become
    /// an ordinary spendable coin rather than a balance it can only look at.
    pub sender_pubkey_hex: String,
    /// The ECDH secret this match came from, so the caller can derive the
    /// spending key without recomputing it. Never serialise this.
    pub secret: [u8; 32],
}

/// The compressed pubkey a P2PKH scriptSig reveals: `<sig> <pubkey>`.
///
/// Only compressed keys are accepted. Every key in this protocol is
/// compressed, and a 65-byte push here would be a pre-2012 coin whose owner is
/// not sending reusable payments.
fn p2pkh_input_pubkey(script_sig: &[u8]) -> Option<[u8; 33]> {
    let mut pushes: Vec<&[u8]> = Vec::new();
    let mut i = 0usize;
    while i < script_sig.len() {
        let op = script_sig[i];
        i += 1;
        let n = match op {
            1..=75 => op as usize,
            0x4c => {
                let v = *script_sig.get(i)? as usize;
                i += 1;
                v
            }
            0x4d => {
                let v = u16::from_le_bytes([*script_sig.get(i)?, *script_sig.get(i + 1)?]) as usize;
                i += 2;
                v
            }
            _ => return None,
        };
        if i + n > script_sig.len() {
            return None;
        }
        pushes.push(&script_sig[i..i + n]);
        i += n;
    }
    let last = pushes.last()?;
    if last.len() != 33 || (last[0] != 0x02 && last[0] != 0x03) {
        return None;
    }
    let mut out = [0u8; 33];
    out.copy_from_slice(last);
    Some(out)
}

/// Find payments to this wallet inside one raw transaction.
///
/// Fulcrum's `blockchain.reusable.*` is how Electron Cash *finds* candidate
/// txids; once a transaction is in hand, matching is plain ECDH against each
/// P2PKH input, which any ordinary Electrum server can supply. Public chipnet
/// servers do not implement reusable.*, so this path is what actually works
/// there.
pub fn scan_transaction(
    raw: &[u8],
    scan_privkey: &[u8; 32],
    spend_pubkey: &[u8; 33],
    network: Network,
) -> Result<Vec<RpaMatch>> {
    let (inputs, outputs) = parse_transaction(raw)?;
    let mut matches = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (txid_display, vout, script_sig) in &inputs {
        let Some(sender_pubkey) = p2pkh_input_pubkey(script_sig) else {
            continue;
        };
        let Ok(secret) = shared_secret(scan_privkey, &sender_pubkey, txid_display, *vout) else {
            continue;
        };
        let expected = payment_address(spend_pubkey, &secret, network, 0)?;
        let expected_script = expected.script_pubkey();

        for (index, (value, script)) in outputs.iter().enumerate() {
            if script != &expected_script || !seen.insert(index) {
                continue;
            }
            matches.push(RpaMatch {
                output_index: index as u32,
                address: expected.encode(),
                value: *value,
                prevout_txid: txid_display.clone(),
                prevout_index: *vout,
                sender_pubkey_hex: sender_pubkey.iter().map(|b| format!("{b:02x}")).collect(),
                secret,
            });
        }
    }
    Ok(matches)
}

pub(crate) type ParsedInput = (String, u32, Vec<u8>);
pub(crate) type ParsedOutput = (u64, Vec<u8>);
pub(crate) type ParsedTransaction = (Vec<ParsedInput>, Vec<ParsedOutput>);

/// Inputs as (display txid, vout, scriptSig) and outputs as (value, script).
pub(crate) fn parse_transaction(raw: &[u8]) -> Result<ParsedTransaction> {
    let mut i = 0usize;
    let need = |i: usize, n: usize| -> Result<()> {
        match i.checked_add(n) {
            Some(end) if end <= raw.len() => Ok(()),
            _ => Err(CliError::Protocol("transaction is truncated".into())),
        }
    };
    let varint = |i: &mut usize| -> Result<u64> {
        need(*i, 1)?;
        let first = raw[*i];
        *i += 1;
        let n = match first {
            0..=0xfc => return Ok(u64::from(first)),
            0xfd => 2,
            0xfe => 4,
            _ => 8,
        };
        need(*i, n)?;
        let mut buf = [0u8; 8];
        buf[..n].copy_from_slice(&raw[*i..*i + n]);
        *i += n;
        let value = u64::from_le_bytes(buf);
        let minimum = match first {
            0xfd => 0xfd,
            0xfe => 0x10000,
            _ => 0x100000000,
        };
        if value < minimum {
            return Err(CliError::Protocol(
                "transaction uses non-canonical CompactSize".into(),
            ));
        }
        Ok(value)
    };

    need(i, 4)?;
    i += 4; // version

    let input_count = varint(&mut i)?;
    let mut inputs = Vec::new();
    for _ in 0..input_count {
        need(i, 36)?;
        // The shared secret hashes the DISPLAY txid, and the wire stores the
        // outpoint little-endian, so this reversal is required here.
        //
        // The desktop wallet's RpaDetect.ts does NOT reverse, and that is also
        // correct -- it reads the outpoint from libauth's decodeTransaction,
        // which has already converted to display order. Different layers, not
        // an inconsistency: this function parses raw wire bytes itself.
        //
        // Do not "harmonise" the two. Reversing on the libauth side yields a
        // transaction whose wire outpoint is display order, which nodes reject
        // with "Missing inputs"; dropping the reversal here yields a secret
        // derived from a byte-reversed txid, so no payment is ever detected --
        // silently, because a wrong secret just produces a wrong address.
        let mut txid = raw[i..i + 32].to_vec();
        txid.reverse();
        let txid_display: String = txid.iter().map(|b| format!("{b:02x}")).collect();
        let vout = u32::from_le_bytes([raw[i + 32], raw[i + 33], raw[i + 34], raw[i + 35]]);
        i += 36;
        let len = usize::try_from(varint(&mut i)?)
            .map_err(|_| CliError::Protocol("script length exceeds this platform".into()))?;
        need(i, len)?;
        let script_end = i + len;
        let script_sig = raw[i..script_end].to_vec();
        need(script_end, 4)?;
        i = script_end + 4; // sequence
        inputs.push((txid_display, vout, script_sig));
    }

    let output_count = varint(&mut i)?;
    let mut outputs: Vec<ParsedOutput> = Vec::new();
    for _ in 0..output_count {
        need(i, 8)?;
        let mut v = [0u8; 8];
        v.copy_from_slice(&raw[i..i + 8]);
        i += 8;
        let len = usize::try_from(varint(&mut i)?)
            .map_err(|_| CliError::Protocol("script length exceeds this platform".into()))?;
        need(i, len)?;
        let script_end = i + len;
        outputs.push((u64::from_le_bytes(v), raw[i..script_end].to_vec()));
        i = script_end;
    }
    need(i, 4)?; // locktime
    if i + 4 != raw.len() {
        return Err(CliError::Protocol("transaction has trailing bytes".into()));
    }
    Ok((inputs, outputs))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixed keys so a changed constant shows up as a changed vector rather
    // than a flaky pass. scan = 7*G, spend = 13*G, sender = 37*G — the same
    // small scalars Selene's bch-rpa uses for its Electron Cash interop
    // vectors, so these can be compared against that suite directly.
    fn small_key(n: u8) -> [u8; 32] {
        let mut k = [0u8; 32];
        k[31] = n;
        k
    }

    fn pubkey_of(priv_bytes: &[u8; 32]) -> [u8; 33] {
        let sk = k256::SecretKey::from_slice(priv_bytes).unwrap();
        let mut out = [0u8; 33];
        out.copy_from_slice(sk.public_key().to_encoded_point(true).as_bytes());
        out
    }

    #[test]
    fn matches_the_bch_rpa_reference_pubkeys() {
        assert_eq!(
            hex(&pubkey_of(&small_key(7))),
            "025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"
        );
        assert_eq!(
            hex(&pubkey_of(&small_key(13))),
            "03f28773c2d975288bc7d1d205c3748651b075fbc6610e58cddeeddf8f19405aa8"
        );
        assert_eq!(
            hex(&pubkey_of(&small_key(37))),
            "0362d14dab4150bf497402fdc45a215e10dcb01c354959b10cfe31c7e9d87ff33d"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The outpoint bch-rpa's `test/fixtures.ts` pins for its interop vectors.
    const REF_TXID: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    #[test]
    fn shared_secret_matches_the_reference_vector() {
        // privA=7 against pubB=13G, outpoint index 0.
        let secret = shared_secret(&small_key(7), &pubkey_of(&small_key(13)), REF_TXID, 0).unwrap();
        assert_eq!(
            hex(&secret),
            "ec38e0aca40c240ef0eb506765e780ec78279c630e124186f828144e0875ad26"
        );
    }

    #[test]
    fn shared_secret_handles_a_257_bit_grand_sum() {
        // This vector overflows 32 bytes, which is why add_be_minimal exists.
        let secret = shared_secret(&small_key(37), &pubkey_of(&small_key(7)), REF_TXID, 0).unwrap();
        assert_eq!(
            hex(&secret),
            "e4597ed066ca88ad4abb72f290251acaa5b680e574dad641b6bc4e38fbfa34b1"
        );
    }

    #[test]
    fn ecdh_is_symmetric_between_sender_and_receiver() {
        let sender = shared_secret(&small_key(37), &pubkey_of(&small_key(7)), REF_TXID, 0).unwrap();
        let receiver =
            shared_secret(&small_key(7), &pubkey_of(&small_key(37)), REF_TXID, 0).unwrap();
        assert_eq!(sender, receiver);
    }

    /// A payment received at a Cash Code has to survive the whole journey
    /// from detection to signature, not merely be detected.
    ///
    /// This is the regression for the gap that made a real chipnet payment
    /// unmovable: `scan_transaction` found it, `spending_key_address` proved
    /// the wallet controlled it, and it still could not be spent, because
    /// nothing turned the match into a coin the spend planner would consider.
    /// Each step below is one that used to be missing.
    #[test]
    fn a_received_rpa_payment_is_detected_then_selected_then_signed() {
        use crate::coins::{Coin, CoinSet, Outpoint};

        // Display-order hex, which is what `shared_secret` takes.
        let display = |b: &[u8]| -> String { b.iter().map(|x| format!("{x:02x}")).collect() };

        // Recipient publishes a code; sender pays it from a P2PKH coin.
        let scan_priv = small_key(21);
        let spend_priv = small_key(22);
        let scan_pub = pubkey_of(&scan_priv);
        let spend_pub = pubkey_of(&spend_priv);
        let sender_priv = small_key(23);

        let funding_txid = [0x5au8; 32];
        let secret = shared_secret(&sender_priv, &scan_pub, &display(&funding_txid), 1).unwrap();
        let stealth = payment_address(&spend_pub, &secret, Network::Chipnet, 0).unwrap();

        // 1. Detection says the wallet controls it.
        let controlled = spending_key_address(&spend_priv, &secret, 0, Network::Chipnet).unwrap();
        assert_eq!(controlled.encode(), stealth.encode());

        // 2. The match becomes a coin, carrying the outpoint the secret came
        //    from rather than the secret itself.
        let coin = Coin::from_rpa_payment(
            Outpoint::new([0x77u8; 32], 0),
            50_000,
            stealth.encode(),
            display(&funding_txid),
            1,
            display(&pubkey_of(&sender_priv)),
        )
        .expect("an RPA match is a coin");
        assert!(coin.is_rpa());

        // 3. It lands in the wallet's coin set as spendable, and shows up in
        //    the private-receipts breakdown without being a separate pool.
        let mut coins = CoinSet::default();
        coins.insert(coin.clone()).expect("insert");
        assert_eq!(coins.spendable_sats(), 50_000);
        assert_eq!(coins.rpa_sats(), 50_000);

        // 4. Coin selection picks it like any other coin. This is the step
        //    that did not exist: the balance was visible and unspendable.
        let pool = vec![crate::tx::Utxo {
            txid: [0x77u8; 32],
            vout: 0,
            value: coin.value_sats(),
            script_pubkey: stealth.script_pubkey(),
        }];
        let (chosen, fee) = crate::tx::select_coins(&pool, 10_000, 1, 2).expect("selected");
        assert_eq!(chosen.len(), 1);

        // 5. And the key that signs it is derivable from the origin the coin
        //    carried, which is the whole reason for carrying it.
        let stealth_priv = spending_key(&spend_priv, &secret, 0).expect("spending key");
        let signing = k256::ecdsa::SigningKey::from_slice(&stealth_priv).expect("signing key");
        let spend_to =
            Address::from_hash(Network::Chipnet.prefix(), AddressKind::P2pkh, [0x31u8; 20]);
        let transaction = crate::tx::Transaction::new(
            chosen,
            vec![crate::tx::Output::new(
                50_000 - fee,
                spend_to.script_pubkey(),
            )],
        );
        let raw = transaction.sign(&[signing]).expect("sign the RPA coin");
        assert!(!raw.is_empty());

        // The signature has to be over this coin's own script, so a wallet
        // that derived the wrong key would not get this far.
        assert_eq!(
            crate::tx::decode(&raw).expect("decodes").outputs[0].value,
            50_000 - fee
        );
    }

    #[test]
    fn the_grind_budget_scales_with_the_prefix_and_clears_the_old_ceiling() {
        // Eight times the mean at every supported width. The point of the
        // change is the 16-bit case: 100_000 was ~1.5x the mean there, and
        // 1 - e^-1.53 of transactions exhausted it.
        for bits in [4u8, 8, 12, 16] {
            let mean = 1u32 << bits;
            assert_eq!(grind_budget(bits).unwrap(), 8 * mean, "{bits} bits");
        }
        assert!(
            grind_budget(16).unwrap() > 100_000,
            "16-bit budget must exceed the ceiling that was failing"
        );
        // And it is not merely bigger everywhere: at 4 bits the old fixed
        // number was absurdly generous, and the budget is now proportionate.
        assert!(grind_budget(4).unwrap() < 100_000);
        assert!(
            grind_budget(5).is_err(),
            "unsupported width must be refused"
        );
    }

    #[test]
    fn grind_sequences_stay_bip68_final() {
        assert_eq!(grind_sequence(0).unwrap(), 0xffff_ffff);
        assert_eq!(grind_sequence(1).unwrap(), 0xffff_fffe);

        // Every offset the largest budget can reach must still have bit 31
        // set, or the sender would silently turn a final input into a relative
        // timelock partway through grinding.
        let budget = grind_budget(16).unwrap();
        for offset in [0, 1, budget / 2, budget - 1] {
            assert!(
                grind_sequence(offset).unwrap() >= 0x8000_0000,
                "offset {offset} left the BIP68-final range"
            );
        }

        // The boundary itself is the last usable value, and one past it fails
        // rather than wrapping into timelock territory.
        assert_eq!(grind_sequence(0x7fff_ffff).unwrap(), 0x8000_0000);
        assert!(grind_sequence(0x8000_0000).is_err());
    }

    #[test]
    fn emits_cashcode_and_never_paycode() {
        let scan = pubkey_of(&small_key(7));
        let spend = pubkey_of(&small_key(13));
        let mainnet = encode(&scan, &spend, Network::Mainnet, RPA_PREFIX_BITS);
        let chipnet = encode(&scan, &spend, Network::Chipnet, RPA_PREFIX_BITS);
        assert!(mainnet.starts_with("cashcode:"), "{mainnet}");
        assert!(chipnet.starts_with("cashcodetest:"), "{chipnet}");
        assert!(!mainnet.starts_with("paycode"));
        assert!(!chipnet.starts_with("paycode"));
    }

    #[test]
    fn round_trips_a_cashcode() {
        let scan = pubkey_of(&small_key(7));
        let spend = pubkey_of(&small_key(13));
        let code = encode(&scan, &spend, Network::Chipnet, RPA_PREFIX_BITS);
        let decoded = decode(&code).unwrap();
        assert_eq!(decoded.scan_pubkey, scan);
        assert_eq!(decoded.spend_pubkey, spend);
        assert_eq!(decoded.prefix_bits, RPA_PREFIX_BITS);
        assert_eq!(decoded.expiry, 0);
        assert_eq!(decoded.network(), Network::Chipnet);
        assert!(looks_like_rpa(&code));
    }

    #[test]
    fn rejects_a_code_with_one_character_changed() {
        let code = encode(
            &pubkey_of(&small_key(7)),
            &pubkey_of(&small_key(13)),
            Network::Chipnet,
            RPA_PREFIX_BITS,
        );
        let last = code.chars().last().unwrap();
        let swapped = format!(
            "{}{}",
            &code[..code.len() - 1],
            if last == 'q' { 'p' } else { 'q' }
        );
        assert!(decode(&swapped).is_err());
    }

    /// Build a legacy PayCode string by hand.
    ///
    /// Test-only on purpose: nothing in the crate emits one any more, and the
    /// point of these fixtures is to have a *well-formed* legacy string —
    /// correct payload, correct checksum for its own prefix — so a rejection
    /// test proves the prefix was refused rather than that a malformed string
    /// happened to fail some later check.
    fn handmade_legacy_paycode(prefix: &str, version: u8) -> String {
        let scan = pubkey_of(&small_key(7));
        let spend = pubkey_of(&small_key(13));
        let mut payload = [0u8; PAYLOAD_LEN];
        payload[0] = version;
        payload[1] = RPA_PREFIX_BITS;
        payload[2..35].copy_from_slice(&scan);
        payload[35..68].copy_from_slice(&spend);
        let mut with_kind = vec![0x00];
        with_kind.extend_from_slice(&payload);
        encode_payload(prefix, &with_kind)
    }

    #[test]
    fn rejects_a_legacy_paycode_string() {
        for (prefix, version) in [
            (LEGACY_MAINNET, VERSION_MAINNET),
            (LEGACY_TESTNET, VERSION_TESTNET),
        ] {
            let legacy = handmade_legacy_paycode(prefix, version);
            assert!(legacy.starts_with(&format!("{prefix}:")), "{legacy}");

            // Not a payable recipient, so the send path never routes it into
            // RPA derivation in the first place.
            assert!(!looks_like_rpa(&legacy), "{prefix} must not look payable");
            // And named, so the wallet can say why rather than "bad address".
            assert!(is_legacy_paycode(&legacy), "{prefix} must be recognised");

            let error = decode(&legacy).expect_err("legacy PayCode must not decode");
            assert!(
                error.to_string().contains("not supported"),
                "{prefix} rejected for the wrong reason: {error}"
            );
        }
    }

    #[test]
    fn a_legacy_paycode_is_refused_on_its_prefix_not_its_checksum() {
        // The fixture above is checksum-valid for `paycodetest:`. If the
        // refusal were really a checksum failure it would be indistinguishable
        // from a typo, and repairing the checksum would let a legacy code
        // through. Truncating the last character changes the checksum without
        // touching the prefix: both forms must still be refused as legacy.
        let legacy = handmade_legacy_paycode(LEGACY_TESTNET, VERSION_TESTNET);
        let broken_checksum = &legacy[..legacy.len() - 1];

        for candidate in [legacy.as_str(), broken_checksum] {
            let error = decode(candidate).expect_err("must not decode");
            assert!(
                error.to_string().contains("not supported"),
                "expected the legacy refusal, got: {error}"
            );
        }
    }

    #[test]
    fn payment_address_hashes_the_compressed_child() {
        let spend = pubkey_of(&small_key(13));
        let secret = shared_secret(&small_key(7), &spend, REF_TXID, 0).unwrap();
        let addr = payment_address(&spend, &secret, Network::Chipnet, 0).unwrap();

        // Recompute the child here and hash it compressed, so the assertion is
        // about serialization rather than repeating payment_address's own math.
        let parent = PublicKey::from_sec1_bytes(&spend).unwrap();
        let tweak = scalar_from_bytes(&ckd_tweak(&secret, &spend, 0).unwrap()).unwrap();
        let child = (parent.to_projective() + ProjectivePoint::GENERATOR * tweak).to_affine();
        let compressed = child.to_encoded_point(true);
        assert_eq!(compressed.as_bytes().len(), 33);
        let expected = Address::from_hash(
            Network::Chipnet.prefix(),
            AddressKind::P2pkh,
            hash160(compressed.as_bytes()),
        );
        assert_eq!(addr.encode(), expected.encode());

        // And it must NOT be Electron Cash's uncompressed form.
        let uncompressed = child.to_encoded_point(false);
        assert_eq!(uncompressed.as_bytes().len(), 65);
        let ec_address = Address::from_hash(
            Network::Chipnet.prefix(),
            AddressKind::P2pkh,
            hash160(uncompressed.as_bytes()),
        );
        assert_ne!(addr.encode(), ec_address.encode());
    }

    #[test]
    fn the_derived_key_controls_the_derived_address() {
        // The property that actually matters: whatever address a sender pays,
        // the recipient's derived key must hash to it. If these ever disagree
        // the funds are simply gone.
        let spend_priv = small_key(13);
        let spend_pub = pubkey_of(&spend_priv);
        let secret = shared_secret(&small_key(37), &spend_pub, REF_TXID, 3).unwrap();

        let paid_to = payment_address(&spend_pub, &secret, Network::Chipnet, 0).unwrap();
        // Through the same function `rpa scan` uses to report `spendable`.
        let controlled = spending_key_address(&spend_priv, &secret, 0, Network::Chipnet).unwrap();
        assert_eq!(paid_to.encode(), controlled.encode());
    }

    #[test]
    fn offline_only_versions_are_refused() {
        let scan = pubkey_of(&small_key(7));
        let spend = pubkey_of(&small_key(13));
        for (version, network) in [(0x02u8, Network::Mainnet), (0x06u8, Network::Chipnet)] {
            let code = Cashcode {
                version,
                prefix_bits: RPA_PREFIX_BITS,
                scan_pubkey: scan,
                spend_pubkey: spend,
                expiry: 0,
                prefix: String::new(),
            };
            assert_eq!(code.network(), network);
            let reason = send_block_reason(&code).expect("offline-only must be refused");
            assert!(reason.contains("offline-only"), "{reason}");
        }
    }

    #[test]
    fn on_chain_versions_are_allowed() {
        let scan = pubkey_of(&small_key(7));
        let spend = pubkey_of(&small_key(13));
        for version in [0x01u8, 0x05u8] {
            let code = Cashcode {
                version,
                prefix_bits: RPA_PREFIX_BITS,
                scan_pubkey: scan,
                spend_pubkey: spend,
                expiry: 0,
                prefix: String::new(),
            };
            assert!(send_block_reason(&code).is_none());
        }
    }

    #[test]
    fn a_code_with_no_scan_prefix_is_refused_before_the_grind() {
        let code = Cashcode {
            version: 0x05,
            prefix_bits: 0,
            scan_pubkey: pubkey_of(&small_key(7)),
            spend_pubkey: pubkey_of(&small_key(13)),
            expiry: 0,
            prefix: String::new(),
        };
        // grind_string is where this would otherwise surface, late.
        assert!(grind_string(&code.scan_pubkey, 0).is_err());
        let reason = send_block_reason(&code).expect("prefix 0 must be refused");
        assert!(reason.contains("no scan prefix"), "{reason}");
    }

    #[test]
    fn grind_string_is_the_scan_pubkey_hex_after_the_sign_byte() {
        let scan = pubkey_of(&small_key(7));
        assert_eq!(grind_string(&scan, 16).unwrap(), "5CBD");
        assert_eq!(grind_string(&scan, 8).unwrap(), "5C");
        assert!(grind_string(&scan, 10).is_err());
    }

    #[test]
    fn derivation_paths_match_the_desktop_wallet() {
        assert_eq!(scan_path(145, 0), "m/44'/145'/0'/3/0");
        assert_eq!(spend_path(145, 0), "m/44'/145'/0'/3/1");
        assert_eq!(scan_path(1, 0), "m/44'/1'/0'/3/0");
        assert_eq!(spend_path(1, 0), "m/44'/1'/0'/3/1");
    }

    #[test]
    fn derived_key_material_can_be_zeroized_before_drop() {
        let mut keys = RpaKeys {
            scan_privkey: [1; 32],
            scan_pubkey: [2; 33],
            spend_privkey: [3; 32],
            spend_pubkey: [4; 33],
        };

        keys.zeroize();

        assert_eq!(keys.scan_privkey, [0; 32]);
        assert_eq!(keys.scan_pubkey, [0; 33]);
        assert_eq!(keys.spend_privkey, [0; 32]);
        assert_eq!(keys.spend_pubkey, [0; 33]);
    }

    #[test]
    fn rejects_overflowing_script_lengths_without_panicking() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&1_u32.to_le_bytes());
        raw.push(1); // one input
        raw.extend_from_slice(&[0_u8; 36]); // outpoint
        raw.push(0xff); // eight-byte CompactSize follows
        raw.extend_from_slice(&u64::MAX.to_le_bytes());

        assert!(parse_transaction(&raw).is_err());
    }

    #[test]
    fn transaction_parser_requires_locktime_exact_length_and_canonical_counts() {
        let mut raw = 2u32.to_le_bytes().to_vec();
        raw.push(1);
        raw.extend_from_slice(&[0u8; 36]);
        raw.push(0);
        raw.extend_from_slice(&u32::MAX.to_le_bytes());
        raw.push(1);
        raw.extend_from_slice(&1000u64.to_le_bytes());
        raw.extend_from_slice(&[1, 0x51]);
        raw.extend_from_slice(&0u32.to_le_bytes());
        assert!(parse_transaction(&raw).is_ok());
        for end in 0..raw.len() {
            assert!(
                parse_transaction(&raw[..end]).is_err(),
                "truncation at {end}"
            );
        }
        let mut trailing = raw.clone();
        trailing.push(0);
        assert!(parse_transaction(&trailing).is_err());
        let mut noncanonical = raw;
        noncanonical.splice(4..5, [0xfd, 1, 0]);
        assert!(parse_transaction(&noncanonical).is_err());
    }
}

/// The Rust half of the shared RPA vectors.
///
/// `test-vectors/rpa.json` is read by the shared core and by the wallet's WASM
/// adapter tests. This guards the cross-language boundary and keeps every app
/// surface anchored to the same externally sourced protocol fixtures.
///
/// The `reference` block is anchored outside this repository, to Selene's
/// bch-rpa interop fixtures.
///
/// If a vector fails, the protocol changed or an implementation broke. Fix the
/// code. Regenerating the file to make a test pass throws away the only thing
/// keeping the two sides honest.
#[cfg(test)]
mod shared_vectors {
    use super::*;
    use crate::hd::Wallet;
    use serde_json::Value;

    fn vectors() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test-vectors/rpa.json");
        let raw =
            std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
        serde_json::from_str(&raw).expect("test-vectors/rpa.json is not valid JSON")
    }

    fn hex_of(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn decode_hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("bad hex"))
            .collect()
    }

    fn small(n: u8) -> [u8; 32] {
        let mut k = [0u8; 32];
        k[31] = n;
        k
    }

    fn pubkey_hex(privkey: &[u8; 32]) -> String {
        let sk = k256::SecretKey::from_slice(privkey).unwrap();
        hex_of(sk.public_key().to_encoded_point(true).as_bytes())
    }

    #[test]
    fn matches_the_external_bch_rpa_reference_values() {
        let v = vectors();
        let r = &v["reference"];
        assert_eq!(pubkey_hex(&small(7)), r["scanPrivkey7"].as_str().unwrap());
        assert_eq!(
            pubkey_hex(&small(13)),
            r["spendPrivkey13"].as_str().unwrap()
        );
        assert_eq!(
            pubkey_hex(&small(37)),
            r["senderPrivkey37"].as_str().unwrap()
        );

        let txid = v["sender"]["outpointTxid"].as_str().unwrap();

        let mut spend_pub = [0u8; 33];
        spend_pub.copy_from_slice(&decode_hex(r["spendPrivkey13"].as_str().unwrap()));
        assert_eq!(
            hex_of(&shared_secret(&small(7), &spend_pub, txid, 0).unwrap()),
            r["sharedSecret_7_x_13G"].as_str().unwrap()
        );

        // The grand sum here overflows 32 bytes, which is where a fixed-width
        // addition silently produces a different digest.
        let mut scan_pub = [0u8; 33];
        scan_pub.copy_from_slice(&decode_hex(r["scanPrivkey7"].as_str().unwrap()));
        assert_eq!(
            hex_of(&shared_secret(&small(37), &scan_pub, txid, 0).unwrap()),
            r["sharedSecret_37_x_7G_257bit"].as_str().unwrap()
        );
    }

    #[test]
    fn derives_every_wallet_vector_from_the_shared_mnemonic() {
        let v = vectors();
        let mnemonic = v["mnemonic"].as_str().unwrap();
        let passphrase = v["passphrase"].as_str().unwrap();
        let wallet = Wallet::from_mnemonic(mnemonic, passphrase).unwrap();

        let sender_privkey: [u8; 32] = decode_hex(v["sender"]["privkey"].as_str().unwrap())
            .try_into()
            .unwrap();
        let outpoint_txid = v["sender"]["outpointTxid"].as_str().unwrap();
        let outpoint_index = v["sender"]["outpointIndex"].as_u64().unwrap() as u32;

        for w in v["wallets"].as_array().unwrap() {
            let name = w["network"].as_str().unwrap();
            let (network, coin) = match name {
                "mainnet" => (Network::Mainnet, 145),
                "chipnet" => (Network::Chipnet, 1),
                other => panic!("unknown network in vectors: {other}"),
            };

            let scan_path = scan_path(coin, 0);
            let spend_path = spend_path(coin, 0);
            assert_eq!(
                scan_path,
                w["scanPath"].as_str().unwrap(),
                "{name} scan path"
            );
            assert_eq!(
                spend_path,
                w["spendPath"].as_str().unwrap(),
                "{name} spend path"
            );

            let scan_pubkey = wallet.public_key(&scan_path).unwrap();
            let spend_pubkey = wallet.public_key(&spend_path).unwrap();
            let derived =
                derive_keys_from_paths(mnemonic, passphrase, &scan_path, &spend_path).unwrap();
            let expected_scan_privkey: [u8; 32] =
                wallet.signing_key(&scan_path).unwrap().to_bytes().into();
            let expected_spend_privkey: [u8; 32] =
                wallet.signing_key(&spend_path).unwrap().to_bytes().into();
            assert_eq!(derived.scan_pubkey, scan_pubkey, "{name} Rust scan pubkey");
            assert_eq!(
                derived.spend_pubkey, spend_pubkey,
                "{name} Rust spend pubkey"
            );
            assert_eq!(
                derived.scan_privkey, expected_scan_privkey,
                "{name} Rust scan private key"
            );
            assert_eq!(
                derived.spend_privkey, expected_spend_privkey,
                "{name} Rust spend private key"
            );
            assert_eq!(
                hex_of(&scan_pubkey),
                w["scanPubkey"].as_str().unwrap(),
                "{name} scan pubkey"
            );
            assert_eq!(
                hex_of(&spend_pubkey),
                w["spendPubkey"].as_str().unwrap(),
                "{name} spend pubkey"
            );
            assert_eq!(
                grind_string(&scan_pubkey, RPA_PREFIX_BITS).unwrap(),
                w["grindString16"].as_str().unwrap(),
                "{name} grind string"
            );

            assert_eq!(
                encode(&scan_pubkey, &spend_pubkey, network, RPA_PREFIX_BITS),
                w["cashcode"].as_str().unwrap(),
                "{name} cashcode"
            );

            // The legacy form carries the same keys as the cashcode beside
            // it and is checksum-valid, so decoding it would "work" — and
            // would then derive a destination under compressed Cash Code
            // rules that its legacy owner never derived. It must be refused.
            let legacy = w["legacyPaycode"].as_str().unwrap();
            assert!(!looks_like_rpa(legacy), "{name} legacy must not be payable");
            assert!(is_legacy_paycode(legacy), "{name} legacy must be named");
            let error = decode(legacy).expect_err("{name} legacy must not decode");
            assert!(
                error.to_string().contains("not supported"),
                "{name} legacy rejected for the wrong reason: {error}"
            );

            // The cashcode beside it stays payable, so the assertion above is
            // about the prefix and not about these particular keys.
            assert!(looks_like_rpa(w["cashcode"].as_str().unwrap()));
            assert!(!is_legacy_paycode(w["cashcode"].as_str().unwrap()));

            let secret =
                shared_secret(&sender_privkey, &scan_pubkey, outpoint_txid, outpoint_index)
                    .unwrap();
            assert_eq!(
                hex_of(&secret),
                w["sharedSecret"].as_str().unwrap(),
                "{name} shared secret"
            );
            assert_eq!(
                payment_address(&spend_pubkey, &secret, network, 0)
                    .unwrap()
                    .encode(),
                w["paymentAddress"].as_str().unwrap(),
                "{name} payment address"
            );

            // And the recipient controls what the sender paid.
            let spend_privkey: [u8; 32] =
                wallet.signing_key(&spend_path).unwrap().to_bytes().into();
            let spending_key = spending_key(&spend_privkey, &secret, 0).unwrap();
            assert_eq!(
                pubkey_hex(&spending_key),
                w["spendingPubkey"].as_str().unwrap(),
                "{name} spending pubkey"
            );
        }
    }
}

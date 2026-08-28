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
//! Codes are emitted as `cashcode:` / `cashcodetest:`. Legacy `paycode:` /
//! `paycodetest:` strings are still accepted as send targets so codes already
//! handed out keep working; nothing here ever emits one.

use hmac::{Hmac, Mac};
use k256::elliptic_curve::group::Curve as _;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, ProjectivePoint, PublicKey, Scalar};
use sha2::{Digest, Sha256, Sha512};

use crate::cashaddr::{encode_payload, Address, AddressKind, CHARSET};
use crate::error::{CliError, Result};
use crate::hd::hash160;
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
const LEGACY_MAINNET: &str = "paycode";
const LEGACY_TESTNET: &str = "paycodetest";

const MAINNET_PREFIXES: [&str; 2] = [CASHCODE_MAINNET, LEGACY_MAINNET];
const TESTNET_PREFIXES: [&str; 2] = [CASHCODE_TESTNET, LEGACY_TESTNET];

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

/// A decoded cashcode (or legacy paycode).
#[derive(Debug, Clone)]
pub struct Cashcode {
    pub version: u8,
    pub prefix_bits: u8,
    pub scan_pubkey: [u8; 33],
    pub spend_pubkey: [u8; 33],
    pub expiry: u32,
    /// The prefix the string actually carried.
    pub prefix: String,
    /// True when this came from a legacy `paycode:` / `paycodetest:` string.
    pub legacy: bool,
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
pub fn encode(
    scan_pubkey: &[u8; 33],
    spend_pubkey: &[u8; 33],
    network: Network,
    prefix_bits: u8,
) -> String {
    let mut payload = [0u8; PAYLOAD_LEN];
    payload[0] = match network {
        Network::Mainnet => VERSION_MAINNET,
        Network::Chipnet => VERSION_TESTNET,
    };
    payload[1] = prefix_bits;
    payload[2..35].copy_from_slice(scan_pubkey);
    payload[35..68].copy_from_slice(spend_pubkey);
    // 68..72 stay zero: no expiry.

    let prefix = match network {
        Network::Mainnet => CASHCODE_MAINNET,
        Network::Chipnet => CASHCODE_TESTNET,
    };

    // Leading kind byte, as the desktop wallet and Electron Cash both write.
    let mut with_kind = Vec::with_capacity(PAYLOAD_LEN + 1);
    with_kind.push(0x00);
    with_kind.extend_from_slice(&payload);
    encode_payload(prefix, &with_kind)
}

/// True if the string carries any RPA prefix, cashcode or legacy paycode.
pub fn looks_like_rpa(candidate: &str) -> bool {
    let bare = candidate.trim().split('?').next().unwrap_or("").to_lowercase();
    MAINNET_PREFIXES
        .iter()
        .chain(TESTNET_PREFIXES.iter())
        .any(|p| bare.starts_with(&format!("{p}:")))
}

/// Decode a cashcode or a legacy paycode. Rejects a bad checksum before any
/// sender-side work happens.
pub fn decode(code: &str) -> Result<Cashcode> {
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
        return Err(CliError::Usage("scan pubkey is not a curve point".to_string()));
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
        legacy: prefix == LEGACY_MAINNET || prefix == LEGACY_TESTNET,
    })
}

/// The hex a sender grinds the input hash to match: the scan pubkey's hex
/// after the 02/03 byte, truncated to `prefix_bits`.
pub fn grind_string(scan_pubkey: &[u8; 33], prefix_bits: u8) -> Result<String> {
    if !matches!(prefix_bits, 4 | 8 | 12 | 16) {
        return Err(CliError::Usage(format!(
            "unsupported RPA prefix size: {prefix_bits} bits"
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
pub fn spending_key(
    spend_privkey: &[u8; 32],
    secret: &[u8; 32],
    index: u32,
) -> Result<[u8; 32]> {
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
        assert!(!decoded.legacy);
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

    #[test]
    fn accepts_a_legacy_paycode_string() {
        // Built by hand, since nothing here emits one.
        let scan = pubkey_of(&small_key(7));
        let spend = pubkey_of(&small_key(13));
        let mut payload = [0u8; PAYLOAD_LEN];
        payload[0] = VERSION_TESTNET;
        payload[1] = RPA_PREFIX_BITS;
        payload[2..35].copy_from_slice(&scan);
        payload[35..68].copy_from_slice(&spend);
        let mut with_kind = vec![0x00];
        with_kind.extend_from_slice(&payload);
        let legacy = encode_payload(LEGACY_TESTNET, &with_kind);

        assert!(legacy.starts_with("paycodetest:"));
        assert!(looks_like_rpa(&legacy));
        let decoded = decode(&legacy).unwrap();
        assert!(decoded.legacy);
        assert_eq!(decoded.scan_pubkey, scan);
        assert_eq!(decoded.spend_pubkey, spend);
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
        let key = spending_key(&spend_priv, &secret, 0).unwrap();
        let derived_pub = pubkey_of(&key);
        let controlled = Address::from_hash(
            Network::Chipnet.prefix(),
            AddressKind::P2pkh,
            hash160(&derived_pub),
        );
        assert_eq!(paid_to.encode(), controlled.encode());
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
}

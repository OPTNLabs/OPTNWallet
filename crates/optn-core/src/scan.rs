//! What a scanned or pasted payload actually is.
//!
//! One control in the wallet -- the connect popup -- accepts a camera scan or
//! a paste and has to decide, from the string alone, whether the user handed
//! it a CashConnect invite, a WalletConnect URI, a merchant proposal stream, a
//! paper wallet's private key, or an address to pay. The React implementation
//! made that decision in `classifyScannedQrPayload`; this is the same decision
//! in one place, with no camera, no store and no router anywhere near it.
//!
//! Three things here are load-bearing and were learned the hard way.
//!
//! **The order of the checks is part of the answer.** A CashConnect invite ends
//! in a base58 blob after a colon, and the paper-wallet rule looks at exactly
//! that: the text after the last colon. Checking for a private key first would
//! classify an invite as a key to sweep. Connection URIs are therefore matched
//! before anything is treated as key material.
//!
//! **A wrong-chain address is not an unreadable one.** The React parser's note
//! is explicit that accepting the opposite prefix "let chipnet wallets 'send to
//! mainnet addresses' -- same hash160, wrong chain, coins invisible on the
//! destination mainnet wallet". So a `bitcoincash:` address on chipnet is
//! refused -- but refused *as the wrong network*, with a message that says so,
//! rather than falling into "not a supported address", which is what the
//! connect popup used to tell people.
//!
//! **A payment amount stays a string.** BIP21 carries `amount=0.00000001`, and
//! the only reason to parse it is to check it is a positive, finite number. The
//! parsed float is then thrown away and the original text is what travels to
//! the send screen, because a round trip through `f64` is how a wallet pays a
//! slightly different amount than the invoice asked for.

use std::fmt;

use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::cashaddr::{Address, AddressKind};
use crate::network::Network;

/// The scheme a CashConnect invite carries.
pub const CASHCONNECT_URI_SCHEME: &str = "bch-cc-v1:";
/// The scheme a WalletConnect pairing URI carries.
pub const WALLETCONNECT_URI_SCHEME: &str = "wc:";
/// The scheme a WizardConnect pairing URI carries.
pub const WIZARDCONNECT_URI_SCHEME: &str = "wiz://";
/// The prefix a chunked merchant proposal QR stream carries.
pub const MERCHANT_PROPOSAL_PREFIX: &str = "qrstream/1/";

const BASE58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Shortest and longest base58 run that could be a WIF.
///
/// A WIF is 51 characters uncompressed and 52 compressed. The window is widened
/// by one at the bottom exactly as the React pattern had it, so a candidate is
/// still *checked* rather than dismissed on length; the checksum is what
/// decides.
const WIF_CANDIDATE_LEN: std::ops::RangeInclusive<usize> = 50..=52;

/// A private key that arrived by camera.
///
/// This is the only value in the crate that is both secret and freshly
/// attacker-supplied, so it is wrapped rather than left as a `String`:
///
/// - `Debug` prints a placeholder. A derived `Debug` would put a sweepable key
///   into every log line, panic message and error report that ever formats a
///   [`ScannedPayload`], which is a leak with no attacker involvement at all.
/// - There is no `Display`, so it cannot reach a UI by accident.
/// - The key is zeroized when dropped.
///
/// Reading it is deliberately verbose at the call site.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct PaperWalletKey {
    wif: String,
    /// Which chain the WIF's version byte says it belongs to.
    ///
    /// `None` when the version byte is neither of Bitcoin Cash's. The React
    /// code did not look, so a mainnet key scanned by a chipnet wallet swept
    /// nothing and reported nothing; this is the fact needed to say why.
    #[zeroize(skip)]
    key_network: Option<Network>,
}

impl PaperWalletKey {
    /// The key itself. Named so that a call site reads as an exposure.
    pub fn expose_wif(&self) -> &str {
        &self.wif
    }

    pub const fn key_network(&self) -> Option<Network> {
        self.key_network
    }

    /// Whether this key belongs to the chain the wallet is watching.
    ///
    /// A sweep of a mainnet key by a chipnet wallet finds nothing, which reads
    /// exactly like an empty paper wallet.
    pub fn matches(&self, network: Network) -> bool {
        self.key_network == Some(network)
    }
}

impl fmt::Debug for PaperWalletKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PaperWalletKey")
            .field("wif", &"<redacted>")
            .field("key_network", &self.key_network)
            .finish()
    }
}

/// An address to pay, with whatever the URI said about the payment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    /// The address as it should be used: CashAddr always carries its prefix.
    pub address: String,
    pub kind: AddressKind,
    /// Legacy base58, which this wallet accepts on mainnet only.
    pub is_legacy_base58: bool,
    /// Whether the payload was a URI rather than a bare address.
    pub is_bip21: bool,
    /// The requested amount, exactly as written. Never a reparsed float.
    pub amount_raw: Option<String>,
    pub label: Option<String>,
    pub message: Option<String>,
}

impl Recipient {
    /// Whether this address advertises that it accepts CashTokens.
    pub fn accepts_tokens(&self) -> bool {
        self.kind.accepts_tokens()
    }
}

/// An address that is well formed but belongs to the other chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrongNetwork {
    /// The network this wallet is on -- not the address's.
    pub wallet_network: Network,
}

impl WrongNetwork {
    /// The wording the send screen has always used.
    pub const fn message(self) -> &'static str {
        match self.wallet_network {
            Network::Mainnet => {
                "That address is for Chipnet (bchtest:). This wallet is on Mainnet — paste a \
                 bitcoincash: address."
            }
            Network::Chipnet => {
                "That address is for Mainnet (bitcoincash:). This wallet is on Chipnet — paste a \
                 bchtest: address."
            }
        }
    }
}

/// What a scanned string turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScannedPayload {
    /// A CashConnect invite. Reported whole: the session library owns parsing
    /// it, and half-parsing a connection URI here would be a second place for
    /// the format to be wrong.
    CashConnect { uri: String },
    /// A WalletConnect pairing URI, likewise reported whole.
    WalletConnect { uri: String },
    /// A WizardConnect pairing URI, likewise reported whole.
    WizardConnect { uri: String },
    /// The first chunk of a chunked merchant proposal.
    MerchantProposal { initial_payload: String },
    /// A private key to sweep.
    PaperWallet(PaperWalletKey),
    /// Somewhere to send money.
    Recipient(Recipient),
    /// A valid address for the chain this wallet is not on.
    WrongNetwork(WrongNetwork),
    /// Nothing this wallet knows how to act on.
    Unrecognised,
}

impl ScannedPayload {
    /// A short reason for the payloads that cannot be acted on.
    ///
    /// `None` when there is something to do, so a caller cannot show an error
    /// for a payload that succeeded.
    pub fn refusal(&self) -> Option<&'static str> {
        match self {
            Self::WrongNetwork(mismatch) => Some(mismatch.message()),
            Self::Unrecognised => {
                Some("Not a supported address, CashConnect invite, or WalletConnect URI.")
            }
            _ => None,
        }
    }
}

/// A CashConnect invite URI.
///
/// Matched case-insensitively: a QR code in alphanumeric mode holds uppercase
/// only, so a scanned invite arrives as `BCH-CC-V1:...`, and URI schemes are
/// case-insensitive anyway.
pub fn is_cashconnect_uri(value: &str) -> bool {
    has_scheme(value, CASHCONNECT_URI_SCHEME)
}

/// A WalletConnect pairing URI, matched case-insensitively for the same reason.
pub fn is_walletconnect_uri(value: &str) -> bool {
    has_scheme(value, WALLETCONNECT_URI_SCHEME)
}

/// A WizardConnect pairing URI, matched case-insensitively for the same reason.
pub fn is_wizardconnect_uri(value: &str) -> bool {
    has_scheme(value, WIZARDCONNECT_URI_SCHEME)
}

fn has_scheme(value: &str, scheme: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() > scheme.len()
        && trimmed.is_char_boundary(scheme.len())
        && trimmed[..scheme.len()].eq_ignore_ascii_case(scheme)
        // A scheme with nothing after it is not a URI, and neither is one with
        // whitespace in the middle -- that is two things pasted together.
        && !trimmed[scheme.len()..].chars().any(char::is_whitespace)
}

fn is_merchant_proposal(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(rest) = trimmed
        .get(..MERCHANT_PROPOSAL_PREFIX.len())
        .filter(|head| head.eq_ignore_ascii_case(MERCHANT_PROPOSAL_PREFIX))
        .map(|_| &trimmed[MERCHANT_PROPOSAL_PREFIX.len()..])
    else {
        return false;
    };
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-'))
}

/// Every substring that could be a WIF.
///
/// Three rules, ported as they were: the whole string when it is base58 all
/// through, every base58 run long enough to be a key, and the text after the
/// last colon. The last rule is why a paper wallet still scans when it is
/// written as `bitcoincash:<wif>`, and also why connection URIs have to be
/// matched before this runs.
///
/// Nothing here decides that a candidate *is* a key. That is the checksum's
/// job, and it is what keeps a 42-character CashAddr payload from being
/// mistaken for one.
pub fn wif_candidates(value: &str) -> Vec<&str> {
    let trimmed = value.trim();
    let mut found: Vec<&str> = Vec::new();
    if is_all_base58(trimmed) {
        add(trimmed, &mut found);
    }

    for run in base58_runs(trimmed) {
        let mut rest = run;
        while rest.len() >= *WIF_CANDIDATE_LEN.start() {
            let take = rest.len().min(*WIF_CANDIDATE_LEN.end());
            add(&rest[..take], &mut found);
            rest = &rest[take..];
        }
    }

    if let Some(index) = trimmed.rfind(':') {
        let suffix = trimmed[index + 1..].trim();
        if suffix != trimmed && is_all_base58(suffix) {
            add(suffix, &mut found);
        }
    }

    found
}

/// Remember a candidate once, keeping the order they were found in.
fn add<'a>(candidate: &'a str, out: &mut Vec<&'a str>) {
    if !candidate.is_empty() && !out.contains(&candidate) {
        out.push(candidate);
    }
}

fn is_all_base58(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| BASE58_ALPHABET.contains(&b))
}

/// The maximal runs of base58 characters in a string.
fn base58_runs(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let mut runs = Vec::new();
    let mut start = None;
    for (index, byte) in bytes.iter().enumerate() {
        match (BASE58_ALPHABET.contains(byte), start) {
            (true, None) => start = Some(index),
            (false, Some(begin)) => {
                runs.push(&value[begin..index]);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        runs.push(&value[begin..]);
    }
    runs
}

/// Base58 decode, big-endian, with leading `1`s as leading zero bytes.
fn base58_decode(input: &str) -> Option<Vec<u8>> {
    let mut digits: Vec<u8> = Vec::new();
    for byte in input.bytes() {
        let value = BASE58_ALPHABET.iter().position(|&c| c == byte)? as u32;
        let mut carry = value;
        for digit in digits.iter_mut().rev() {
            carry += 58 * u32::from(*digit);
            *digit = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            digits.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let leading_zeros = input.bytes().take_while(|&b| b == b'1').count();
    let mut out = vec![0u8; leading_zeros];
    out.extend_from_slice(&digits);
    Some(out)
}

/// Base58Check decode: the body, once its four-byte double-SHA256 checksum has
/// been verified.
///
/// Written out rather than pulled in, because the whole crate is dependency-shy
/// and `sha2` is already here. The checksum is the entire point: it is what
/// separates "this looks like base58" from "this is a key".
fn base58check_decode(input: &str) -> Option<Vec<u8>> {
    let raw = base58_decode(input)?;
    if raw.len() < 5 {
        return None;
    }
    let (body, checksum) = raw.split_at(raw.len() - 4);
    let digest = Sha256::digest(Sha256::digest(body));
    (digest[..4] == *checksum).then(|| body.to_vec())
}

/// The network a WIF version byte names, if it names one at all.
fn wif_network(version: u8) -> Option<Network> {
    match version {
        0x80 => Some(Network::Mainnet),
        // Chipnet shares the testnet version byte.
        0xef => Some(Network::Chipnet),
        _ => None,
    }
}

/// Decode a candidate as a WIF, or decide it is not one.
fn decode_wif(candidate: &str) -> Option<PaperWalletKey> {
    let body = base58check_decode(candidate)?;
    let network = wif_network(*body.first()?)?;
    // 1 version byte + 32 key bytes, plus a 0x01 marker when the key belongs to
    // a compressed public key.
    let well_formed = match body.len() {
        33 => true,
        34 => body[33] == 0x01,
        _ => false,
    };
    well_formed.then(|| PaperWalletKey {
        wif: candidate.to_string(),
        key_network: Some(network),
    })
}

/// The mainnet base58 version bytes this wallet will pay.
fn legacy_kind(version: u8) -> Option<AddressKind> {
    match version {
        0x00 => Some(AddressKind::P2pkh),
        0x05 => Some(AddressKind::P2sh),
        _ => None,
    }
}

/// Whether a base58 string decodes as any Bitcoin-family address.
fn is_legacy_address(candidate: &str) -> bool {
    base58check_decode(candidate).is_some_and(|body| body.len() == 21)
}

/// Percent-decoding, with `+` for a space, as a query string uses it.
fn decode_query_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    // A stray '%' is kept rather than dropped, so a label reads
                    // as it was written instead of silently losing characters.
                    Err(_) => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The first value for a key in a query string, empty treated as absent.
fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (decode_query_component(name) == key)
            .then(|| decode_query_component(value))
            .filter(|value| !value.trim().is_empty())
    })
}

/// A BIP21 `amount`, kept as text.
///
/// Parsed only to check it is a positive, finite number; the parsed value is
/// then discarded. Rust's parser is stricter than the JavaScript one this was
/// ported from, which read `1abc` as `1` -- an amount that is partly nonsense
/// is not an amount, and a wallet should not guess which half was meant.
fn amount_raw(query: &str) -> Option<String> {
    let raw = query_value(query, "amount")?;
    let trimmed = raw.trim();
    let parsed: f64 = trimmed.parse().ok()?;
    (parsed.is_finite() && parsed > 0.0).then(|| trimmed.to_string())
}

/// Decide what a scanned or pasted string is.
///
/// The order of the checks is the specification; see the module docs.
pub fn classify_scanned_payload(input: &str, network: Network) -> ScannedPayload {
    let scanned = input.trim();
    if scanned.is_empty() {
        return ScannedPayload::Unrecognised;
    }

    if is_cashconnect_uri(scanned) {
        return ScannedPayload::CashConnect {
            uri: scanned.to_string(),
        };
    }

    if is_walletconnect_uri(scanned) {
        return ScannedPayload::WalletConnect {
            uri: scanned.to_string(),
        };
    }

    if is_wizardconnect_uri(scanned) {
        return ScannedPayload::WizardConnect {
            uri: scanned.to_string(),
        };
    }

    if is_merchant_proposal(scanned) {
        return ScannedPayload::MerchantProposal {
            initial_payload: scanned.to_string(),
        };
    }

    for candidate in wif_candidates(scanned) {
        if let Some(key) = decode_wif(candidate) {
            return ScannedPayload::PaperWallet(key);
        }
    }

    classify_address(scanned, network)
}

/// The BIP21 half: an address, possibly a URI, always for this network.
fn classify_address(scanned: &str, network: Network) -> ScannedPayload {
    // Splitting at the first '?' means a second one lands inside the query,
    // where it is simply a malformed pair rather than a silently dropped tail.
    let (address_part, query) = match scanned.split_once('?') {
        Some((address, query)) => (address.trim(), query),
        None => (scanned, ""),
    };
    let is_bip21 = !query.is_empty() || address_part.contains(':');

    let (declared_prefix, no_prefix) = match address_part.rsplit_once(':') {
        Some((prefix, rest)) => (Some(prefix.to_lowercase()), rest.trim()),
        None => (None, address_part),
    };
    if no_prefix.is_empty() {
        return ScannedPayload::Unrecognised;
    }

    let expected = network.prefix();
    let opposite = match network {
        Network::Mainnet => Network::Chipnet,
        Network::Chipnet => Network::Mainnet,
    }
    .prefix();

    // An explicit prefix for the other chain. Refused as the wrong network, not
    // as an unreadable address: the hash160 is the same on both chains, so the
    // failure a user needs explained is which chain they are on.
    if declared_prefix.as_deref() == Some(opposite) {
        return ScannedPayload::WrongNetwork(WrongNetwork {
            wallet_network: network,
        });
    }

    let label = query_value(query, "label");
    let message = query_value(query, "message");
    let amount_raw = amount_raw(query);

    if is_legacy_address(no_prefix) {
        // Legacy base58 carries no chain in the address itself beyond a version
        // byte, and chipnet coins are not worth the risk of a silent
        // cross-network pay, so it is mainnet only -- and mainnet versions only.
        let kind = base58check_decode(no_prefix)
            .and_then(|body| legacy_kind(body[0]))
            .filter(|_| network == Network::Mainnet);
        return match kind {
            Some(kind) => ScannedPayload::Recipient(Recipient {
                address: no_prefix.to_string(),
                kind,
                is_legacy_base58: true,
                is_bip21,
                amount_raw,
                label,
                message,
            }),
            None => ScannedPayload::WrongNetwork(WrongNetwork {
                wallet_network: network,
            }),
        };
    }

    // Only ever decoded against this wallet's prefix. The CashAddr checksum
    // covers the prefix, so a chipnet payload tried as mainnet fails the
    // checksum rather than becoming a different, valid, wrong address.
    let candidate = format!("{expected}:{no_prefix}");
    match Address::decode(&candidate) {
        Ok(address) => ScannedPayload::Recipient(Recipient {
            address: address.encode(),
            kind: address.kind,
            is_legacy_base58: false,
            is_bip21,
            amount_raw,
            label,
            message,
        }),
        Err(_) => ScannedPayload::Unrecognised,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Published documentation keys, worth nothing and drained for years. They
    /// are self-validating: a mistyped character fails the checksum and the
    /// test fails loudly rather than passing on a wrong vector.
    const WIF_UNCOMPRESSED: &str = "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ";
    const WIF_COMPRESSED: &str = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
    const LEGACY_P2PKH: &str = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

    fn address_for(network: Network, kind: AddressKind) -> String {
        Address::from_hash(network.prefix(), kind, [7u8; 20]).encode()
    }

    #[test]
    fn a_connection_uri_is_matched_before_anything_is_treated_as_a_key() {
        // The hazard this ordering exists for: the tail of an invite is base58
        // after a colon, which is exactly the paper-wallet rule. Checked the
        // other way round, a pairing invite becomes a key to sweep.
        let invite = format!("{CASHCONNECT_URI_SCHEME}//relay.example/{WIF_COMPRESSED}");
        assert!(
            wif_candidates(&invite).contains(&WIF_COMPRESSED),
            "the invite really does contain a decodable key, so order is what saves it"
        );
        assert_eq!(
            classify_scanned_payload(&invite, Network::Chipnet),
            ScannedPayload::CashConnect { uri: invite }
        );
    }

    #[test]
    fn scanned_uris_are_recognised_in_the_uppercase_a_qr_code_produces() {
        // Alphanumeric-mode QR is uppercase only, and schemes are
        // case-insensitive, so the scan must not depend on the case.
        for raw in [
            "wc:topic@2?relay-protocol=irn&symKey=abc",
            "WC:TOPIC@2?RELAY-PROTOCOL=IRN",
        ] {
            assert!(matches!(
                classify_scanned_payload(raw, Network::Mainnet),
                ScannedPayload::WalletConnect { .. }
            ));
        }
        assert!(matches!(
            classify_scanned_payload("BCH-CC-V1://relay.example/abc", Network::Mainnet),
            ScannedPayload::CashConnect { .. }
        ));
        assert!(matches!(
            classify_scanned_payload("WIZ://relay.example/abc", Network::Mainnet),
            ScannedPayload::WizardConnect { .. }
        ));
        // A bare scheme is not a URI, and neither is a scheme with a space in
        // it -- that is two things pasted together.
        assert!(!is_walletconnect_uri("wc:"));
        assert!(!is_cashconnect_uri("bch-cc-v1: and then some prose"));
    }

    #[test]
    fn every_connection_scheme_is_matched_before_the_paper_wallet_rule() {
        // All three pairing URIs end in base58-ish text after a colon, which is
        // exactly what the paper-wallet rule reads. Each one is checked here,
        // not just the first, because adding a fourth scheme below the key
        // check is how this would come back.
        for (uri, expected) in [
            (
                format!("bch-cc-v1://relay.example/{WIF_COMPRESSED}"),
                "cashconnect",
            ),
            (format!("wc:{WIF_COMPRESSED}@2"), "walletconnect"),
            (
                format!("wiz://relay.example/{WIF_COMPRESSED}"),
                "wizardconnect",
            ),
        ] {
            let payload = classify_scanned_payload(&uri, Network::Chipnet);
            let kind = match payload {
                ScannedPayload::CashConnect { .. } => "cashconnect",
                ScannedPayload::WalletConnect { .. } => "walletconnect",
                ScannedPayload::WizardConnect { .. } => "wizardconnect",
                other => panic!("{uri} became {other:?}"),
            };
            assert_eq!(kind, expected, "{uri}");
        }
    }

    #[test]
    fn a_merchant_proposal_stream_is_its_own_answer() {
        assert_eq!(
            classify_scanned_payload("qrstream/1/AAAA-bb_cc==", Network::Chipnet),
            ScannedPayload::MerchantProposal {
                initial_payload: "qrstream/1/AAAA-bb_cc==".to_string()
            }
        );
        // An empty body is not a stream, and neither is a later version.
        assert_eq!(
            classify_scanned_payload("qrstream/1/", Network::Chipnet),
            ScannedPayload::Unrecognised
        );
        assert_eq!(
            classify_scanned_payload("qrstream/2/AAAA", Network::Chipnet),
            ScannedPayload::Unrecognised
        );
    }

    #[test]
    fn a_paper_wallet_key_never_reaches_a_log_through_debug() {
        // The leak this wrapper exists to prevent: any error report, panic or
        // trace that formats the payload would otherwise carry a spendable key.
        let payload = classify_scanned_payload(WIF_COMPRESSED, Network::Mainnet);
        let ScannedPayload::PaperWallet(key) = &payload else {
            panic!("expected a paper wallet, got {payload:?}");
        };
        assert_eq!(key.expose_wif(), WIF_COMPRESSED);
        assert_eq!(key.key_network(), Some(Network::Mainnet));

        let rendered = format!("{payload:?}");
        assert!(
            !rendered.contains(WIF_COMPRESSED),
            "Debug leaked the key: {rendered}"
        );
        assert!(rendered.contains("<redacted>"), "{rendered}");
    }

    #[test]
    fn both_wif_forms_decode_and_a_near_miss_does_not() {
        for wif in [WIF_UNCOMPRESSED, WIF_COMPRESSED] {
            assert!(
                matches!(
                    classify_scanned_payload(wif, Network::Mainnet),
                    ScannedPayload::PaperWallet(_)
                ),
                "{wif} is a valid WIF"
            );
        }

        // One character different: the checksum is what decides, not the shape.
        let mut broken: Vec<char> = WIF_COMPRESSED.chars().collect();
        broken[10] = if broken[10] == 'a' { 'b' } else { 'a' };
        let broken: String = broken.into_iter().collect();
        assert_ne!(broken, WIF_COMPRESSED);
        assert!(!matches!(
            classify_scanned_payload(&broken, Network::Mainnet),
            ScannedPayload::PaperWallet(_)
        ));
    }

    #[test]
    fn a_key_written_with_a_prefix_is_still_found() {
        // The rule that reads the text after the last colon, which is how paper
        // wallets printed as `bitcoincash:<wif>` used to scan.
        let printed = format!("bitcoincash:{WIF_UNCOMPRESSED}");
        let payload = classify_scanned_payload(&printed, Network::Mainnet);
        let ScannedPayload::PaperWallet(key) = &payload else {
            panic!("expected a paper wallet, got {payload:?}");
        };
        assert_eq!(key.expose_wif(), WIF_UNCOMPRESSED);
    }

    #[test]
    fn a_key_for_the_other_chain_says_which_chain_it_is_for() {
        // Sweeping a mainnet key with a chipnet wallet finds nothing, which
        // looks exactly like an empty paper wallet unless someone looked.
        let payload = classify_scanned_payload(WIF_COMPRESSED, Network::Chipnet);
        let ScannedPayload::PaperWallet(key) = &payload else {
            panic!("expected a paper wallet, got {payload:?}");
        };
        assert_eq!(key.key_network(), Some(Network::Mainnet));
        assert!(!key.matches(Network::Chipnet));
        assert!(key.matches(Network::Mainnet));
    }

    #[test]
    fn an_address_for_this_network_is_a_recipient_with_or_without_its_prefix() {
        for network in [Network::Mainnet, Network::Chipnet] {
            let full = address_for(network, AddressKind::P2pkh);
            let bare = full.split_once(':').expect("prefixed").1.to_string();

            for input in [full.clone(), bare.clone(), bare.to_uppercase()] {
                let payload = classify_scanned_payload(&input, network);
                let ScannedPayload::Recipient(recipient) = payload else {
                    panic!("{input} should be payable on {network:?}");
                };
                // Normalised: the prefix is always carried, whatever arrived.
                assert_eq!(recipient.address, full);
                assert_eq!(recipient.kind, AddressKind::P2pkh);
                assert!(!recipient.is_legacy_base58);
                assert!(!recipient.accepts_tokens());
            }
        }
    }

    #[test]
    fn a_token_address_is_reported_as_one() {
        // Sending tokens to a non-token address is how tokens get destroyed, so
        // the flag has to survive the scan.
        let token = address_for(Network::Chipnet, AddressKind::P2pkhToken);
        let ScannedPayload::Recipient(recipient) =
            classify_scanned_payload(&token, Network::Chipnet)
        else {
            panic!("token address should be payable");
        };
        assert_eq!(recipient.kind, AddressKind::P2pkhToken);
        assert!(recipient.accepts_tokens());
    }

    #[test]
    fn the_other_chains_address_is_refused_as_the_wrong_network_not_as_gibberish() {
        // The bug this prevents: same hash160, wrong chain, coins invisible on
        // the destination wallet. And the message has to say which chain, since
        // "not a supported address" is what people used to see.
        let mainnet = address_for(Network::Mainnet, AddressKind::P2pkh);
        let chipnet = address_for(Network::Chipnet, AddressKind::P2pkh);

        let on_chipnet = classify_scanned_payload(&mainnet, Network::Chipnet);
        assert_eq!(
            on_chipnet,
            ScannedPayload::WrongNetwork(WrongNetwork {
                wallet_network: Network::Chipnet
            })
        );
        assert!(on_chipnet
            .refusal()
            .expect("a refusal")
            .contains("This wallet is on Chipnet"));

        let on_mainnet = classify_scanned_payload(&chipnet, Network::Mainnet);
        assert!(on_mainnet
            .refusal()
            .expect("a refusal")
            .contains("This wallet is on Mainnet"));

        // And a payload that succeeded never carries a refusal.
        assert_eq!(
            classify_scanned_payload(&chipnet, Network::Chipnet).refusal(),
            None
        );
    }

    #[test]
    fn a_bare_payload_is_never_tried_against_the_other_chain() {
        // Without a prefix there is nothing to compare, so the only protection
        // is that the checksum covers the prefix and only this network's is
        // ever tried.
        let mainnet_bare = address_for(Network::Mainnet, AddressKind::P2pkh)
            .split_once(':')
            .expect("prefixed")
            .1
            .to_string();
        assert_eq!(
            classify_scanned_payload(&mainnet_bare, Network::Chipnet),
            ScannedPayload::Unrecognised
        );
    }

    #[test]
    fn legacy_base58_is_mainnet_only() {
        let ScannedPayload::Recipient(recipient) =
            classify_scanned_payload(LEGACY_P2PKH, Network::Mainnet)
        else {
            panic!("legacy addresses are payable on mainnet");
        };
        assert!(recipient.is_legacy_base58);
        assert_eq!(recipient.address, LEGACY_P2PKH);
        assert_eq!(recipient.kind, AddressKind::P2pkh);

        // On chipnet it is the wrong chain, not an unreadable string.
        assert_eq!(
            classify_scanned_payload(LEGACY_P2PKH, Network::Chipnet),
            ScannedPayload::WrongNetwork(WrongNetwork {
                wallet_network: Network::Chipnet
            })
        );
    }

    #[test]
    fn a_bip21_amount_survives_as_the_text_it_arrived_as() {
        // A round trip through f64 is how a wallet pays a slightly different
        // amount than the invoice asked for.
        let address = address_for(Network::Chipnet, AddressKind::P2pkh);
        let uri = format!("{address}?amount=0.00000001&label=Coffee%20Shop&message=a+tip");
        let ScannedPayload::Recipient(recipient) = classify_scanned_payload(&uri, Network::Chipnet)
        else {
            panic!("a BIP21 URI is payable");
        };
        assert!(recipient.is_bip21);
        assert_eq!(recipient.amount_raw.as_deref(), Some("0.00000001"));
        assert_eq!(recipient.label.as_deref(), Some("Coffee Shop"));
        assert_eq!(recipient.message.as_deref(), Some("a tip"));
    }

    #[test]
    fn an_amount_that_is_not_a_positive_finite_number_is_dropped() {
        let address = address_for(Network::Chipnet, AddressKind::P2pkh);
        for bad in ["0", "-1", "abc", "1abc", "inf", "NaN", ""] {
            let uri = format!("{address}?amount={bad}");
            let ScannedPayload::Recipient(recipient) =
                classify_scanned_payload(&uri, Network::Chipnet)
            else {
                panic!("the address is still payable with a bad amount: {bad}");
            };
            assert_eq!(
                recipient.amount_raw, None,
                "amount '{bad}' must not reach a send screen"
            );
        }
    }

    #[test]
    fn a_bare_address_is_not_a_uri_and_nothing_is_invented_for_it() {
        let address = address_for(Network::Mainnet, AddressKind::P2pkh);
        let bare = address.split_once(':').expect("prefixed").1;
        let ScannedPayload::Recipient(recipient) = classify_scanned_payload(bare, Network::Mainnet)
        else {
            panic!("payable");
        };
        assert!(!recipient.is_bip21);
        assert_eq!(recipient.amount_raw, None);
        assert_eq!(recipient.label, None);
        assert_eq!(recipient.message, None);
    }

    #[test]
    fn nothing_at_all_is_unrecognised_rather_than_an_error() {
        for input in ["", "   ", "hello", "https://example.com", "bitcoincash:"] {
            assert_eq!(
                classify_scanned_payload(input, Network::Mainnet),
                ScannedPayload::Unrecognised,
                "{input:?}"
            );
        }
        assert!(classify_scanned_payload("hello", Network::Mainnet)
            .refusal()
            .is_some());
    }

    #[test]
    fn base58check_rejects_what_base58_alone_would_accept() {
        // The line between "looks like base58" and "is a key".
        assert!(base58check_decode(WIF_COMPRESSED).is_some());
        assert!(base58check_decode("1111111111").is_none());
        assert!(base58check_decode("").is_none());
        // Leading '1's are leading zero bytes, which is what makes a legacy
        // P2PKH address decode to a 21-byte body with a zero version.
        let body = base58check_decode(LEGACY_P2PKH).expect("a legacy address");
        assert_eq!(body.len(), 21);
        assert_eq!(body[0], 0x00);
    }
}

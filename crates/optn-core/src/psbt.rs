//! The air-gapped signing envelope, and the rules that make it safe.
//!
//! A watch-only wallet builds a transaction it cannot sign, shows it as an
//! animated QR, and a device with the keys signs it offline. Nothing in that
//! loop can ask a question: by the time anything is wrong, the device has been
//! put away. So the rules live here, next to the parser that can check them.
//!
//! **Every input must carry `PSBT_IN_SIGHASH_TYPE`, and it must be `0xc1`.**
//! SeedCash falls back to `0x41` when the field is absent, and a signature over
//! the wrong sighash is only rejected at broadcast — long after the device is
//! back in its drawer. A missing field is therefore refused just as firmly as a
//! wrong one: silence is what makes the fallback dangerous.
//!
//! **Mainnet is refused by the encoder, not by convention.** The air-gap path
//! is chipnet-only while it is being proven, and "we agreed not to" is not a
//! control.
//!
//! **The UR carries a raw PSBT.** Stock SeedCash calls
//! `parse_psbt(decoder.result_message().cbor)` and never unwraps a CBOR byte
//! string, so the BCR-2020-006 wrapper Keystone uses is unreadable there: it
//! sees `59019070736274ff…` and raises `invalid PSBT magic`. We emit raw and
//! *accept* either on the way back, because a device that wraps is not wrong,
//! only different.
//!
//! **The master fingerprint is optional.** SeedCash's `sign_psbt_with_xpriv`
//! reads only the BIP32 path from key `0x06` and discards the fingerprint, and
//! nothing in the device uses it to accept or reject a signature. A wallet that
//! has one gets it stamped; a wallet that does not gets zeros and keeps its
//! derivation path, which is the field that actually matters.

use crate::error::{CliError, Result};
use crate::network::Network;
use crate::rpa::parse_transaction;
use crate::watch_only::normalize_master_fingerprint;

/// `psbt` followed by `0xff`.
pub const PSBT_MAGIC: &[u8] = b"psbt\xff";

/// Global key type holding the unsigned transaction.
pub const GLOBAL_UNSIGNED_TX: u8 = 0x00;
/// Per-input key type holding the sighash the signer must use.
pub const IN_SIGHASH_TYPE: u8 = 0x03;
/// Per-input key type holding a pubkey's fingerprint and derivation path.
pub const IN_BIP32_DERIVATION: u8 = 0x06;

/// `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY`.
///
/// The only sighash this wallet will hand to an air-gapped signer.
pub const WATCH_ONLY_SIGHASH: u32 = 0xc1;

/// The value SeedCash assumes when the field is missing: `ALL | FORKID`.
///
/// Named so the refusal can say what would have happened instead.
pub const SEEDCASH_FALLBACK_SIGHASH: u32 = 0x41;

/// What to stamp when the wallet has no fingerprint of its own.
pub const ABSENT_FINGERPRINT: [u8; 4] = [0, 0, 0, 0];

/// QR parameters a SeedCash camera can actually read.
///
/// Not cosmetic. The previous values — fragment 200, quiet zone 4, 220px —
/// produced a QR the device could not decode at all, and the symptom is a
/// camera that simply will not scan rather than any failure this side can see.
/// The exact frames these produce are pinned by conformance vectors that run
/// through SeedCash's own decoder.
pub struct SeedCashQr;

impl SeedCashQr {
    /// UR fragment size, in bytes.
    pub const CHUNK_SIZE: usize = 50;
    /// Quiet-zone padding, in modules.
    pub const PADDING: u32 = 8;
    /// Rendered size, in pixels.
    pub const PIXELS: u32 = 640;
    /// Error-correction level. Low, because density is the binding constraint.
    pub const ERROR_CORRECTION: char = 'L';
}

/// A pubkey's origin, as an input's BIP32 derivation record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyOrigin {
    /// The compressed pubkey this record is for.
    pub pubkey: [u8; 33],
    pub fingerprint: [u8; 4],
    /// The path, as raw indices; hardened steps keep their high bit.
    pub path: Vec<u32>,
}

impl KeyOrigin {
    /// Whether the fingerprint is the placeholder rather than a real one.
    pub fn fingerprint_is_absent(&self) -> bool {
        self.fingerprint == ABSENT_FINGERPRINT
    }
}

/// One input's fields, as far as the air-gap rules need them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PsbtInput {
    /// `None` means the field was absent, which is a refusal rather than a
    /// default: see the module docs.
    pub sighash_type: Option<u32>,
    pub origins: Vec<KeyOrigin>,
}

/// A parsed PSBT, to the depth these checks need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Psbt {
    pub unsigned_tx: Vec<u8>,
    pub inputs: Vec<PsbtInput>,
    pub output_count: usize,
}

/// Parse a PSBT far enough to check it.
///
/// The map format is simple, but how many input maps to expect is not: it comes
/// from the unsigned transaction in the global map. That is read with the same
/// wire parser the RPA scanner uses, rather than a second one written here —
/// two transaction parsers that disagree is a class of bug worth not having.
pub fn parse(raw: &[u8]) -> Result<Psbt> {
    if raw.len() < PSBT_MAGIC.len() || &raw[..PSBT_MAGIC.len()] != PSBT_MAGIC {
        return Err(CliError::Protocol(
            "not a PSBT: the magic bytes are missing".into(),
        ));
    }
    let mut cursor = Cursor::new(raw, PSBT_MAGIC.len());

    let global = cursor.read_map()?;
    let unsigned_tx = global
        .iter()
        .find(|(key, _)| key.first() == Some(&GLOBAL_UNSIGNED_TX))
        .map(|(_, value)| value.clone())
        .ok_or_else(|| CliError::Protocol("PSBT has no unsigned transaction".into()))?;

    let (tx_inputs, tx_outputs) = parse_transaction(&unsigned_tx)?;

    let mut inputs = Vec::with_capacity(tx_inputs.len());
    for index in 0..tx_inputs.len() {
        let fields = cursor
            .read_map()
            .map_err(|error| CliError::Protocol(format!("input {index}: {error}")))?;
        inputs.push(input_from_fields(index, &fields)?);
    }
    for index in 0..tx_outputs.len() {
        cursor
            .read_map()
            .map_err(|error| CliError::Protocol(format!("output {index}: {error}")))?;
    }

    Ok(Psbt {
        unsigned_tx,
        inputs,
        output_count: tx_outputs.len(),
    })
}

fn input_from_fields(index: usize, fields: &[(Vec<u8>, Vec<u8>)]) -> Result<PsbtInput> {
    let mut input = PsbtInput::default();
    for (key, value) in fields {
        match key.first() {
            Some(&IN_SIGHASH_TYPE) => {
                let bytes: [u8; 4] = value.as_slice().try_into().map_err(|_| {
                    CliError::Protocol(format!(
                        "input {index}: sighash type is {} bytes, not 4",
                        value.len()
                    ))
                })?;
                input.sighash_type = Some(u32::from_le_bytes(bytes));
            }
            Some(&IN_BIP32_DERIVATION) => {
                input.origins.push(key_origin(index, key, value)?);
            }
            _ => {}
        }
    }
    Ok(input)
}

fn key_origin(index: usize, key: &[u8], value: &[u8]) -> Result<KeyOrigin> {
    let pubkey: [u8; 33] = key
        .get(1..)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| {
            CliError::Protocol(format!(
                "input {index}: a derivation key needs a 33-byte compressed pubkey"
            ))
        })?;
    if value.len() < 4 || (value.len() - 4) % 4 != 0 {
        return Err(CliError::Protocol(format!(
            "input {index}: a derivation record is a 4-byte fingerprint then whole path steps, \
             got {} bytes",
            value.len()
        )));
    }
    let mut fingerprint = [0u8; 4];
    fingerprint.copy_from_slice(&value[..4]);
    let path = value[4..]
        .chunks_exact(4)
        .map(|step| u32::from_le_bytes([step[0], step[1], step[2], step[3]]))
        .collect();
    Ok(KeyOrigin {
        pubkey,
        fingerprint,
        path,
    })
}

/// Check a PSBT this wallet is about to display to an air-gapped signer.
///
/// Both rules are enforced here rather than trusted: the network, because the
/// air-gap path is chipnet-only while it is being proven, and the sighash on
/// every input, because a device cannot ask.
pub fn check_watch_only(raw: &[u8], network: Network) -> Result<Psbt> {
    if network != Network::Chipnet {
        return Err(CliError::Usage(
            "the air-gap signing path is chipnet-only. This is refused here rather than left to \
             convention."
                .into(),
        ));
    }
    let psbt = parse(raw)?;
    if psbt.inputs.is_empty() {
        return Err(CliError::Protocol(
            "a PSBT with no inputs cannot be signed".into(),
        ));
    }
    for (index, input) in psbt.inputs.iter().enumerate() {
        match input.sighash_type {
            Some(WATCH_ONLY_SIGHASH) => {}
            Some(SEEDCASH_FALLBACK_SIGHASH) => {
                return Err(CliError::Protocol(format!(
                    "input {index} asks for sighash 0x41; this wallet signs air-gapped with \
                     0xc1 (ALL|FORKID|ANYONECANPAY) only"
                )))
            }
            Some(other) => {
                return Err(CliError::Protocol(format!(
                    "input {index} asks for sighash {other:#04x}; only 0xc1 is accepted"
                )))
            }
            None => {
                return Err(CliError::Protocol(format!(
                    "input {index} carries no sighash type. SeedCash would fall back to 0x41 and \
                     the wrong signature is only caught at broadcast, so an absent field is \
                     refused here"
                )))
            }
        }
    }
    Ok(psbt)
}

/// The fingerprint to stamp into a PSBT.
///
/// A wallet that saved one gets it, normalised. A wallet that did not gets
/// zeros, and keeps its derivation path — which is the field SeedCash reads.
pub fn fingerprint_to_stamp(saved: Option<&str>) -> Result<[u8; 4]> {
    // `normalize_master_fingerprint` already carries the "optional" rule: an
    // empty string is None rather than an error, and anything present must be
    // exactly eight hex characters. Reusing it keeps one definition of what a
    // fingerprint is.
    let Some(normalised) = normalize_master_fingerprint(saved.unwrap_or(""))? else {
        return Ok(ABSENT_FINGERPRINT);
    };
    let mut bytes = [0u8; 4];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let pair = normalised
            .get(index * 2..index * 2 + 2)
            .ok_or_else(|| CliError::Internal("a normalised fingerprint is four bytes".into()))?;
        *byte = u8::from_str_radix(pair, 16).map_err(|_| {
            CliError::Internal(format!("'{normalised}' passed validation but is not hex"))
        })?;
    }
    Ok(bytes)
}

/// The PSBT inside a `ur:crypto-psbt` payload, whichever framing it used.
///
/// Raw is what we emit, because stock SeedCash reads the CBOR field directly.
/// A BCR-2020-006 byte-string wrapper is accepted on the way back, because a
/// device that wraps — Keystone does — is not wrong, only different.
pub fn psbt_from_ur_cbor(cbor: &[u8]) -> Result<&[u8]> {
    if cbor.starts_with(PSBT_MAGIC) {
        return Ok(cbor);
    }
    if let Some(inner) = unwrap_cbor_byte_string(cbor) {
        if inner.starts_with(PSBT_MAGIC) {
            return Ok(inner);
        }
    }
    Err(CliError::Protocol(
        "the UR payload is neither a raw PSBT nor a CBOR byte string holding one".into(),
    ))
}

/// The contents of a CBOR major-type-2 byte string, if that is what this is.
fn unwrap_cbor_byte_string(cbor: &[u8]) -> Option<&[u8]> {
    let first = *cbor.first()?;
    // Major type 2 occupies 0x40..=0x5b; the low five bits are the length, or
    // 24/25/26/27 for a length in the following 1, 2, 4 or 8 bytes.
    if first & 0xe0 != 0x40 {
        return None;
    }
    let (length, header) = match first & 0x1f {
        immediate @ 0..=23 => (usize::from(immediate), 1usize),
        24 => (usize::from(*cbor.get(1)?), 2),
        25 => (
            usize::from(u16::from_be_bytes([*cbor.get(1)?, *cbor.get(2)?])),
            3,
        ),
        26 => (
            usize::try_from(u32::from_be_bytes([
                *cbor.get(1)?,
                *cbor.get(2)?,
                *cbor.get(3)?,
                *cbor.get(4)?,
            ]))
            .ok()?,
            5,
        ),
        // An indefinite-length or 64-bit byte string is not something a QR
        // holds; refusing is better than half-decoding one.
        _ => return None,
    };
    let body = cbor.get(header..)?;
    (body.len() == length).then_some(body)
}

/// A cursor over a PSBT's key-value maps.
struct Cursor<'a> {
    raw: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    const fn new(raw: &'a [u8], at: usize) -> Self {
        Self { raw, at }
    }

    /// One map: `<keylen><key><vallen><value>` pairs until a zero-length key.
    fn read_map(&mut self) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let mut fields = Vec::new();
        loop {
            let key_len = self.compact_size()?;
            if key_len == 0 {
                return Ok(fields);
            }
            let key = self.take(key_len)?.to_vec();
            let value_len = self.compact_size()?;
            let value = self.take(value_len)?.to_vec();
            fields.push((key, value));
        }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(len)
            .filter(|end| *end <= self.raw.len())
            .ok_or_else(|| CliError::Protocol("PSBT ends mid-record".into()))?;
        let slice = &self.raw[self.at..end];
        self.at = end;
        Ok(slice)
    }

    /// Bitcoin's CompactSize, which PSBT uses for every length.
    fn compact_size(&mut self) -> Result<usize> {
        let first = *self
            .take(1)?
            .first()
            .ok_or_else(|| CliError::Protocol("PSBT ends where a length was expected".into()))?;
        let width = match first {
            0..=0xfc => return Ok(usize::from(first)),
            0xfd => 2,
            0xfe => 4,
            _ => 8,
        };
        let bytes = self.take(width)?;
        let mut buf = [0u8; 8];
        buf[..width].copy_from_slice(bytes);
        usize::try_from(u64::from_le_bytes(buf))
            .map_err(|_| CliError::Protocol("PSBT record length exceeds this platform".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compact_size(value: usize) -> Vec<u8> {
        match value {
            0..=0xfc => vec![value as u8],
            _ => {
                let mut out = vec![0xfd];
                out.extend_from_slice(&(value as u16).to_le_bytes());
                out
            }
        }
    }

    fn field(key: &[u8], value: &[u8]) -> Vec<u8> {
        let mut out = compact_size(key.len());
        out.extend_from_slice(key);
        out.extend_from_slice(&compact_size(value.len()));
        out.extend_from_slice(value);
        out
    }

    /// A one-input, one-output transaction, in wire form.
    fn unsigned_tx() -> Vec<u8> {
        let mut tx = Vec::new();
        tx.extend_from_slice(&2u32.to_le_bytes()); // version
        tx.push(1); // one input
        tx.extend_from_slice(&[9u8; 32]); // outpoint txid
        tx.extend_from_slice(&0u32.to_le_bytes()); // vout
        tx.push(0); // empty scriptSig, as an unsigned input has
        tx.extend_from_slice(&0xffff_fffeu32.to_le_bytes()); // sequence
        tx.push(1); // one output
        tx.extend_from_slice(&50_000u64.to_le_bytes());
        tx.push(25); // a P2PKH script
        tx.extend_from_slice(&[0x76, 0xa9, 0x14]);
        tx.extend_from_slice(&[7u8; 20]);
        tx.extend_from_slice(&[0x88, 0xac]);
        tx.extend_from_slice(&0u32.to_le_bytes()); // locktime
        tx
    }

    /// A PSBT whose single input carries the given sighash, if any.
    fn psbt_with_sighash(sighash: Option<u32>) -> Vec<u8> {
        let mut out = PSBT_MAGIC.to_vec();
        out.extend_from_slice(&field(&[GLOBAL_UNSIGNED_TX], &unsigned_tx()));
        out.push(0x00); // end of the global map

        if let Some(sighash) = sighash {
            out.extend_from_slice(&field(&[IN_SIGHASH_TYPE], &sighash.to_le_bytes()));
        }
        let mut origin_key = vec![IN_BIP32_DERIVATION];
        origin_key.extend_from_slice(&[0x02; 33]);
        let mut origin = ABSENT_FINGERPRINT.to_vec();
        for step in [44 | 0x8000_0000, 145 | 0x8000_0000, 0x8000_0000, 0, 0] {
            origin.extend_from_slice(&u32::to_le_bytes(step));
        }
        out.extend_from_slice(&field(&origin_key, &origin));
        out.push(0x00); // end of the input map

        out.push(0x00); // an empty output map
        out
    }

    #[test]
    fn the_only_accepted_air_gap_sighash_is_c1() {
        // The rule this module exists for. A wrong sighash is not caught by the
        // device, or by this wallet at signing time -- only by the network, at
        // broadcast, long after the device has been put away.
        let ok = check_watch_only(
            &psbt_with_sighash(Some(WATCH_ONLY_SIGHASH)),
            Network::Chipnet,
        )
        .expect("0xc1 is the one we sign with");
        assert_eq!(ok.inputs.len(), 1);
        assert_eq!(ok.inputs[0].sighash_type, Some(0xc1));

        let fallback = check_watch_only(
            &psbt_with_sighash(Some(SEEDCASH_FALLBACK_SIGHASH)),
            Network::Chipnet,
        )
        .expect_err("0x41 must be refused");
        assert!(fallback.to_string().contains("0x41"), "{fallback}");

        let odd = check_watch_only(&psbt_with_sighash(Some(0x01)), Network::Chipnet)
            .expect_err("and so must anything else");
        assert!(odd.to_string().contains("only 0xc1"), "{odd}");
    }

    #[test]
    fn an_absent_sighash_field_is_refused_because_silence_is_the_dangerous_case() {
        // SeedCash falls back to 0x41 when the field is missing, so leaving it
        // out is not "unspecified", it is "0x41, silently".
        let error = check_watch_only(&psbt_with_sighash(None), Network::Chipnet)
            .expect_err("a missing field must not pass");
        let message = error.to_string();
        assert!(message.contains("no sighash type"), "{message}");
        assert!(
            message.contains("0x41"),
            "the reason must name it: {message}"
        );
    }

    #[test]
    fn mainnet_is_refused_by_the_encoder_rather_than_by_convention() {
        let raw = psbt_with_sighash(Some(WATCH_ONLY_SIGHASH));
        let error =
            check_watch_only(&raw, Network::Mainnet).expect_err("mainnet air-gap is not proven");
        assert!(error.to_string().contains("chipnet-only"), "{error}");
        // And the same bytes are fine on the network it was built for.
        assert!(check_watch_only(&raw, Network::Chipnet).is_ok());
    }

    #[test]
    fn the_input_count_comes_from_the_transaction_not_from_counting_maps() {
        // Which is what lets an input map and an output map be told apart at
        // all, and why this reuses the wire parser instead of guessing.
        let psbt = parse(&psbt_with_sighash(Some(WATCH_ONLY_SIGHASH))).expect("parses");
        assert_eq!(psbt.inputs.len(), 1);
        assert_eq!(psbt.output_count, 1);
        assert_eq!(psbt.unsigned_tx, unsigned_tx());
    }

    #[test]
    fn the_derivation_path_survives_even_when_the_fingerprint_is_zeros() {
        // The SeedCash rule: it reads the path from key 0x06 and discards the
        // fingerprint, so zeros are a valid stamp and the path is what matters.
        let psbt = parse(&psbt_with_sighash(Some(WATCH_ONLY_SIGHASH))).expect("parses");
        let origin = &psbt.inputs[0].origins[0];
        assert!(origin.fingerprint_is_absent());
        assert_eq!(
            origin.path,
            vec![44 | 0x8000_0000, 145 | 0x8000_0000, 0x8000_0000, 0, 0]
        );
        assert_eq!(origin.pubkey, [0x02; 33]);
    }

    #[test]
    fn a_wallet_without_a_fingerprint_stamps_zeros_and_one_with_it_stamps_it() {
        assert_eq!(
            fingerprint_to_stamp(None).expect("none"),
            ABSENT_FINGERPRINT
        );
        assert_eq!(
            fingerprint_to_stamp(Some("")).expect("blank"),
            ABSENT_FINGERPRINT
        );
        assert_eq!(
            fingerprint_to_stamp(Some("  ")).expect("whitespace"),
            ABSENT_FINGERPRINT
        );
        assert_eq!(
            fingerprint_to_stamp(Some("0f1e2d3c")).expect("hex"),
            [0x0f, 0x1e, 0x2d, 0x3c]
        );
        // A malformed one is still an error: it would break PSBT key origins,
        // and finding that out at signing time is too late.
        assert!(fingerprint_to_stamp(Some("nonsense")).is_err());
    }

    #[test]
    fn a_ur_payload_is_read_raw_or_unwrapped_but_never_half_decoded() {
        let raw = psbt_with_sighash(Some(WATCH_ONLY_SIGHASH));

        // What we emit: SeedCash reads the CBOR field directly.
        assert_eq!(psbt_from_ur_cbor(&raw).expect("raw"), raw.as_slice());

        // What Keystone returns: a CBOR byte string around the same bytes. The
        // 0x59 header is exactly the `59019070736274ff…` SeedCash choked on.
        let mut wrapped = vec![0x59];
        wrapped.extend_from_slice(&(raw.len() as u16).to_be_bytes());
        wrapped.extend_from_slice(&raw);
        assert_eq!(
            psbt_from_ur_cbor(&wrapped).expect("wrapped"),
            raw.as_slice()
        );

        // A short byte string uses the immediate form.
        let mut short = vec![0x40 | 5];
        short.extend_from_slice(b"psbt\xff");
        assert_eq!(psbt_from_ur_cbor(&short).expect("short"), b"psbt\xff");

        // Anything else is refused rather than guessed at.
        assert!(psbt_from_ur_cbor(b"not a psbt").is_err());
        assert!(psbt_from_ur_cbor(&[]).is_err());
        // A wrapper whose declared length disagrees with what followed.
        assert!(psbt_from_ur_cbor(&[0x59, 0xff, 0xff, 0x70]).is_err());
    }

    #[test]
    fn a_truncated_or_unmagicked_payload_is_an_error_not_a_panic() {
        assert!(parse(b"").is_err());
        assert!(parse(b"psbt").is_err());
        assert!(parse(b"nope\xff").is_err());
        let full = psbt_with_sighash(Some(WATCH_ONLY_SIGHASH));
        for cut in [6, 12, 20, full.len() - 1] {
            assert!(parse(&full[..cut]).is_err(), "truncated at {cut} must fail");
        }
    }

    #[test]
    fn the_seedcash_qr_numbers_are_the_ones_its_camera_can_read() {
        // Pinned rather than tuned: the previous values produced a QR the
        // device could not decode, and the only symptom was a camera that
        // would not scan.
        assert_eq!(SeedCashQr::CHUNK_SIZE, 50);
        assert_eq!(SeedCashQr::PADDING, 8);
        assert_eq!(SeedCashQr::PIXELS, 640);
        assert_eq!(SeedCashQr::ERROR_CORRECTION, 'L');
    }
}

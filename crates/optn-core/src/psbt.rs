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

/// Which form of "the output being spent" an input carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UtxoField {
    /// The whole parent transaction. What Paytaca writes, and the only form
    /// SeedCash reads correctly.
    NonWitness,
    /// Just the amount and the locking script.
    Witness,
}

/// One input's fields, as far as the air-gap rules need them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PsbtInput {
    /// `None` means the field was absent, which is a refusal rather than a
    /// default: see the module docs.
    pub sighash_type: Option<u32>,
    /// Which utxo form was present. `None` means neither.
    pub utxo: Option<UtxoField>,
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
        // A single-byte key is a field type; a longer one carries a pubkey.
        let utxo = match (key.len(), key.first()) {
            (1, Some(&IN_NON_WITNESS_UTXO)) => Some(UtxoField::NonWitness),
            (1, Some(&IN_WITNESS_UTXO)) => Some(UtxoField::Witness),
            _ => None,
        };
        if let Some(utxo) = utxo {
            if input.utxo.is_some_and(|seen| seen != utxo) {
                // SeedCash's parse loop lets whichever key appears last win, so
                // a PSBT carrying the pair is correct or broken depending on
                // map ordering. That is not a thing to resolve; it is a thing
                // to refuse.
                return Err(CliError::Protocol(format!(
                    "input {index} carries both utxo forms; a reader that takes the last one \
                     would behave differently depending on the order they were written in"
                )));
            }
            input.utxo = Some(utxo);
        }
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

// ---------------------------------------------------------------------------
// Writing one
// ---------------------------------------------------------------------------

/// Global key type carrying an account xPub and its origin.
pub const GLOBAL_XPUB: u8 = 0x01;
/// Global key type carrying the number of inputs. A v145 field.
pub const GLOBAL_INPUT_COUNT: u8 = 0x04;
/// Global key type carrying the number of outputs. A v145 field.
pub const GLOBAL_OUTPUT_COUNT: u8 = 0x05;
/// Global key type carrying the PSBT version.
pub const GLOBAL_VERSION: u8 = 0xfb;

/// Per-input key type carrying the whole parent transaction.
pub const IN_NON_WITNESS_UTXO: u8 = 0x00;
/// Per-input key type carrying only the output being spent.
pub const IN_WITNESS_UTXO: u8 = 0x01;
/// Per-input key type carrying a signature already collected.
pub const IN_PARTIAL_SIG: u8 = 0x02;
/// Per-input key type carrying the P2SH redeem script.
pub const IN_REDEEM_SCRIPT: u8 = 0x04;
/// Per-input key type carrying the outpoint txid. A v145 field.
pub const IN_PREVIOUS_TXID: u8 = 0x0e;
/// Per-input key type carrying the outpoint index. A v145 field.
pub const IN_OUTPUT_INDEX: u8 = 0x0f;
/// Per-input key type carrying the sequence number. A v145 field.
pub const IN_SEQUENCE: u8 = 0x10;

/// Per-output key type carrying the P2SH redeem script.
pub const OUT_REDEEM_SCRIPT: u8 = 0x00;
/// Per-output key type carrying a pubkey's origin, which is how a device knows
/// an output is the wallet's own change.
pub const OUT_BIP32_DERIVATION: u8 = 0x02;
/// Per-output key type carrying the amount. A v145 field.
pub const OUT_AMOUNT: u8 = 0x03;
/// Per-output key type carrying the locking bytecode. A v145 field.
pub const OUT_SCRIPT: u8 = 0x04;
/// Per-output key type carrying a CashToken prefix.
pub const OUT_CASHTOKEN: u8 = 0x36;

/// The PSBT version this wallet writes.
///
/// Paytaca's reader requires the field; SeedCash skips it. Writing it costs
/// nothing and is the difference between the two reading the same bytes.
pub const PSBT_VERSION_145: u64 = 145;

/// The FORKID bit. Without it a signature is not valid on Bitcoin Cash at all.
pub const SIGHASH_FORKID_BIT: u32 = 0x40;

/// One input of a transaction to be signed off-device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PsbtInputSpec {
    /// The outpoint txid in **display** order, as it is written in a block
    /// explorer. The wire reversal happens inside the encoder, once.
    pub txid_display: [u8; 32],
    pub vout: u32,
    /// `None` is `0xffffffff`.
    pub sequence: Option<u32>,
    /// The value of the output being spent.
    ///
    /// Not optional on Bitcoin Cash: a FORKID signature commits to the amount,
    /// so a signer that guessed it would produce a signature that verifies
    /// nowhere.
    pub satoshis: u64,
    pub locking_bytecode: Vec<u8>,
    /// The whole parent transaction, when it can be supplied.
    ///
    /// Strongly preferred over the amount-and-script form: it is the field
    /// Paytaca writes and the only one SeedCash reads correctly. SeedCash's
    /// witness-utxo handler slices `v[8:]`, which keeps the compact-size prefix
    /// BIP174 puts in front of the script and then re-prefixes it when building
    /// the preimage -- so it signs a hash over a script one byte longer than
    /// the one we verify against, and every signature mismatches.
    pub previous_transaction: Option<Vec<u8>>,
    pub redeem_script: Option<Vec<u8>>,
    /// Signatures already collected, for a multisig in progress.
    pub partial_signatures: Vec<PartialSignature>,
    /// Whose keys can sign this input, and where they come from.
    pub derivations: Vec<KeyOrigin>,
}

/// A signature already gathered for one input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialSignature {
    pub pubkey: [u8; 33],
    pub signature: Vec<u8>,
}

/// One output of a transaction to be signed off-device.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PsbtOutputSpec {
    pub satoshis: u64,
    pub locking_bytecode: Vec<u8>,
    pub redeem_script: Option<Vec<u8>>,
    /// Present when this output is the wallet's own change, so the device can
    /// show it as change rather than as an unknown third party.
    pub derivations: Vec<KeyOrigin>,
    /// An already-encoded CashToken prefix, passed through as bytes.
    pub token_prefix: Option<Vec<u8>>,
}

/// An account xPub advertised in the global map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalXpub {
    /// The 78-byte serialised extended key, without its base58 checksum.
    pub xpub_payload: Vec<u8>,
    pub fingerprint: [u8; 4],
    pub path: Vec<u32>,
}

/// Whether a sighash may be handed to an air-gapped signer.
///
/// Two separate refusals, because they fail differently. Without FORKID the
/// signature is not valid on Bitcoin Cash at all and the failure appears at
/// broadcast, after the user has already walked the transaction through a
/// device. With `0x41` it is a valid signature over the wrong thing.
pub fn check_sighash(value: u32) -> Result<()> {
    if value & SIGHASH_FORKID_BIT == 0 {
        return Err(CliError::Usage(format!(
            "sighash {value:#04x} has no SIGHASH_FORKID bit; a BCH signature without it is \
             rejected at broadcast, long after the device has signed"
        )));
    }
    if value != WATCH_ONLY_SIGHASH {
        return Err(CliError::Usage(format!(
            "sighash {value:#04x} is not accepted; this wallet signs air-gapped with 0xc1 \
             (ALL|FORKID|ANYONECANPAY) only, and omitting the field lets SeedCash fall back to \
             0x41"
        )));
    }
    Ok(())
}

/// Build the PSBT an air-gapped signer is shown.
///
/// The sighash is not a parameter. Every input gets `0xc1`, because that is the
/// only value this wallet's verifier accepts and a builder that could produce
/// anything else would be a second place for the rule to be wrong.
pub fn encode_unsigned(
    inputs: &[PsbtInputSpec],
    outputs: &[PsbtOutputSpec],
    global_xpubs: &[GlobalXpub],
) -> Result<Vec<u8>> {
    if inputs.is_empty() {
        return Err(CliError::Usage("a PSBT needs at least one input".into()));
    }
    if outputs.is_empty() {
        return Err(CliError::Usage("a PSBT needs at least one output".into()));
    }
    check_sighash(WATCH_ONLY_SIGHASH)?;

    let mut out = PSBT_MAGIC.to_vec();

    // ---- global map ----
    record(
        &mut out,
        &[GLOBAL_UNSIGNED_TX],
        &unsigned_transaction(inputs, outputs),
    );
    record(&mut out, &[GLOBAL_VERSION], &compact_size(PSBT_VERSION_145));
    for xpub in global_xpubs {
        if xpub.xpub_payload.len() != 78 {
            return Err(CliError::Usage(format!(
                "a global xPub payload is 78 bytes, got {}",
                xpub.xpub_payload.len()
            )));
        }
        let mut key = vec![GLOBAL_XPUB];
        key.extend_from_slice(&xpub.xpub_payload);
        record(&mut out, &key, &origin_value(xpub.fingerprint, &xpub.path));
    }
    // Explicit counts make the section boundaries unambiguous, which is how
    // SeedCash parses when they are present.
    record(
        &mut out,
        &[GLOBAL_INPUT_COUNT],
        &compact_size(inputs.len() as u64),
    );
    record(
        &mut out,
        &[GLOBAL_OUTPUT_COUNT],
        &compact_size(outputs.len() as u64),
    );
    out.push(0x00);

    // ---- one map per input ----
    for (index, input) in inputs.iter().enumerate() {
        if input.derivations.is_empty() {
            return Err(CliError::Usage(format!(
                "input {index} has no key origin; a signer would not know whether it can sign it"
            )));
        }
        // Exactly one utxo field. Never both: SeedCash's parse loop lets
        // whichever key appears last win, so a PSBT carrying the pair would be
        // correct or broken depending on map ordering.
        match input.previous_transaction.as_ref() {
            Some(parent) => record(&mut out, &[IN_NON_WITNESS_UTXO], parent),
            None => {
                let mut value = input.satoshis.to_le_bytes().to_vec();
                value.extend_from_slice(&compact_size(input.locking_bytecode.len() as u64));
                value.extend_from_slice(&input.locking_bytecode);
                record(&mut out, &[IN_WITNESS_UTXO], &value);
            }
        }
        record(
            &mut out,
            &[IN_SIGHASH_TYPE],
            &WATCH_ONLY_SIGHASH.to_le_bytes(),
        );
        if let Some(script) = input.redeem_script.as_ref() {
            record(&mut out, &[IN_REDEEM_SCRIPT], script);
        }
        for signature in &input.partial_signatures {
            let mut key = vec![IN_PARTIAL_SIG];
            key.extend_from_slice(&signature.pubkey);
            record(&mut out, &key, &signature.signature);
        }
        for origin in &input.derivations {
            let mut key = vec![IN_BIP32_DERIVATION];
            key.extend_from_slice(&origin.pubkey);
            record(
                &mut out,
                &key,
                &origin_value(origin.fingerprint, &origin.path),
            );
        }
        // v145 fields, for signers that read these instead of the embedded
        // unsigned transaction. Note the txid here is DISPLAY order, while the
        // same outpoint inside the unsigned transaction is wire order. That
        // asymmetry is deliberate and matches what readers expect; making the
        // two agree breaks one of them.
        record(&mut out, &[IN_PREVIOUS_TXID], &input.txid_display);
        record(&mut out, &[IN_OUTPUT_INDEX], &input.vout.to_le_bytes());
        record(
            &mut out,
            &[IN_SEQUENCE],
            &input.sequence.unwrap_or(0xffff_ffff).to_le_bytes(),
        );
        out.push(0x00);
    }

    // ---- one map per output ----
    for output in outputs {
        if let Some(script) = output.redeem_script.as_ref() {
            record(&mut out, &[OUT_REDEEM_SCRIPT], script);
        }
        for origin in &output.derivations {
            let mut key = vec![OUT_BIP32_DERIVATION];
            key.extend_from_slice(&origin.pubkey);
            record(
                &mut out,
                &key,
                &origin_value(origin.fingerprint, &origin.path),
            );
        }
        record(&mut out, &[OUT_AMOUNT], &output.satoshis.to_le_bytes());
        record(&mut out, &[OUT_SCRIPT], &output.locking_bytecode);
        if let Some(prefix) = output.token_prefix.as_ref() {
            record(&mut out, &[OUT_CASHTOKEN], prefix);
        }
        out.push(0x00);
    }

    Ok(out)
}

/// The transaction the signer is being asked to authorise.
///
/// Version 2, no unlocking scripts -- BIP174 requires the global unsigned
/// transaction to carry none -- and locktime 0.
fn unsigned_transaction(inputs: &[PsbtInputSpec], outputs: &[PsbtOutputSpec]) -> Vec<u8> {
    let mut tx = Vec::new();
    tx.extend_from_slice(&2u32.to_le_bytes());
    tx.extend_from_slice(&compact_size(inputs.len() as u64));
    for input in inputs {
        // Display order in, wire order out. This is the single place the
        // reversal happens; doing it again at the call site is what produced a
        // broadcast rejected with "Missing inputs" while every signature was
        // individually valid.
        let mut wire = input.txid_display;
        wire.reverse();
        tx.extend_from_slice(&wire);
        tx.extend_from_slice(&input.vout.to_le_bytes());
        tx.push(0x00); // empty unlocking script
        tx.extend_from_slice(&input.sequence.unwrap_or(0xffff_ffff).to_le_bytes());
    }
    tx.extend_from_slice(&compact_size(outputs.len() as u64));
    for output in outputs {
        tx.extend_from_slice(&output.satoshis.to_le_bytes());
        tx.extend_from_slice(&compact_size(output.locking_bytecode.len() as u64));
        tx.extend_from_slice(&output.locking_bytecode);
    }
    tx.extend_from_slice(&0u32.to_le_bytes()); // locktime
    tx
}

/// `<keylen><key><vallen><value>`, appended.
fn record(out: &mut Vec<u8>, key: &[u8], value: &[u8]) {
    out.extend_from_slice(&compact_size(key.len() as u64));
    out.extend_from_slice(key);
    out.extend_from_slice(&compact_size(value.len() as u64));
    out.extend_from_slice(value);
}

/// A fingerprint followed by the path, each step little-endian.
fn origin_value(fingerprint: [u8; 4], path: &[u32]) -> Vec<u8> {
    let mut value = fingerprint.to_vec();
    for step in path {
        value.extend_from_slice(&step.to_le_bytes());
    }
    value
}

fn compact_size(value: u64) -> Vec<u8> {
    match value {
        0..=0xfc => vec![value as u8],
        0xfd..=0xffff => {
            let mut out = vec![0xfd];
            out.extend_from_slice(&(value as u16).to_le_bytes());
            out
        }
        0x1_0000..=0xffff_ffff => {
            let mut out = vec![0xfe];
            out.extend_from_slice(&(value as u32).to_le_bytes());
            out
        }
        _ => {
            let mut out = vec![0xff];
            out.extend_from_slice(&value.to_le_bytes());
            out
        }
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

    fn origin(step: u32) -> KeyOrigin {
        KeyOrigin {
            pubkey: [0x02; 33],
            fingerprint: ABSENT_FINGERPRINT,
            path: vec![44 | 0x8000_0000, 145 | 0x8000_0000, 0x8000_0000, 0, step],
        }
    }

    fn spec_input() -> PsbtInputSpec {
        PsbtInputSpec {
            txid_display: [0xab; 32],
            vout: 1,
            sequence: None,
            satoshis: 100_000,
            locking_bytecode: vec![0x76, 0xa9, 0x14, 0x07, 0x88, 0xac],
            previous_transaction: None,
            redeem_script: None,
            partial_signatures: Vec::new(),
            derivations: vec![origin(0)],
        }
    }

    fn spec_output() -> PsbtOutputSpec {
        PsbtOutputSpec {
            satoshis: 90_000,
            locking_bytecode: vec![0x76, 0xa9, 0x14, 0x09, 0x88, 0xac],
            ..Default::default()
        }
    }

    #[test]
    fn what_the_encoder_writes_is_what_the_verifier_accepts() {
        // The two halves have to agree, and the only way to know they do is to
        // run one into the other rather than reason about the format twice.
        let raw = encode_unsigned(&[spec_input()], &[spec_output()], &[]).expect("encodes");
        let checked = check_watch_only(&raw, Network::Chipnet).expect("its own output passes");

        assert_eq!(checked.inputs.len(), 1);
        assert_eq!(checked.output_count, 1);
        assert_eq!(checked.inputs[0].sighash_type, Some(WATCH_ONLY_SIGHASH));
        assert_eq!(checked.inputs[0].origins, vec![origin(0)]);
        assert!(raw.starts_with(PSBT_MAGIC));
    }

    #[test]
    fn the_sighash_is_not_a_parameter_the_caller_can_get_wrong() {
        // The rule is stated once. A builder that could write anything else
        // would be a second place for it to be wrong, so the only sighash the
        // encoder can produce is the one the verifier accepts.
        let raw = encode_unsigned(&[spec_input()], &[spec_output()], &[]).expect("encodes");
        let parsed = parse(&raw).expect("parses");
        assert!(parsed
            .inputs
            .iter()
            .all(|input| input.sighash_type == Some(WATCH_ONLY_SIGHASH)));

        // And the rule itself refuses the two ways it is usually got wrong,
        // with different reasons because they fail differently.
        let no_forkid = check_sighash(0x01).expect_err("no FORKID bit");
        assert!(
            no_forkid.to_string().contains("SIGHASH_FORKID"),
            "{no_forkid}"
        );
        let fallback = check_sighash(SEEDCASH_FALLBACK_SIGHASH).expect_err("0x41");
        assert!(fallback.to_string().contains("0xc1"), "{fallback}");
        assert!(check_sighash(WATCH_ONLY_SIGHASH).is_ok());
    }

    #[test]
    fn the_outpoint_is_wire_order_in_the_transaction_and_display_order_in_the_field() {
        // Deliberate asymmetry. The embedded unsigned transaction carries the
        // outpoint the way a node reads it -- little-endian -- while the v145
        // PSBT_IN_PREVIOUS_TXID field carries display order, which is what its
        // readers expect. Reversing in both places is the bug that produced a
        // broadcast rejected with "Missing inputs" while every signature was
        // individually valid.
        let mut input = spec_input();
        input.txid_display = [0u8; 32];
        input.txid_display[0] = 0x01;
        input.txid_display[31] = 0xef;

        let raw = encode_unsigned(&[input.clone()], &[spec_output()], &[]).expect("encodes");
        let parsed = parse(&raw).expect("parses");

        // Inside the transaction: reversed, so the first wire byte is 0xef.
        let outpoint_at = 4 + 1; // version, then the input count
        assert_eq!(parsed.unsigned_tx[outpoint_at], 0xef);
        assert_eq!(parsed.unsigned_tx[outpoint_at + 31], 0x01);

        // In the v145 field: exactly as given.
        let mut needle = vec![0x01, IN_PREVIOUS_TXID, 32];
        needle.extend_from_slice(&input.txid_display);
        assert!(
            raw.windows(needle.len()).any(|w| w == needle),
            "PSBT_IN_PREVIOUS_TXID must carry display order"
        );
    }

    #[test]
    fn an_input_carries_one_utxo_field_and_never_both() {
        // SeedCash's parse loop lets whichever key appears last win, so a PSBT
        // carrying the pair is correct or broken depending on map ordering.
        // The whole parent transaction is preferred when it can be supplied:
        // SeedCash's witness-utxo handler keeps the script's compact-size
        // prefix and then re-prefixes it, so it signs over a script one byte
        // too long and every signature mismatches.
        let lean = encode_unsigned(&[spec_input()], &[spec_output()], &[]).expect("encodes");
        assert_eq!(
            parse(&lean).expect("parses").inputs[0].utxo,
            Some(UtxoField::Witness)
        );

        let mut with_parent = spec_input();
        with_parent.previous_transaction = Some(vec![0x02, 0x00, 0x00, 0x00, 0x00]);
        let full = encode_unsigned(&[with_parent], &[spec_output()], &[]).expect("encodes");
        assert_eq!(
            parse(&full).expect("parses").inputs[0].utxo,
            Some(UtxoField::NonWitness),
            "the whole parent transaction is preferred whenever it can be supplied"
        );

        // And a PSBT from elsewhere carrying both is refused rather than
        // resolved, because resolving it would mean picking the same one
        // SeedCash picks, which is whichever was written last.
        let both = with_both_utxo_fields();
        let error = parse(&both).expect_err("both must be refused");
        assert!(error.to_string().contains("both utxo forms"), "{error}");
    }

    /// A hand-built input map carrying the two utxo fields at once.
    fn with_both_utxo_fields() -> Vec<u8> {
        let mut out = PSBT_MAGIC.to_vec();
        out.extend_from_slice(&field(&[GLOBAL_UNSIGNED_TX], &unsigned_tx()));
        out.push(0x00);
        out.extend_from_slice(&field(&[IN_NON_WITNESS_UTXO], &[0x02, 0x00]));
        out.extend_from_slice(&field(&[IN_WITNESS_UTXO], &[0x00; 9]));
        out.extend_from_slice(&field(
            &[IN_SIGHASH_TYPE],
            &WATCH_ONLY_SIGHASH.to_le_bytes(),
        ));
        out.push(0x00);
        out.push(0x00);
        out
    }

    #[test]
    fn a_psbt_with_nothing_to_sign_is_refused_before_it_is_built() {
        assert!(encode_unsigned(&[], &[spec_output()], &[]).is_err());
        assert!(encode_unsigned(&[spec_input()], &[], &[]).is_err());

        // And an input nobody can sign is refused too: a signer that cannot
        // tell whether a key is its own has been handed a puzzle, not a
        // request.
        let mut orphan = spec_input();
        orphan.derivations.clear();
        let error = encode_unsigned(&[orphan], &[spec_output()], &[]).expect_err("no origin");
        assert!(error.to_string().contains("key origin"), "{error}");
    }

    #[test]
    fn change_and_multisig_fields_survive_the_round_trip() {
        // Change: an output derivation is how a device shows "change" instead
        // of treating the wallet's own address as an unknown third party.
        let mut change = spec_output();
        change.derivations = vec![origin(1)];
        change.redeem_script = Some(vec![0x51, 0x52, 0xae]);

        // Multisig: a redeem script and the signatures gathered so far.
        let mut cosigned = spec_input();
        cosigned.redeem_script = Some(vec![0x52, 0x21, 0xae]);
        cosigned.partial_signatures = vec![PartialSignature {
            pubkey: [0x03; 33],
            signature: vec![0x30, 0x44, 0x02],
        }];
        cosigned.derivations = vec![origin(0), origin(7)];

        let raw = encode_unsigned(&[cosigned], &[change], &[]).expect("encodes");
        let parsed = check_watch_only(&raw, Network::Chipnet).expect("still conforms");
        assert_eq!(
            parsed.inputs[0].origins,
            vec![origin(0), origin(7)],
            "both cosigners' origins survive"
        );
        // The redeem script is a single-byte key, so it can be found exactly.
        assert!(
            raw.windows(3).any(|w| w == [0x01, IN_REDEEM_SCRIPT, 0x03]),
            "the redeem script travels with the input"
        );
        assert_eq!(parsed.output_count, 1);
    }

    #[test]
    fn the_global_map_carries_what_each_reader_needs() {
        // Paytaca's reader requires the version field; SeedCash skips it. The
        // explicit counts are what SeedCash parses section boundaries by.
        let xpub = GlobalXpub {
            xpub_payload: vec![0x04; 78],
            fingerprint: [0x0f, 0x1e, 0x2d, 0x3c],
            path: vec![44 | 0x8000_0000],
        };
        let raw = encode_unsigned(&[spec_input()], &[spec_output()], &[xpub]).expect("encodes");

        assert!(raw.windows(2).any(|w| w == [0x01, GLOBAL_VERSION]));
        assert!(raw.windows(2).any(|w| w == [0x01, GLOBAL_INPUT_COUNT]));
        assert!(raw.windows(2).any(|w| w == [0x01, GLOBAL_OUTPUT_COUNT]));
        // A 79-byte key: the type byte plus the 78-byte payload.
        assert!(raw.windows(2).any(|w| w == [79, GLOBAL_XPUB]));

        // A payload of the wrong length is refused rather than written.
        let wrong = GlobalXpub {
            xpub_payload: vec![0x04; 77],
            fingerprint: ABSENT_FINGERPRINT,
            path: Vec::new(),
        };
        assert!(encode_unsigned(&[spec_input()], &[spec_output()], &[wrong]).is_err());
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

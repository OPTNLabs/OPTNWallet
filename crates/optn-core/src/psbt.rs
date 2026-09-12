//! The air-gapped signing envelope, and the rules that make it safe.
//!
//! A watch-only wallet builds a transaction it cannot sign, shows it as an
//! animated QR, and a device with the keys signs it offline. Nothing in that
//! loop can ask a question: by the time anything is wrong, the device has been
//! put away. So the rules live here, next to the parser that can check them.
//!
//! **Every input must carry `PSBT_IN_SIGHASH_TYPE`, and every input must carry
//! the same one.** The value is a choice among six, and `0x41`
//! (`ALL | FORKID`) is the default because that is what SeedCash signs with.
//! An absent field is refused: SeedCash would fall back to `0x41` and produce a
//! signature that happens to be right, but the user would have approved nothing
//! in particular, and a signed PSBT coming back is checked against the
//! commitment they *did* approve. Silence is not a commitment.
//!
//! The advanced modes commit to fewer fields of the transaction, which is
//! occasionally what an informed user wants and never what a default should
//! do.
//!
//! **Mainnet is refused by envelope validation and finalization.** The air-gap path
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

/// `SIGHASH_ALL | SIGHASH_FORKID`.
///
/// The default, and what SeedCash signs with. An air-gapped send uses this
/// unless the user deliberately chose otherwise.
pub const SIGHASH_ALL_FORKID: u32 = 0x41;
/// `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY`.
pub const SIGHASH_ALL_FORKID_ANYONECANPAY: u32 = 0xc1;

/// The sighash an air-gapped send uses when nobody chose one.
pub const WATCH_ONLY_SIGHASH: u32 = SIGHASH_ALL_FORKID;

/// Every sighash this wallet will hand to an air-gapped signer.
///
/// Three base types, each with and without `ANYONECANPAY`, and `FORKID` set
/// throughout because Bitcoin Cash requires it. The first is the default; the
/// rest commit to fewer fields of the transaction and exist for someone who
/// knows why they want that.
pub const SUPPORTED_SIGHASHES: &[u32] = &[
    SIGHASH_ALL_FORKID,
    0x42, // NONE | FORKID
    0x43, // SINGLE | FORKID
    SIGHASH_ALL_FORKID_ANYONECANPAY,
    0xc2, // NONE | FORKID | ANYONECANPAY
    0xc3, // SINGLE | FORKID | ANYONECANPAY
];

/// A human name for one of the supported sighashes.
pub fn sighash_label(value: u32) -> Option<&'static str> {
    match value {
        0x41 => Some("All (recommended)"),
        0x42 => Some("None"),
        0x43 => Some("Single"),
        0xc1 => Some("All + Anyone Can Pay"),
        0xc2 => Some("None + Anyone Can Pay"),
        0xc3 => Some("Single + Anyone Can Pay"),
        _ => None,
    }
}

/// Whether this sighash commits to fewer fields than the default.
///
/// What a warning beside the control has to be driven by, rather than a screen
/// deciding for itself which of six values is the safe one.
pub fn sighash_is_advanced(value: u32) -> bool {
    SUPPORTED_SIGHASHES.contains(&value) && value != SIGHASH_ALL_FORKID
}

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
    /// UR fragment size, in bytes. The default: easiest to scan, most frames.
    pub const CHUNK_SIZE: usize = 50;
    /// Quiet-zone padding, in modules.
    pub const PADDING: u32 = 8;
    /// Rendered size, in pixels.
    pub const PIXELS: u32 = 640;
    /// Error-correction level. Low, because density is the binding constraint.
    pub const ERROR_CORRECTION: char = 'L';

    /// The fragment sizes a user may pick between on a full-size screen.
    ///
    /// A trade the device makes, not one this wallet can make for it: a denser
    /// QR is fewer frames and a shorter wait, but some cameras cannot read it,
    /// and the failure looks like a camera that simply will not focus.
    ///
    /// A phone gets [`MOBILE_FRAGMENT_OPTIONS`] instead -- a shorter, lower
    /// list. The two are deliberately different rather than one being right:
    /// this set is what the air-gap work settled on for a desktop, and the
    /// mobile set is Paytaca's, measured against a fleet of phones we do not
    /// have.
    pub const FRAGMENT_OPTIONS: &'static [usize] = &[50, 100, 200, 400, 450];

    /// What to call a fragment size on screen.
    pub fn fragment_label(fragment: usize) -> Option<&'static str> {
        match fragment {
            50 => Some("Easiest to scan (more frames)"),
            100 => Some("Balanced"),
            200 => Some("High density (fewer frames)"),
            400 => Some("Highest density (fewest frames)"),
            450 => Some("Maximum density (fewest frames)"),
            _ => None,
        }
    }
}

/// How fast the animated QR advances, in milliseconds per frame.
///
/// Paytaca's values, adopted whole because they were measured against a real
/// fleet of phones and we have no data of our own. Slower is not worse: a
/// camera that cannot keep up drops frames and the transfer stalls at 60%,
/// which reads to the user as the wallet being broken rather than as the
/// animation being too quick.
///
/// This is the one setting here that does **not** change a byte. The frames
/// are identical whatever the speed; only how long each is on screen changes.
pub struct QrAnimation;

impl QrAnimation {
    pub const SLOW: u32 = 450;
    pub const NORMAL: u32 = 300;
    pub const FAST: u32 = 100;

    /// Offered slowest first, as the control reads left to right.
    pub const OPTIONS: &'static [u32] = &[Self::SLOW, Self::NORMAL, Self::FAST];

    /// The default. Middle of the range, per Paytaca's own default.
    pub const DEFAULT: u32 = Self::NORMAL;

    pub fn label(interval_ms: u32) -> Option<&'static str> {
        match interval_ms {
            Self::SLOW => Some("Slow"),
            Self::NORMAL => Some("Normal"),
            Self::FAST => Some("Fast"),
            _ => None,
        }
    }
}

/// The fragment sizes Paytaca offers on a phone.
///
/// Fewer and lower than the desktop set, and that is the point: a phone fleet
/// is thousands of different cameras, and the ones that fail are not the ones
/// anyone testing owns. Paytaca's note was that they expect to adjust the
/// *minimum* values for low-end devices, so treating this list as settled
/// would be a mistake -- it is their current best answer, not a constant.
pub const MOBILE_FRAGMENT_OPTIONS: &[usize] = &[50, 150, 250];

/// What to call a mobile fragment size.
///
/// Three plain words rather than the desktop set's descriptions, because the
/// control is a row of labels on a small screen.
pub fn mobile_fragment_label(fragment: usize) -> Option<&'static str> {
    match fragment {
        50 => Some("Low"),
        150 => Some("Medium"),
        250 => Some("High"),
        _ => None,
    }
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
    Ok(parse_maps(raw)?.psbt)
}

type Fields = Vec<(Vec<u8>, Vec<u8>)>;

struct ParsedMaps {
    psbt: Psbt,
    global: Fields,
    inputs: Vec<Fields>,
    outputs: Vec<Fields>,
}

fn parse_maps(raw: &[u8]) -> Result<ParsedMaps> {
    if raw.len() < PSBT_MAGIC.len() || &raw[..PSBT_MAGIC.len()] != PSBT_MAGIC {
        return Err(CliError::Protocol(
            "not a PSBT: the magic bytes are missing".into(),
        ));
    }
    let mut cursor = Cursor::new(raw, PSBT_MAGIC.len());

    let global = cursor.read_map(&[
        GLOBAL_UNSIGNED_TX,
        GLOBAL_VERSION,
        GLOBAL_INPUT_COUNT,
        GLOBAL_OUTPUT_COUNT,
    ])?;
    let unsigned_tx = global
        .iter()
        .find(|(key, _)| key.as_slice() == [GLOBAL_UNSIGNED_TX])
        .map(|(_, value)| value.clone())
        .ok_or_else(|| CliError::Protocol("PSBT has no unsigned transaction".into()))?;

    let (tx_inputs, tx_outputs) = parse_transaction(&unsigned_tx)?;
    if tx_inputs
        .iter()
        .any(|(_, _, script_sig)| !script_sig.is_empty())
    {
        return Err(CliError::Protocol(
            "PSBT unsigned transaction contains a scriptSig".into(),
        ));
    }
    for (kind, expected) in [
        (GLOBAL_INPUT_COUNT, tx_inputs.len()),
        (GLOBAL_OUTPUT_COUNT, tx_outputs.len()),
    ] {
        if let Some((_, value)) = global.iter().find(|(key, _)| key.as_slice() == [kind]) {
            let mut count = Cursor::new(value, 0);
            if count.compact_size()? != expected as u64 || count.at != value.len() {
                return Err(CliError::Protocol(
                    "PSBT count disagrees with its unsigned transaction".into(),
                ));
            }
        }
    }

    let mut inputs = Vec::with_capacity(tx_inputs.len());
    let mut input_maps = Vec::with_capacity(tx_inputs.len());
    for index in 0..tx_inputs.len() {
        let fields = cursor
            .read_map(&[
                IN_NON_WITNESS_UTXO,
                IN_WITNESS_UTXO,
                IN_SIGHASH_TYPE,
                IN_REDEEM_SCRIPT,
                0x05,
                0x07,
                0x08, // witness script and final scripts
                IN_PREVIOUS_TXID,
                IN_OUTPUT_INDEX,
                IN_SEQUENCE,
            ])
            .map_err(|error| CliError::Protocol(format!("input {index}: {error}")))?;
        inputs.push(input_from_fields(index, &fields)?);
        input_maps.push(fields);
    }
    let mut outputs = Vec::with_capacity(tx_outputs.len());
    for index in 0..tx_outputs.len() {
        let fields = cursor
            .read_map(&[
                OUT_REDEEM_SCRIPT,
                0x01,
                OUT_AMOUNT,
                OUT_SCRIPT,
                OUT_CASHTOKEN,
            ])
            .map_err(|error| CliError::Protocol(format!("output {index}: {error}")))?;
        outputs.push(fields);
    }
    if cursor.at != raw.len() {
        return Err(CliError::Protocol(
            "PSBT contains trailing maps or bytes".into(),
        ));
    }

    Ok(ParsedMaps {
        psbt: Psbt {
            unsigned_tx,
            inputs,
            output_count: tx_outputs.len(),
        },
        global,
        inputs: input_maps,
        outputs,
    })
}

/// Finalize a signed return against the exact PSBT approved by the caller.
///
/// Initial SeedCash scope: Chipnet, token-free P2PKH, SIGHASH_ALL|FORKID,
/// complete non-witness parent transactions, and one partial signature per
/// input. Signers must retain all metadata; map order may change. No finalized
/// script from the signer is trusted. The result is raw transaction bytes,
/// not a broadcast or a claim that the committed prevouts remain unspent.
pub fn finalize_p2pkh(
    original_psbt: &[u8],
    signed_psbt: &[u8],
    network: Network,
) -> Result<Vec<u8>> {
    use crate::tx::{self, Output, Transaction, Utxo};

    if network != Network::Chipnet {
        return Err(CliError::Usage("PSBT finalization is chipnet-only".into()));
    }
    let original = parse_maps(original_psbt)?;
    let signed = parse_maps(signed_psbt)?;
    let invalid =
        || CliError::Protocol("signed PSBT does not retain the approved P2PKH intent".into());
    if original.psbt.unsigned_tx != signed.psbt.unsigned_tx
        || !same_fields(&original.global, &signed.global, false)
        || original.inputs.len() != signed.inputs.len()
        || original.outputs.len() != signed.outputs.len()
        || original
            .outputs
            .iter()
            .zip(&signed.outputs)
            .any(|(a, b)| !same_fields(a, b, false))
    {
        return Err(invalid());
    }
    let decoded = tx::decode(&original.psbt.unsigned_tx)?;
    if decoded.inputs.is_empty() || decoded.outputs.is_empty() {
        return Err(invalid());
    }
    // The v145 fields displayed by a signer must agree with the embedded tx.
    for (fields, output) in original.outputs.iter().zip(&decoded.outputs) {
        if output.token.is_some()
            || fields
                .iter()
                .any(|(key, _)| matches!(key[0], OUT_REDEEM_SCRIPT | 0x01 | OUT_CASHTOKEN))
            || field_value(fields, OUT_AMOUNT).is_some_and(|v| v != output.value.to_le_bytes())
            || field_value(fields, OUT_SCRIPT).is_some_and(|v| v != output.script_pubkey)
        {
            return Err(invalid());
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut inputs = Vec::with_capacity(decoded.inputs.len());
    let mut signatures = Vec::with_capacity(decoded.inputs.len());
    for (index, ((txid, vout, sequence), fields)) in
        decoded.inputs.iter().zip(&original.inputs).enumerate()
    {
        let returned = &signed.inputs[index];
        let metadata = &original.psbt.inputs[index];
        if !seen.insert((*txid, *vout))
            || !same_fields(fields, returned, true)
            || metadata.sighash_type != Some(SIGHASH_ALL_FORKID)
            || metadata.origins.len() != 1
            || fields.iter().any(|(key, _)| {
                matches!(
                    key[0],
                    IN_PARTIAL_SIG | IN_WITNESS_UTXO | IN_REDEEM_SCRIPT | 0x05 | 0x07 | 0x08
                )
            })
        {
            return Err(invalid());
        }
        let mut display_txid = *txid;
        display_txid.reverse();
        if field_value(fields, IN_PREVIOUS_TXID).is_some_and(|v| v != display_txid)
            || field_value(fields, IN_OUTPUT_INDEX).is_some_and(|v| v != vout.to_le_bytes())
            || field_value(fields, IN_SEQUENCE).is_some_and(|v| v != sequence.to_le_bytes())
        {
            return Err(invalid());
        }
        let parent = field_value(fields, IN_NON_WITNESS_UTXO).ok_or_else(invalid)?;
        if tx::double_sha256(parent) != *txid {
            return Err(invalid());
        }
        let parent = tx::decode(parent)?;
        let prevout = parent.outputs.get(*vout as usize).ok_or_else(invalid)?;
        let origin = &metadata.origins[0];
        let script = &prevout.script_pubkey;
        if prevout.token.is_some()
            || script.len() != 25
            || script[..3] != [0x76, 0xa9, 0x14]
            || script[23..] != [0x88, 0xac]
            || script[3..23] != crate::hd::hash160(&origin.pubkey)
        {
            return Err(invalid());
        }
        let mut partials = returned.iter().filter(|(key, _)| key[0] == IN_PARTIAL_SIG);
        let (key, signature) = partials.next().ok_or_else(invalid)?;
        if partials.next().is_some() || key[1..] != origin.pubkey {
            return Err(invalid());
        }
        inputs.push(Utxo {
            txid: *txid,
            vout: *vout,
            value: prevout.value,
            script_pubkey: script.clone(),
        });
        signatures.push((&origin.pubkey, signature));
    }
    // Refuse inflation/overflow independently of signature validity.
    let input_value = inputs
        .iter()
        .try_fold(0u64, |sum, input| sum.checked_add(input.value))
        .ok_or_else(invalid)?;
    let output_value = decoded
        .outputs
        .iter()
        .try_fold(0u64, |sum, output| sum.checked_add(output.value))
        .ok_or_else(invalid)?;
    if output_value > input_value {
        return Err(invalid());
    }
    let sequences: Vec<_> = decoded.inputs.iter().map(|input| input.2).collect();
    let transaction = Transaction {
        version: decoded.version,
        inputs,
        outputs: decoded
            .outputs
            .into_iter()
            .map(|output| Output::new(output.value, output.script_pubkey))
            .collect(),
        locktime: decoded.locktime,
        sequence: 0xffff_ffff,
    };
    let scripts = signatures
        .iter()
        .enumerate()
        .map(|(index, (key, signature))| {
            let digest =
                tx::double_sha256(&transaction.sighash_preimage_with_sequences(index, &sequences)?);
            tx::verified_p2pkh_script_sig(key.as_slice(), signature, &digest)
        })
        .collect::<Result<Vec<_>>>()?;
    transaction.serialize_with_sequences(&scripts, &sequences)
}

fn field_value(fields: &Fields, kind: u8) -> Option<&[u8]> {
    fields
        .iter()
        .find(|(key, _)| key.as_slice() == [kind])
        .map(|(_, value)| value.as_slice())
}

fn same_fields(original: &Fields, returned: &Fields, allow_signatures: bool) -> bool {
    let retained: std::collections::BTreeMap<_, _> = returned
        .iter()
        .filter(|(key, _)| !allow_signatures || key[0] != IN_PARTIAL_SIG)
        .map(|(key, value)| (key, value))
        .collect();
    retained.len() == original.len()
        && original
            .iter()
            .all(|(key, value)| retained.get(key) == Some(&value))
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
    if value.len() < 4 || !(value.len() - 4).is_multiple_of(4) {
        return Err(CliError::Protocol(format!(
            "input {index}: a derivation record is a 4-byte fingerprint then whole path steps, \
             got {} bytes",
            value.len()
        )));
    }
    let mut fingerprint = [0u8; 4];
    fingerprint.copy_from_slice(&value[..4]);
    let path = value[4..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|step| u32::from_le_bytes(*step))
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
    let mut agreed: Option<u32> = None;
    for (index, input) in psbt.inputs.iter().enumerate() {
        let Some(sighash) = input.sighash_type else {
            return Err(CliError::Protocol(format!(
                "input {index} carries no sighash type. SeedCash would fall back to 0x41, so the \
                 signature might well be right -- but the user would have approved nothing in \
                 particular, and a signature coming back is checked against what they approved"
            )));
        };
        check_sighash(sighash)
            .map_err(|error| CliError::Protocol(format!("input {index}: {error}")))?;
        match agreed {
            None => agreed = Some(sighash),
            // One commitment per transaction. Inputs signed under different
            // sighashes commit to different pictures of the same transaction,
            // and no single approval covers that.
            Some(first) if first != sighash => {
                return Err(CliError::Protocol(format!(
                    "input {index} asks for sighash {sighash:#04x} while input 0 asks for \
                     {first:#04x}; every input commits to the same one"
                )))
            }
            Some(_) => {}
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
    fn read_map(&mut self, singleton_types: &[u8]) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let mut fields = Vec::new();
        let mut keys = std::collections::BTreeSet::new();
        loop {
            let key = self.record_bytes()?;
            if key.is_empty() {
                return Ok(fields);
            }
            // BIP174 requires a canonical type and a unique complete key per map.
            Cursor::new(key, 0).compact_size()?;
            if key.len() != 1 && singleton_types.contains(&key[0]) {
                return Err(CliError::Protocol(
                    "PSBT singleton key contains key data".into(),
                ));
            }
            if !keys.insert(key) {
                return Err(CliError::Protocol(
                    "PSBT map contains a duplicate key".into(),
                ));
            }
            let value = self.record_bytes()?;
            fields.push((key.to_vec(), value.to_vec()));
        }
    }

    fn record_bytes(&mut self) -> Result<&'a [u8]> {
        let len = usize::try_from(self.compact_size()?)
            .map_err(|_| CliError::Protocol("PSBT record length exceeds this platform".into()))?;
        self.take(len)
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
    fn compact_size(&mut self) -> Result<u64> {
        let first = *self
            .take(1)?
            .first()
            .ok_or_else(|| CliError::Protocol("PSBT ends where a length was expected".into()))?;
        let width = match first {
            0..=0xfc => return Ok(u64::from(first)),
            0xfd => 2,
            0xfe => 4,
            _ => 8,
        };
        let bytes = self.take(width)?;
        let mut buf = [0u8; 8];
        buf[..width].copy_from_slice(bytes);
        let value = u64::from_le_bytes(buf);
        let minimum = match width {
            2 => 0xfd,
            4 => 0x1_0000,
            _ => 0x1_0000_0000,
        };
        if value < minimum {
            return Err(CliError::Protocol(
                "PSBT has a non-minimal CompactSize".into(),
            ));
        }
        Ok(value)
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
/// signature is not valid on Bitcoin Cash at all, and the failure appears at
/// broadcast — after the user has already walked the transaction through a
/// device and put it away. A flag combination outside the supported six is
/// something no signer here has agreed to produce.
pub fn check_sighash(value: u32) -> Result<()> {
    if value & SIGHASH_FORKID_BIT == 0 {
        return Err(CliError::Usage(format!(
            "sighash {value:#04x} has no SIGHASH_FORKID bit; a BCH signature without it is \
             rejected at broadcast, long after the device has signed"
        )));
    }
    if !SUPPORTED_SIGHASHES.contains(&value) {
        return Err(CliError::Usage(format!(
            "{value:#04x} is not a supported BCH sighash; this wallet signs with one of {}",
            SUPPORTED_SIGHASHES
                .iter()
                .map(|value| format!("{value:#04x}"))
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(())
}

/// Build the PSBT an air-gapped signer is shown, with the default sighash.
///
/// The overwhelmingly common case, and the one a caller should reach for
/// without thinking about it.
pub fn encode_unsigned(
    inputs: &[PsbtInputSpec],
    outputs: &[PsbtOutputSpec],
    global_xpubs: &[GlobalXpub],
) -> Result<Vec<u8>> {
    encode_unsigned_with_sighash(inputs, outputs, global_xpubs, WATCH_ONLY_SIGHASH)
}

/// The same, with a sighash the user deliberately chose.
///
/// Validated here rather than trusted, so a screen offering the choice cannot
/// widen the set by passing something else through.
pub fn encode_unsigned_with_sighash(
    inputs: &[PsbtInputSpec],
    outputs: &[PsbtOutputSpec],
    global_xpubs: &[GlobalXpub],
    sighash: u32,
) -> Result<Vec<u8>> {
    if inputs.is_empty() {
        return Err(CliError::Usage("a PSBT needs at least one input".into()));
    }
    if outputs.is_empty() {
        return Err(CliError::Usage("a PSBT needs at least one output".into()));
    }
    check_sighash(sighash)?;

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
        // The same on every input: a signer commits to one, and a signature
        // coming back is checked against the one the user approved.
        record(&mut out, &[IN_SIGHASH_TYPE], &sighash.to_le_bytes());
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

    // Apply the same envelope rules to caller-supplied origins and signatures.
    parse(&out)?;
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

/// Bitcoin's CompactSize length prefix.
///
/// Shared with `multisig`, which needs it for the legacy signed-message
/// preimage BSMS key records are signed over. One encoder, because two would
/// eventually disagree about the 0xfd boundary and produce signatures that
/// verify nowhere.
pub(crate) fn compact_size(value: u64) -> Vec<u8> {
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
    fn ambiguous_psbt_maps_are_rejected_before_approval() {
        let valid = psbt_with_sighash(Some(WATCH_ONLY_SIGHASH));
        let global_end = PSBT_MAGIC.len() + field(&[GLOBAL_UNSIGNED_TX], &unsigned_tx()).len();
        let input_end = valid.len() - 2;
        for (at, record) in [
            (global_end, field(&[GLOBAL_UNSIGNED_TX], &unsigned_tx())),
            (global_end, field(&[GLOBAL_UNSIGNED_TX, 1], &unsigned_tx())),
            (input_end, field(&[IN_SIGHASH_TYPE], &0x41u32.to_le_bytes())),
            (
                input_end,
                field(&[IN_SIGHASH_TYPE, 1], &0x41u32.to_le_bytes()),
            ),
            (input_end, field(&[IN_NON_WITNESS_UTXO, 1], &[])),
            (
                valid.len() - 1,
                field(&[OUT_AMOUNT, 1], &50_000u64.to_le_bytes()),
            ),
            (valid.len(), vec![0]),
        ] {
            let mut malformed = valid.clone();
            malformed.splice(at..at, record);
            assert!(
                check_watch_only(&malformed, Network::Chipnet).is_err(),
                "offset {at}"
            );
        }

        // Unknown extensions remain accepted, but their complete keys must be unique
        // in each map. The same key in different maps is valid.
        for at in [global_end, input_end, valid.len() - 1] {
            let mut extended = valid.clone();
            extended.splice(at..at, field(&[0x80, 1], &[1]));
            assert!(parse(&extended).is_ok());
            extended.splice(at..at, field(&[0x80, 1], &[2]));
            assert!(parse(&extended).is_err());
        }
        let mut extended = valid.clone();
        for at in [valid.len() - 1, input_end, global_end] {
            extended.splice(at..at, field(&[0x80, 1], &[1]));
        }
        assert!(parse(&extended).is_ok());

        for key in [vec![0xfd], vec![0xfd, 0x80, 0], vec![0xfe, 0x80, 0, 0, 0]] {
            let mut malformed = valid.clone();
            malformed.splice(global_end..global_end, field(&key, &[]));
            assert!(parse(&malformed).is_err());
        }
        // A canonical unknown 64-bit type is valid on native and WASM alike.
        let mut extended = valid.clone();
        extended.splice(global_end..global_end, field(&[0xff; 9], &[]));
        assert!(parse(&extended).is_ok());

        let mut duplicate_origin = spec_input();
        duplicate_origin
            .derivations
            .push(duplicate_origin.derivations[0].clone());
        assert!(encode_unsigned(&[duplicate_origin], &[spec_output()], &[]).is_err());

        for kind in [GLOBAL_INPUT_COUNT, GLOBAL_OUTPUT_COUNT] {
            for count in [vec![0], vec![2], vec![1, 0], vec![0xfd, 1, 0]] {
                let mut malformed = valid.clone();
                malformed.splice(global_end..global_end, field(&[kind], &count));
                assert!(parse(&malformed).is_err());
            }
            let mut explicit_count = valid.clone();
            explicit_count.splice(global_end..global_end, field(&[kind], &[1]));
            assert!(parse(&explicit_count).is_ok());
        }
        let mut signed_tx = unsigned_tx();
        signed_tx.splice(41..42, [1, 0x51]);
        let mut malformed = valid.clone();
        malformed.splice(
            PSBT_MAGIC.len()..global_end,
            field(&[GLOBAL_UNSIGNED_TX], &signed_tx),
        );
        assert!(parse(&malformed).is_err());

        // All three extended CompactSize widths must reject non-minimal lengths.
        for prefix in [0xfd, 0xfe, 0xff] {
            let width = match prefix {
                0xfd => 2,
                0xfe => 4,
                _ => 8,
            };
            for at in [PSBT_MAGIC.len(), PSBT_MAGIC.len() + 2, global_end] {
                let mut malformed = valid.clone();
                let mut length = vec![prefix, valid[at]];
                length.resize(width + 1, 0);
                malformed.splice(at..at + 1, length);
                assert!(parse(&malformed).is_err(), "non-minimal length at {at}");
            }
        }
    }

    #[test]
    fn explicit_air_gap_sighashes_default_to_all_forkid() {
        // The rule this module exists for. A wrong sighash is not caught by the
        // device, or by this wallet at signing time -- only by the network, at
        // broadcast, long after the device has been put away.
        // Six are supported: three base types, each with and without
        // ANYONECANPAY, FORKID throughout because Bitcoin Cash requires it.
        for supported in SUPPORTED_SIGHASHES {
            let ok = check_watch_only(&psbt_with_sighash(Some(*supported)), Network::Chipnet)
                .unwrap_or_else(|error| panic!("{supported:#04x} is supported: {error}"));
            assert_eq!(ok.inputs[0].sighash_type, Some(*supported));
            assert!(sighash_label(*supported).is_some());
        }

        // The default is the one SeedCash signs with, and it is the only one
        // that is not an advanced choice.
        assert_eq!(WATCH_ONLY_SIGHASH, SIGHASH_ALL_FORKID);
        assert_eq!(WATCH_ONLY_SIGHASH, 0x41);
        assert!(!sighash_is_advanced(SIGHASH_ALL_FORKID));
        for advanced in [0x42, 0x43, 0xc1, 0xc2, 0xc3] {
            assert!(sighash_is_advanced(advanced), "{advanced:#04x}");
        }

        // A flag combination outside the six is refused. 0x61 sets a bit that
        // means nothing, which is exactly how a plausible-looking sighash gets
        // through a hand-written check.
        let odd = check_watch_only(&psbt_with_sighash(Some(0x61)), Network::Chipnet)
            .expect_err("0x61 is not one of them");
        assert!(
            odd.to_string().contains("not a supported BCH sighash"),
            "{odd}"
        );
        assert!(
            !sighash_is_advanced(0x61),
            "unsupported is not merely advanced"
        );
    }

    #[test]
    fn every_input_commits_to_the_same_sighash() {
        // Inputs signed under different sighashes commit to different pictures
        // of the same transaction, and no single approval covers that.
        let mut out = PSBT_MAGIC.to_vec();
        let tx = {
            // Two inputs, one output.
            let mut tx = Vec::new();
            tx.extend_from_slice(&2u32.to_le_bytes());
            tx.push(2);
            for vout in 0..2u32 {
                tx.extend_from_slice(&[9u8; 32]);
                tx.extend_from_slice(&vout.to_le_bytes());
                tx.push(0);
                tx.extend_from_slice(&0xffff_fffeu32.to_le_bytes());
            }
            tx.push(1);
            tx.extend_from_slice(&50_000u64.to_le_bytes());
            tx.push(1);
            tx.push(0x51);
            tx.extend_from_slice(&0u32.to_le_bytes());
            tx
        };
        out.extend_from_slice(&field(&[GLOBAL_UNSIGNED_TX], &tx));
        out.push(0x00);
        for sighash in [SIGHASH_ALL_FORKID, SIGHASH_ALL_FORKID_ANYONECANPAY] {
            out.extend_from_slice(&field(&[IN_SIGHASH_TYPE], &sighash.to_le_bytes()));
            out.push(0x00);
        }
        out.push(0x00);

        let error = check_watch_only(&out, Network::Chipnet).expect_err("mixed must be refused");
        assert!(error.to_string().contains("every input commits"), "{error}");
    }

    #[test]
    fn an_absent_sighash_field_is_refused_because_silence_is_the_dangerous_case() {
        // SeedCash falls back to 0x41, so the signature might well come back
        // correct -- but the user would have approved nothing in particular,
        // and a returning signature is checked against what they approved.
        let error = check_watch_only(&psbt_with_sighash(None), Network::Chipnet)
            .expect_err("a missing field must not pass");
        let message = error.to_string();
        assert!(message.contains("no sighash type"), "{message}");
        assert!(
            message.contains("approved"),
            "the reason is the commitment, not the value: {message}"
        );
    }

    #[test]
    fn watch_only_envelope_validation_refuses_mainnet() {
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
    fn unsigned_encoder_defaults_to_all_forkid_and_validates_explicit_choices() {
        // The rule is stated once. A builder that could write anything else
        // would be a second place for it to be wrong, so the only sighash the
        // encoder can produce is the one the verifier accepts.
        let raw = encode_unsigned(&[spec_input()], &[spec_output()], &[]).expect("encodes");
        let parsed = parse(&raw).expect("parses");
        assert!(parsed
            .inputs
            .iter()
            .all(|input| input.sighash_type == Some(WATCH_ONLY_SIGHASH)));

        // A caller may choose, and the choice is validated here rather than by
        // the screen offering it -- so a screen cannot widen the set by passing
        // something else through.
        let chosen = encode_unsigned_with_sighash(
            &[spec_input()],
            &[spec_output()],
            &[],
            SIGHASH_ALL_FORKID_ANYONECANPAY,
        )
        .expect("a supported choice");
        assert_eq!(
            parse(&chosen).expect("parses").inputs[0].sighash_type,
            Some(SIGHASH_ALL_FORKID_ANYONECANPAY)
        );
        assert!(
            encode_unsigned_with_sighash(&[spec_input()], &[spec_output()], &[], 0x61).is_err(),
            "an unsupported one is refused before any bytes are written"
        );

        // And the two ways it is usually got wrong fail differently, so the
        // reasons say different things.
        let no_forkid = check_sighash(0x01).expect_err("no FORKID bit");
        assert!(
            no_forkid.to_string().contains("SIGHASH_FORKID"),
            "{no_forkid}"
        );
        let unsupported = check_sighash(0x61).expect_err("a stray bit");
        assert!(
            unsupported
                .to_string()
                .contains("not a supported BCH sighash"),
            "{unsupported}"
        );
        for supported in SUPPORTED_SIGHASHES {
            assert!(check_sighash(*supported).is_ok(), "{supported:#04x}");
        }
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
        let mut other_cosigner = origin(7);
        other_cosigner.pubkey = [0x03; 33];
        cosigned.derivations = vec![origin(0), other_cosigner.clone()];

        let raw = encode_unsigned(&[cosigned], &[change], &[]).expect("encodes");
        let parsed = check_watch_only(&raw, Network::Chipnet).expect("still conforms");
        assert_eq!(
            parsed.inputs[0].origins,
            vec![origin(0), other_cosigner],
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
    fn a_phone_is_offered_a_shorter_lower_list_than_a_desktop() {
        // Not because one list is right. A phone fleet is thousands of
        // cameras, and the ones that fail are not the ones anyone testing
        // owns, so the mobile set is Paytaca's -- measured against a fleet we
        // do not have.
        assert_eq!(MOBILE_FRAGMENT_OPTIONS, &[50, 150, 250]);
        assert!(MOBILE_FRAGMENT_OPTIONS.len() < SeedCashQr::FRAGMENT_OPTIONS.len());

        let mobile_max = MOBILE_FRAGMENT_OPTIONS.iter().max().expect("some");
        let desktop_max = SeedCashQr::FRAGMENT_OPTIONS.iter().max().expect("some");
        assert!(
            mobile_max < desktop_max,
            "a phone is not asked to read the densest code"
        );

        // Both start at the same floor: the size a SeedCash camera was
        // actually observed to read.
        assert_eq!(MOBILE_FRAGMENT_OPTIONS[0], SeedCashQr::FRAGMENT_OPTIONS[0]);
        assert_eq!(MOBILE_FRAGMENT_OPTIONS[0], SeedCashQr::CHUNK_SIZE);

        // Every option a control shows needs a word to put on it.
        for fragment in MOBILE_FRAGMENT_OPTIONS {
            assert!(mobile_fragment_label(*fragment).is_some(), "{fragment}");
        }
        assert_eq!(
            mobile_fragment_label(400),
            None,
            "a desktop size is not offered"
        );
    }

    #[test]
    fn animation_speed_changes_nothing_about_the_bytes() {
        // The one setting here that is purely presentational: the frames are
        // identical whatever the speed, and only their time on screen changes.
        // Worth stating, because every other number in this module is load
        // bearing.
        let raw = encode_unsigned(&[spec_input()], &[spec_output()], &[]).expect("encodes");
        let again = encode_unsigned(&[spec_input()], &[spec_output()], &[]).expect("encodes");
        assert_eq!(raw, again);

        assert_eq!(QrAnimation::OPTIONS, &[450, 300, 100]);
        assert_eq!(QrAnimation::DEFAULT, QrAnimation::NORMAL);
        assert_eq!(QrAnimation::DEFAULT, 300);
        for interval in QrAnimation::OPTIONS {
            assert!(QrAnimation::label(*interval).is_some(), "{interval}");
        }
        assert_eq!(QrAnimation::label(200), None);

        // Slowest first, because that is how the control reads. Asserted
        // over the list rather than between the constants: comparing two
        // consts is folded away at compile time, so it proved nothing about
        // the order the control actually shows.
        assert!(
            QrAnimation::OPTIONS
                .windows(2)
                .all(|pair| pair[0] > pair[1]),
            "the speeds must be listed slowest first: {:?}",
            QrAnimation::OPTIONS
        );
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

        // Density is the user's trade to make: fewer frames is a shorter wait,
        // but some cameras cannot read a dense code, and the failure looks like
        // a camera that will not focus. The default is the easiest to scan.
        assert_eq!(SeedCashQr::FRAGMENT_OPTIONS, &[50, 100, 200, 400, 450]);
        assert_eq!(SeedCashQr::FRAGMENT_OPTIONS[0], SeedCashQr::CHUNK_SIZE);
        for fragment in SeedCashQr::FRAGMENT_OPTIONS {
            assert!(
                SeedCashQr::fragment_label(*fragment).is_some(),
                "every option a screen offers needs a name: {fragment}"
            );
        }
        assert_eq!(SeedCashQr::fragment_label(77), None);
    }

    fn seedcash_signed_fixture() -> (Vec<u8>, Vec<u8>) {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/services/psbt/__tests__/fixtures/seedcash-signed-roundtrip.json"
        ))
        .unwrap();
        let unhex = |name: &str| {
            fixture[name]
                .as_str()
                .unwrap()
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect()
        };
        (unhex("unsigned_hex"), unhex("signed_hex"))
    }

    fn encode_maps(maps: &ParsedMaps) -> Vec<u8> {
        let mut raw = PSBT_MAGIC.to_vec();
        for fields in std::iter::once(&maps.global)
            .chain(&maps.inputs)
            .chain(&maps.outputs)
        {
            for (key, value) in fields {
                record(&mut raw, key, value);
            }
            raw.push(0);
        }
        raw
    }

    #[test]
    fn finalize_p2pkh_accepts_captured_seedcash_schnorr_return() {
        let (original, signed) = seedcash_signed_fixture();
        let raw = finalize_p2pkh(&original, &signed, Network::Chipnet).unwrap();
        let decoded = crate::tx::decode(&raw).unwrap();
        assert_eq!(
            decoded.outputs.iter().map(|o| o.value).sum::<u64>(),
            999_750
        );
        let (inputs, _) = parse_transaction(&raw).unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].2.len(), 100);
        assert_eq!(inputs[0].2[0], 65); // BCH Schnorr plus 0x41
        assert_eq!(inputs[0].2[65], 0x41);
        assert_eq!(inputs[0].2[66], 33);
        // SeedCash legitimately reorders input fields; all maps may reorder.
        let mut reordered = parse_maps(&signed).unwrap();
        reordered.global.reverse();
        for fields in reordered.inputs.iter_mut().chain(&mut reordered.outputs) {
            fields.reverse();
        }
        assert_eq!(
            finalize_p2pkh(&original, &encode_maps(&reordered), Network::Chipnet).unwrap(),
            raw
        );
    }

    #[test]
    fn finalize_p2pkh_binds_every_retained_field_and_rejects_stripping() {
        let (original, signed) = seedcash_signed_fixture();
        // Exercise each global/input/output value and removal independently.
        // This includes the unsigned tx, parent UTXO, origin and sighash.
        let signed_maps = parse_maps(&signed).unwrap();
        let lengths: Vec<_> = std::iter::once(&signed_maps.global)
            .chain(&signed_maps.inputs)
            .chain(&signed_maps.outputs)
            .map(Vec::len)
            .collect();
        for (map_index, count) in lengths.into_iter().enumerate() {
            for field_index in 0..count {
                for remove in [false, true] {
                    let mut altered = parse_maps(&signed).unwrap();
                    let fields = std::iter::once(&mut altered.global)
                        .chain(&mut altered.inputs)
                        .chain(&mut altered.outputs)
                        .nth(map_index)
                        .unwrap();
                    if remove {
                        fields.remove(field_index);
                    } else {
                        fields[field_index].1[0] ^= 1;
                    }
                    assert!(
                        finalize_p2pkh(&original, &encode_maps(&altered), Network::Chipnet)
                            .is_err(),
                        "map {map_index} field {field_index} removal {remove}"
                    );
                }
            }
        }
    }

    #[test]
    fn finalize_p2pkh_rejects_missing_malformed_and_wrong_key_signatures() {
        let (original, signed) = seedcash_signed_fixture();
        assert!(finalize_p2pkh(&original, &original, Network::Chipnet).is_err());
        for replacement in [vec![], vec![0x41], vec![0; 65], vec![0x30, 0x01, 0x41]] {
            let mut altered = parse_maps(&signed).unwrap();
            altered.inputs[0]
                .iter_mut()
                .find(|(k, _)| k[0] == IN_PARTIAL_SIG)
                .unwrap()
                .1 = replacement;
            assert!(finalize_p2pkh(&original, &encode_maps(&altered), Network::Chipnet).is_err());
        }
        let mut altered = parse_maps(&signed).unwrap();
        altered.inputs[0]
            .iter_mut()
            .find(|(k, _)| k[0] == IN_PARTIAL_SIG)
            .unwrap()
            .0[1] ^= 1;
        assert!(finalize_p2pkh(&original, &encode_maps(&altered), Network::Chipnet).is_err());
        let mut altered = parse_maps(&signed).unwrap();
        let mut extra = altered.inputs[0]
            .iter()
            .find(|(k, _)| k[0] == IN_PARTIAL_SIG)
            .unwrap()
            .clone();
        extra.0[1] ^= 1;
        altered.inputs[0].push(extra);
        assert!(finalize_p2pkh(&original, &encode_maps(&altered), Network::Chipnet).is_err());
        assert!(finalize_p2pkh(&signed, &signed, Network::Chipnet).is_err());
    }

    #[test]
    fn finalize_p2pkh_checks_parent_hash_and_display_fields_even_when_retained() {
        let (original, signed) = seedcash_signed_fixture();
        for field in [
            IN_NON_WITNESS_UTXO,
            IN_PREVIOUS_TXID,
            IN_OUTPUT_INDEX,
            IN_SEQUENCE,
        ] {
            let mut a = parse_maps(&original).unwrap();
            let mut b = parse_maps(&signed).unwrap();
            for maps in [&mut a, &mut b] {
                // Altering only the parent's version preserves the committed
                // output amount/script and signature digest, but changes txid.
                maps.inputs[0]
                    .iter_mut()
                    .find(|(key, _)| key.as_slice() == [field])
                    .unwrap()
                    .1[0] ^= 1;
            }
            assert!(finalize_p2pkh(&encode_maps(&a), &encode_maps(&b), Network::Chipnet).is_err());
        }
        for field in [OUT_AMOUNT, OUT_SCRIPT] {
            let mut a = parse_maps(&original).unwrap();
            let mut b = parse_maps(&signed).unwrap();
            for maps in [&mut a, &mut b] {
                maps.outputs[0]
                    .iter_mut()
                    .find(|(key, _)| key.as_slice() == [field])
                    .unwrap()
                    .1[0] ^= 1;
            }
            assert!(finalize_p2pkh(&encode_maps(&a), &encode_maps(&b), Network::Chipnet).is_err());
        }
        // An amount-and-script record is not proof of its outpoint's parent.
        let mut a = parse_maps(&original).unwrap();
        let mut b = parse_maps(&signed).unwrap();
        for maps in [&mut a, &mut b] {
            let parent = maps.inputs[0]
                .iter_mut()
                .find(|(key, _)| key.as_slice() == [IN_NON_WITNESS_UTXO])
                .unwrap();
            let output = crate::tx::decode(&parent.1).unwrap().outputs.remove(0);
            parent.0 = vec![IN_WITNESS_UTXO];
            parent.1 = output.value.to_le_bytes().to_vec();
            parent.1.extend(compact_size(output.script_pubkey.len()));
            parent.1.extend(output.script_pubkey);
        }
        assert!(finalize_p2pkh(&encode_maps(&a), &encode_maps(&b), Network::Chipnet).is_err());
    }

    #[test]
    fn finalize_p2pkh_refuses_unsupported_network_and_script_metadata() {
        let (original, signed) = seedcash_signed_fixture();
        assert!(finalize_p2pkh(&original, &signed, Network::Mainnet).is_err());
        for (output, kind) in [
            (false, IN_REDEEM_SCRIPT),
            (false, 0x05),
            (false, 0x07),
            (false, 0x08),
            (true, OUT_CASHTOKEN),
            (true, OUT_REDEEM_SCRIPT),
        ] {
            let mut a = parse_maps(&original).unwrap();
            let mut b = parse_maps(&signed).unwrap();
            for maps in [&mut a, &mut b] {
                let fields = if output {
                    &mut maps.outputs[0]
                } else {
                    &mut maps.inputs[0]
                };
                fields.push((vec![kind], vec![0x51]));
            }
            assert!(finalize_p2pkh(&encode_maps(&a), &encode_maps(&b), Network::Chipnet).is_err());
        }
        for sighash in [0x42u32, 0x43, 0xc1, 0xc2, 0xc3] {
            let mut a = parse_maps(&original).unwrap();
            let mut b = parse_maps(&signed).unwrap();
            for maps in [&mut a, &mut b] {
                maps.inputs[0]
                    .iter_mut()
                    .find(|(k, _)| k[0] == IN_SIGHASH_TYPE)
                    .unwrap()
                    .1 = sighash.to_le_bytes().to_vec();
            }
            assert!(finalize_p2pkh(&encode_maps(&a), &encode_maps(&b), Network::Chipnet).is_err());
        }
    }

    #[test]
    fn finalize_p2pkh_verifies_ecdsa_and_preserves_each_sequence() {
        use crate::tx::{self, Output, Transaction, Utxo};
        use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
        use k256::elliptic_curve::rand_core::OsRng;

        let keys = [
            SigningKey::random(&mut OsRng),
            SigningKey::random(&mut OsRng),
        ];
        let sequences = [0xffff_fffd, 42];
        let mut specs = Vec::new();
        let mut utxos = Vec::new();
        for (index, key) in keys.iter().enumerate() {
            let pubkey: [u8; 33] = key
                .verifying_key()
                .to_encoded_point(true)
                .as_bytes()
                .try_into()
                .unwrap();
            let script: Vec<_> = [0x76, 0xa9, 0x14]
                .into_iter()
                .chain(crate::hd::hash160(&pubkey))
                .chain([0x88, 0xac])
                .collect();
            let parent = Transaction::new(
                vec![Utxo {
                    txid: [0; 32],
                    vout: index as u32,
                    value: 10_000,
                    script_pubkey: vec![],
                }],
                vec![Output::new(10_000, script.clone())],
            )
            .serialize_with_sequences(&[vec![]], &[0xffff_ffff])
            .unwrap();
            let txid = tx::double_sha256(&parent);
            let mut display = txid;
            display.reverse();
            specs.push(PsbtInputSpec {
                txid_display: display,
                vout: 0,
                sequence: Some(sequences[index]),
                satoshis: 10_000,
                locking_bytecode: script.clone(),
                previous_transaction: Some(parent),
                redeem_script: None,
                partial_signatures: vec![],
                derivations: vec![KeyOrigin {
                    pubkey,
                    fingerprint: [0; 4],
                    path: vec![0x8000_002c, 0x8000_0091, 0x8000_0002, 0, index as u32],
                }],
            });
            utxos.push(Utxo {
                txid,
                vout: 0,
                value: 10_000,
                script_pubkey: script,
            });
        }
        let outputs = [PsbtOutputSpec {
            satoshis: 19_000,
            locking_bytecode: specs[0].locking_bytecode.clone(),
            redeem_script: None,
            derivations: vec![],
            token_prefix: None,
        }];
        let mut original = parse_maps(&encode_unsigned(&specs, &outputs, &[]).unwrap()).unwrap();
        // Non-default version and locktime must survive as well as sequences.
        let unsigned = &mut original
            .global
            .iter_mut()
            .find(|(k, _)| k[0] == GLOBAL_UNSIGNED_TX)
            .unwrap()
            .1;
        unsigned[..4].copy_from_slice(&1u32.to_le_bytes());
        let end = unsigned.len();
        unsigned[end - 4..].copy_from_slice(&123u32.to_le_bytes());
        let original = encode_maps(&original);
        let transaction = Transaction {
            version: 1,
            inputs: utxos,
            outputs: vec![Output::new(19_000, outputs[0].locking_bytecode.clone())],
            locktime: 123,
            sequence: 0,
        };
        let mut signed = parse_maps(&original).unwrap();
        let mut expected_scripts = Vec::new();
        for (index, key) in keys.iter().enumerate() {
            let digest = tx::double_sha256(
                &transaction
                    .sighash_preimage_with_sequences(index, &sequences)
                    .unwrap(),
            );
            let signature: Signature = key.sign_prehash(&digest).unwrap();
            let signature = signature.normalize_s().unwrap_or(signature);
            let mut bytes = signature.to_der().as_bytes().to_vec();
            bytes.push(0x41);
            let pubkey = specs[index].derivations[0].pubkey;
            expected_scripts.push(tx::verified_p2pkh_script_sig(&pubkey, &bytes, &digest).unwrap());
            signed.inputs[index].push(([vec![IN_PARTIAL_SIG], pubkey.to_vec()].concat(), bytes));
        }
        let finalized = finalize_p2pkh(&original, &encode_maps(&signed), Network::Chipnet).unwrap();
        assert_eq!(
            finalized,
            transaction
                .serialize_with_sequences(&expected_scripts, &sequences)
                .unwrap()
        );
        let decoded = tx::decode(&finalized).unwrap();
        assert_eq!(decoded.version, 1);
        assert_eq!(decoded.locktime, 123);
        assert_eq!(
            decoded.inputs.iter().map(|i| i.2).collect::<Vec<_>>(),
            sequences
        );
    }
}

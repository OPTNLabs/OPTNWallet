//! WizardConnect sign-in proofs.
//!
//! WizardConnect (hdwalletv1) has no message signing, only transaction
//! signing. A dApp proves that a wallet controls an address by asking it to
//! sign a transaction that can never be mined:
//!
//! ```text
//! input 0   outpoint sha256(OUTPOINT_TAG || code || ":" || domain):0, worth
//!           1000 sats, P2PKH to the address being proven. No transaction has
//!           that id, so the signed result spends nothing and cannot be
//!           broadcast.
//! output 0  OP_RETURN "WCPROOF" <code> <domain>, 0 sats
//! output 1  1000 sats back to the same address
//! version 2, locktime 0, sequence 0xffffffff, SIGHASH_ALL|UTXOS|FORKID (0x61)
//! ```
//!
//! The wallet never signs the dApp's transaction. It reads the one-time code
//! and the relying party's domain out of the request, builds the proof itself
//! for one of its own addresses, and refuses unless the request is
//! byte-identical to what it built. A request that carries the tag but differs
//! in any way (another input, a real outpoint, a changed output or value, a
//! token, a contract) is refused outright rather than signed as a payment.
//!
//! The domain says who the proof is for. Without it, a dApp the user is
//! connected to could start a login at another service, pass that service's
//! code to the wallet, and forward the proof: the user would approve under the
//! dApp's name and the other service would accept. With it, the approval
//! screen names the service being signed in to and the signature commits to
//! that name. This holds only if every relying party checks for its own
//! domain.
//!
//! Because the signature commits to every output and to the (fake) source
//! output, a server can rebuild the same transaction from the code it issued,
//! its own domain and the address it expects, check that the unlocking public
//! key hashes to that address, and run the BCH VM over it. A proof is never
//! relayed, so consensus rules are the ones that apply. Relay policy agrees
//! for any domain of up to 146 bytes; a longer one can take the OP_RETURN
//! past the 223-byte limit on data carriers, which the vectors record.
//!
//! Signing goes through [`crate::connect`], the same path every connector
//! payment takes. This module decides what may be signed; it holds no
//! cryptography of its own.

use std::fmt;
use std::ops::RangeInclusive;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::cashaddr::{Address, AddressKind};
use crate::connect::{self, ALL_OUTPUTS_ALL_UTXOS};
use crate::tx;

/// First push of the OP_RETURN output. Compared as exact bytes.
pub const OP_RETURN_TAG: &[u8] = b"WCPROOF";
/// Hashed with the code and the domain to make an outpoint no real
/// transaction can have.
pub const OUTPOINT_TAG: &[u8] = b"WizardConnect sign-in proof:";
/// Between the code and the domain in that hash. Neither may contain it, so
/// no two challenges hash the same bytes.
pub const OUTPOINT_SEPARATOR: &[u8] = b":";
/// Value of the fake input and of the output that returns it.
pub const VALUE_SATOSHIS: u64 = 1000;
pub const VERSION: u32 = 2;
pub const LOCKTIME: u32 = 0;
pub const SEQUENCE_NUMBER: u32 = 0xffff_ffff;
/// SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID.
pub const SIGHASH: u8 = ALL_OUTPUTS_ALL_UTXOS;

/// `^[0-9A-Za-z_-]{16,64}$`. Short enough for a single-byte push.
const CODE_LENGTH: RangeInclusive<usize> = 16..=64;
/// A DNS name is at most 253 bytes of labels of at most 63 (RFC 1035).
const DOMAIN_LENGTH: RangeInclusive<usize> = 1..=253;
const LABEL_LENGTH: RangeInclusive<usize> = 1..=63;
const OP_RETURN: u8 = 0x6a;
/// Largest length a script states in its own opcode.
const MAX_DIRECT_PUSH: u8 = 75;
/// Hardened indexes need the private key, so no address is proven at one.
const HARDENED: u32 = 0x8000_0000;
// A resource bound for the connector request, not a consensus limit.
const MAX_REQUEST_BYTES: usize = 1024 * 1024;

/// Why a request that claims to be a sign-in proof was not signed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Request,
    Broadcast,
    Transaction,
    Inputs,
    Outputs,
    OpReturn,
    Code,
    Domain,
    InputPath,
    AddressPath,
    AddressIndex,
    /// The wallet could not produce the key for the requested address.
    WalletKey(String),
    Outpoint,
    SourceOutput,
    Token,
    Unlocked,
    NotCanonical,
    /// The signer failed or produced something other than this proof.
    Signer(String),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Refusal::Request => "malformed request",
            Refusal::Broadcast => "a sign-in proof is never broadcast",
            Refusal::Transaction => "invalid transaction",
            Refusal::Inputs => "a proof has exactly one (fake) input",
            Refusal::Outputs => "a proof has exactly two outputs",
            Refusal::OpReturn => "output 0 must be OP_RETURN <tag> <code> <domain>",
            Refusal::Code => "invalid one-time code for WizardConnect sign-in",
            Refusal::Domain => "invalid relying-party domain",
            Refusal::InputPath => "exactly one wallet input path, for input 0",
            Refusal::AddressPath => "unsupported address path",
            Refusal::AddressIndex => "invalid address index",
            Refusal::WalletKey(reason) => return write!(f, "no wallet key: {reason}"),
            Refusal::Outpoint => "outpoint is not the derived fake outpoint",
            Refusal::SourceOutput => "source output is not the fake proof input for this address",
            Refusal::Token => "token data is not allowed",
            Refusal::Unlocked => "input is already unlocked",
            Refusal::NotCanonical => "transaction differs from the canonical proof",
            Refusal::Signer(reason) => return write!(f, "signing failed: {reason}"),
        })
    }
}

impl std::error::Error for Refusal {}

pub type Result<T> = std::result::Result<T, Refusal>;

/// What the proof commits to: the one-time code the relying party issued,
/// and the relying party's own domain.
///
/// The builder, the validator and the signer take the statement from this
/// type. Anything a proof binds is a field here and a push in
/// [`Challenge::pushes`] and [`Challenge::from_pushes`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Challenge {
    code: String,
    domain: String,
}

impl Challenge {
    pub fn new(code: &str, domain: &str) -> Result<Self> {
        let alphabet = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-';
        if !CODE_LENGTH.contains(&code.len()) || !code.bytes().all(alphabet) {
            return Err(Refusal::Code);
        }
        if !is_domain(domain) {
            return Err(Refusal::Domain);
        }
        Ok(Challenge {
            code: code.to_owned(),
            domain: domain.to_owned(),
        })
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    /// The relying party the proof is for, as the user must be shown it.
    pub fn domain(&self) -> &str {
        &self.domain
    }

    /// The pushes that follow the tag, in order.
    fn pushes(&self) -> [&[u8]; 2] {
        [self.code.as_bytes(), self.domain.as_bytes()]
    }

    /// Read back what [`Challenge::pushes`] wrote. A different number of
    /// pushes is a different format, not a challenge with something missing
    /// or extra: the form without a domain is refused, not read as "any".
    fn from_pushes(pushes: &[&[u8]]) -> Result<Self> {
        let [code, domain] = pushes else {
            return Err(Refusal::OpReturn);
        };
        Challenge::new(
            std::str::from_utf8(code).map_err(|_| Refusal::Code)?,
            std::str::from_utf8(domain).map_err(|_| Refusal::Domain)?,
        )
    }

    fn op_return(&self) -> Vec<u8> {
        let mut script = vec![OP_RETURN];
        for data in std::iter::once(OP_RETURN_TAG).chain(self.pushes()) {
            script.extend_from_slice(&tx::push_data(data));
        }
        script
    }

    /// Transaction id of the fake outpoint, in display order.
    fn outpoint_hash(&self) -> [u8; 32] {
        outpoint_hash(self.code.as_bytes(), self.domain.as_bytes())
    }
}

/// A lowercase DNS host name and nothing else: no scheme, port, path, user or
/// trailing dot, so that what the user is shown is exactly what is signed.
///
/// Internationalized names appear in their ASCII (`xn--`) form, which is also
/// the form that cannot be confused with another name on screen. A name
/// ending in a number is an IPv4 address, not a domain.
fn is_domain(domain: &str) -> bool {
    let label = |label: &str| {
        LABEL_LENGTH.contains(&label.len())
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    let numeric = |label: &str| label.bytes().all(|byte| byte.is_ascii_digit());
    DOMAIN_LENGTH.contains(&domain.len())
        && domain.split('.').all(label)
        && !domain.rsplit('.').next().is_some_and(numeric)
}

fn outpoint_hash(code: &[u8], domain: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update(OUTPOINT_TAG)
        .chain_update(code)
        .chain_update(OUTPOINT_SEPARATOR)
        .chain_update(domain)
        .finalize()
        .into()
}

/// The outpoint of the format before the domain was bound: the code alone.
/// Never built or accepted, only recognised by the broadcast guard.
fn unbound_outpoint_hash(code: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update(OUTPOINT_TAG)
        .chain_update(code)
        .finalize()
        .into()
}

/// The data of a script made only of complete pushes, or `None` for any
/// other script.
fn data_pushes(mut script: &[u8]) -> Option<Vec<&[u8]>> {
    let mut pushes = Vec::new();
    while let Some((&opcode, after)) = script.split_first() {
        let (length, after) = match opcode {
            0..=MAX_DIRECT_PUSH => (usize::from(opcode), after),
            0x4c => {
                let (length, after) = after.split_first()?;
                (usize::from(*length), after)
            }
            0x4d => {
                let (length, after) = after.split_first_chunk::<2>()?;
                (usize::from(u16::from_le_bytes(*length)), after)
            }
            0x4e => {
                let (length, after) = after.split_first_chunk::<4>()?;
                (usize::try_from(u32::from_le_bytes(*length)).ok()?, after)
            }
            _ => return None,
        };
        let (data, after) = after.split_at_checked(length)?;
        pushes.push(data);
        script = after;
    }
    Some(pushes)
}

/// The pushes that follow OP_RETURN, or `None` when the script is not an
/// OP_RETURN made only of complete pushes.
fn op_return_pushes(script: &[u8]) -> Option<Vec<&[u8]>> {
    match script.split_first() {
        Some((&OP_RETURN, data)) => data_pushes(data),
        _ => None,
    }
}

/// Whether an output claims to be a sign-in proof: an OP_RETURN whose first
/// push is the tag.
///
/// A request with such an output is either the canonical proof or refused; it
/// is never signed as a payment. The raw push is read rather than the parsed
/// script, and a push cut short still counts, so that a malformed tagged
/// output is refused instead of slipping through as an ordinary transaction.
pub fn claims(locking_bytecode: &[u8]) -> bool {
    let [OP_RETURN, length @ 1..=MAX_DIRECT_PUSH, rest @ ..] = locking_bytecode else {
        return false;
    };
    &rest[..rest.len().min(usize::from(*length))] == OP_RETURN_TAG
}

/// Whether raw transaction bytes are a sign-in proof, signed or not: a tagged
/// OP_RETURN and an input spending the outpoint derived from what it states.
///
/// This is the broadcast guard. It is deliberately looser than
/// [`validate`]: anything built around a fake outpoint can never confirm,
/// whatever else was done to it, so none of it may be handed to the network.
/// That includes a proof in the form from before the domain was bound.
pub fn is_sign_in_proof(raw: &[u8]) -> bool {
    let Ok(decoded) = tx::decode(raw) else {
        return false;
    };
    let spends = |mut wire: [u8; 32]| {
        wire.reverse();
        decoded.inputs.iter().any(|(txid, _, _)| *txid == wire)
    };
    decoded.outputs.iter().any(|output| {
        let Some(pushes) = op_return_pushes(&output.script_pubkey) else {
            return false;
        };
        match pushes.as_slice() {
            [tag, ..] if *tag != OP_RETURN_TAG => false,
            [_, code] => spends(unbound_outpoint_hash(code)),
            [_, code, domain, ..] => {
                spends(outpoint_hash(code, domain)) || spends(unbound_outpoint_hash(code))
            }
            _ => false,
        }
    })
}

/// The canonical proof for one challenge and one of the wallet's own keys.
/// Nothing in it comes from the dApp's transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proof {
    challenge: Challenge,
    public_key: Vec<u8>,
    locking_bytecode: Vec<u8>,
}

impl Proof {
    /// `public_key` is the compressed key of the address being proven.
    pub fn new(challenge: Challenge, public_key: &[u8]) -> Result<Self> {
        Ok(Proof {
            challenge,
            locking_bytecode: connect::p2pkh_lock(public_key).map_err(Refusal::WalletKey)?,
            public_key: public_key.to_vec(),
        })
    }

    pub fn code(&self) -> &str {
        self.challenge.code()
    }

    pub fn domain(&self) -> &str {
        self.challenge.domain()
    }

    pub fn public_key(&self) -> &[u8] {
        &self.public_key
    }

    pub fn locking_bytecode(&self) -> &[u8] {
        &self.locking_bytecode
    }

    /// The address being proven, as a CashAddr under `prefix`.
    pub fn address(&self, prefix: &str) -> String {
        let hash = crate::hd::hash160(&self.public_key);
        Address::from_hash(prefix, AddressKind::P2pkh, hash).encode()
    }

    /// The proof as the dApp must have sent it: not yet unlocked.
    pub fn unsigned(&self) -> Vec<u8> {
        self.encode(&[])
    }

    fn outputs(&self) -> [(u64, Vec<u8>); 2] {
        [
            (0, self.challenge.op_return()),
            (VALUE_SATOSHIS, self.locking_bytecode.clone()),
        ]
    }

    fn encode(&self, unlocking_bytecode: &[u8]) -> Vec<u8> {
        // Wire order is the display hash reversed.
        let mut txid = self.challenge.outpoint_hash();
        txid.reverse();
        let transaction = tx::Transaction {
            version: VERSION,
            inputs: vec![tx::Utxo {
                txid,
                vout: 0,
                value: VALUE_SATOSHIS,
                script_pubkey: self.locking_bytecode.clone(),
            }],
            outputs: self
                .outputs()
                .into_iter()
                .map(|(value, script)| tx::Output::new(value, script))
                .collect(),
            locktime: LOCKTIME,
            sequence: SEQUENCE_NUMBER,
        };
        transaction
            .serialize_with_sequences(&[unlocking_bytecode.to_vec()], &[SEQUENCE_NUMBER])
            .expect("one unlocking script and one sequence number for the one input")
    }

    fn signing_context(&self) -> connect::SigningContext {
        let output = |(value_satoshis, locking_bytecode)| connect::Output {
            value_satoshis,
            locking_bytecode,
            token: None,
        };
        connect::SigningContext {
            input_index: 0,
            transaction: connect::Transaction {
                version: VERSION,
                locktime: LOCKTIME,
                inputs: vec![connect::Input {
                    outpoint_transaction_hash: self.challenge.outpoint_hash().to_vec(),
                    outpoint_index: 0,
                    sequence_number: SEQUENCE_NUMBER,
                }],
                outputs: self.outputs().into_iter().map(output).collect(),
            },
            source_outputs: vec![output((VALUE_SATOSHIS, self.locking_bytecode.clone()))],
        }
    }

    /// Sign this proof, and only this proof, with the key of the address
    /// being proven. Returns the signed transaction.
    ///
    /// The key is owned and erased by the connector signer on every return.
    pub fn sign(&self, private_key: Vec<u8>) -> Result<Vec<u8>> {
        let unlocking = connect::sign_p2pkh(&self.signing_context(), private_key, SIGHASH)
            .map_err(Refusal::Signer)?;
        // The signer is trusted to sign, not to choose what this proof says.
        let parts = data_pushes(&unlocking);
        let Some([signature, public_key]) = parts.as_deref() else {
            return Err(Refusal::Signer(
                "unexpected unlocking script from the signer".into(),
            ));
        };
        if signature.last() != Some(&SIGHASH) {
            return Err(Refusal::Signer("wrong sighash type".into()));
        }
        if *public_key != self.public_key {
            return Err(Refusal::Signer(
                "signing key does not match the proven address".into(),
            ));
        }
        let signed = self.encode(&unlocking);
        if !is_sign_in_proof(&signed) {
            return Err(Refusal::Signer("signed proof failed self-check".into()));
        }
        Ok(signed)
    }
}

/// One of the three address branches hdwalletv1 names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Path {
    Receive,
    Change,
    Defi,
}

impl Path {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "receive" => Some(Path::Receive),
            "change" => Some(Path::Change),
            "defi" => Some(Path::Defi),
            _ => None,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Path::Receive => "receive",
            Path::Change => "change",
            Path::Defi => "defi",
        }
    }
}

/// The wallet's branch extended public keys, one per hdwalletv1 path.
#[derive(Clone, Copy, Debug)]
pub struct BranchKeys<'a> {
    pub receive: &'a str,
    pub change: &'a str,
    pub defi: &'a str,
}

impl BranchKeys<'_> {
    /// The key lookup [`validate`] takes: public derivation, so proving an
    /// address needs no secret until the user approves the signature.
    pub fn public_key(
        &self,
        path: Path,
        address_index: u32,
    ) -> std::result::Result<Vec<u8>, String> {
        let branch = match path {
            Path::Receive => self.receive,
            Path::Change => self.change,
            Path::Defi => self.defi,
        };
        crate::hd::hd_public_key_child(branch, address_index)
            .map(|key| key.to_vec())
            .map_err(|error| error.to_string())
    }
}

/// The output a dApp says the proof's input spends.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceOutput {
    /// A decimal string, so the value survives the WASM boundary exactly.
    #[serde(with = "decimal")]
    pub value_satoshis: u64,
    #[serde(with = "hex")]
    pub locking_bytecode: Vec<u8>,
    /// Whether the dApp attached CashTokens to it.
    pub token: bool,
    /// Whether the dApp marked it as a contract to be unlocked.
    pub contract: bool,
    #[serde(with = "hex")]
    pub unlocking_bytecode: Vec<u8>,
}

/// A WizardConnect `sign_transaction` request that claims to be a proof.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    /// The transaction the dApp asked for, as wire bytes.
    #[serde(with = "hex")]
    pub transaction: Vec<u8>,
    pub source_outputs: Vec<SourceOutput>,
    /// `[input index, path name, address index]`, as hdwalletv1 sends them.
    pub input_paths: Vec<(u64, String, u64)>,
    pub broadcast: bool,
}

pub fn parse_request(json: &str) -> Result<Request> {
    if json.len() > MAX_REQUEST_BYTES {
        return Err(Refusal::Request);
    }
    serde_json::from_str(json).map_err(|_| Refusal::Request)
}

mod decimal {
    use serde::{de::Error, Deserialize, Deserializer};

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(D::Error::custom(
                "amount must be an unsigned decimal integer",
            ));
        }
        value
            .parse()
            .map_err(|_| D::Error::custom("amount is out of range"))
    }
}

mod hex {
    use serde::{de::Error, Deserialize, Deserializer};

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        crate::coins::hex_decode(&String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("bytes must be even-length hexadecimal"))
    }
}

/// A request the wallet may sign: the canonical proof for the address at
/// `path`/`address_index`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Validated {
    pub path: Path,
    pub address_index: u32,
    pub proof: Proof,
}

/// Accept `request` only if it is exactly the canonical proof for one of the
/// wallet's own addresses.
///
/// `public_key_for` returns the wallet's compressed public key at a path and
/// index. The address is always derived from it, never taken from the dApp;
/// the dApp's source output must already lock to it.
pub fn validate(
    request: &Request,
    public_key_for: impl FnOnce(Path, u32) -> std::result::Result<Vec<u8>, String>,
) -> Result<Validated> {
    if request.broadcast {
        return Err(Refusal::Broadcast);
    }
    let (decoded, unlocking) =
        tx::decode_with_input_scripts(&request.transaction).map_err(|_| Refusal::Transaction)?;
    let ([input], [source]) = (decoded.inputs.as_slice(), request.source_outputs.as_slice()) else {
        return Err(Refusal::Inputs);
    };
    let [statement, _] = decoded.outputs.as_slice() else {
        return Err(Refusal::Outputs);
    };
    let pushed = op_return_pushes(&statement.script_pubkey).ok_or(Refusal::OpReturn)?;
    let challenge = match pushed.split_first() {
        Some((&tag, rest)) if tag == OP_RETURN_TAG => Challenge::from_pushes(rest)?,
        _ => return Err(Refusal::OpReturn),
    };

    let [(0, path, address_index)] = request.input_paths.as_slice() else {
        return Err(Refusal::InputPath);
    };
    let path = Path::parse(path).ok_or(Refusal::AddressPath)?;
    let address_index = u32::try_from(*address_index)
        .ok()
        .filter(|index| *index < HARDENED)
        .ok_or(Refusal::AddressIndex)?;

    let public_key = public_key_for(path, address_index).map_err(Refusal::WalletKey)?;
    let proof = Proof::new(challenge, &public_key)?;

    let mut wire = proof.challenge.outpoint_hash();
    wire.reverse();
    if (input.0, input.1) != (wire, 0) {
        return Err(Refusal::Outpoint);
    }
    if source.token
        || source.contract
        || source.value_satoshis != VALUE_SATOSHIS
        || source.locking_bytecode != proof.locking_bytecode
        || !source.unlocking_bytecode.is_empty()
    {
        return Err(Refusal::SourceOutput);
    }
    if decoded.outputs.iter().any(|output| output.token.is_some()) {
        return Err(Refusal::Token);
    }
    if unlocking.iter().any(|script| !script.is_empty()) {
        return Err(Refusal::Unlocked);
    }
    // Everything above names the reason. This is the check that decides.
    if request.transaction != proof.unsigned() {
        return Err(Refusal::NotCanonical);
    }
    Ok(Validated {
        path,
        address_index,
        proof,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fusion::schnorr;
    use crate::hd;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Vectors {
        #[serde(rename = "reference")]
        _reference: String,
        format: Format,
        wallet: Wallet,
        proofs: Vec<ProofVector>,
        refusals: Vec<RefusalVector>,
        unclaimed: Vec<UnclaimedVector>,
        broadcast_guard: Vec<GuardVector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Format {
        op_return_tag: String,
        outpoint_tag: String,
        outpoint_separator: String,
        #[serde(with = "decimal")]
        value_satoshis: u64,
        version: u32,
        locktime: u32,
        sequence_number: u32,
        sighash: u8,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Wallet {
        mnemonic: String,
        account_path: String,
        xpubs: Xpubs,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Xpubs {
        receive: String,
        change: String,
        defi: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Addresses {
        mainnet: String,
        chipnet: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ProofVector {
        name: String,
        code: String,
        domain: String,
        path: String,
        address_index: u32,
        derivation_path: String,
        #[serde(with = "hex")]
        public_key: Vec<u8>,
        #[serde(with = "hex")]
        locking_bytecode: Vec<u8>,
        addresses: Addresses,
        #[serde(with = "hex")]
        outpoint_hash: Vec<u8>,
        #[serde(with = "hex")]
        op_return: Vec<u8>,
        #[serde(with = "hex")]
        unsigned: Vec<u8>,
        #[serde(with = "hex")]
        signed: Vec<u8>,
        /// Whether relay policy accepts it too. A proof is never relayed.
        #[serde(rename = "standard")]
        _standard: bool,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RefusalVector {
        name: String,
        reason: String,
        request: Request,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct UnclaimedVector {
        name: String,
        request: Request,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct GuardVector {
        name: String,
        #[serde(with = "hex")]
        transaction: Vec<u8>,
        sign_in_proof: bool,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!(
            "../../../test-vectors/wizardconnect-sign-in-proof.json"
        ))
        .expect("sign-in proof vectors parse")
    }

    impl Vectors {
        fn validate(&self, request: &Request) -> Result<Validated> {
            let keys = BranchKeys {
                receive: &self.wallet.xpubs.receive,
                change: &self.wallet.xpubs.change,
                defi: &self.wallet.xpubs.defi,
            };
            validate(request, |path, index| keys.public_key(path, index))
        }

        fn private_key(&self, derivation_path: &str) -> Vec<u8> {
            hd::Wallet::from_mnemonic(&self.wallet.mnemonic, "")
                .and_then(|wallet| wallet.private_key(derivation_path))
                .expect("the public test mnemonic derives")
                .to_vec()
        }
    }

    impl ProofVector {
        fn request(&self) -> Request {
            Request {
                transaction: self.unsigned.clone(),
                source_outputs: vec![SourceOutput {
                    value_satoshis: VALUE_SATOSHIS,
                    locking_bytecode: self.locking_bytecode.clone(),
                    token: false,
                    contract: false,
                    unlocking_bytecode: Vec::new(),
                }],
                input_paths: vec![(0, self.path.clone(), u64::from(self.address_index))],
                broadcast: false,
            }
        }
    }

    fn transaction_claims(raw: &[u8]) -> bool {
        tx::decode(raw)
            .expect("vector transaction decodes")
            .outputs
            .iter()
            .any(|output| claims(&output.script_pubkey))
    }

    #[test]
    fn the_format_is_the_one_the_vectors_record() {
        let format = vectors().format;
        assert_eq!(format.op_return_tag.as_bytes(), OP_RETURN_TAG);
        assert_eq!(format.outpoint_tag.as_bytes(), OUTPOINT_TAG);
        assert_eq!(format.outpoint_separator.as_bytes(), OUTPOINT_SEPARATOR);
        assert_eq!(format.value_satoshis, VALUE_SATOSHIS);
        assert_eq!(format.version, VERSION);
        assert_eq!(format.locktime, LOCKTIME);
        assert_eq!(format.sequence_number, SEQUENCE_NUMBER);
        assert_eq!(format.sighash, SIGHASH);
    }

    #[test]
    fn the_canonical_proof_matches_the_reference_byte_for_byte() {
        let vectors = vectors();
        assert!(!vectors.proofs.is_empty());
        for vector in &vectors.proofs {
            let name = &vector.name;
            let challenge = Challenge::new(&vector.code, &vector.domain).unwrap();
            assert_eq!(
                challenge.outpoint_hash()[..],
                vector.outpoint_hash,
                "{name}"
            );
            assert_eq!(challenge.op_return(), vector.op_return, "{name}");
            let proof = Proof::new(challenge, &vector.public_key).unwrap();
            assert_eq!(proof.code(), vector.code, "{name}");
            assert_eq!(proof.domain(), vector.domain, "{name}");
            assert_eq!(proof.public_key(), vector.public_key, "{name}");
            assert_eq!(proof.locking_bytecode(), vector.locking_bytecode, "{name}");
            assert_eq!(proof.unsigned(), vector.unsigned, "{name}");
            assert_eq!(proof.address("bitcoincash"), vector.addresses.mainnet);
            assert_eq!(proof.address("bchtest"), vector.addresses.chipnet);
        }
    }

    #[test]
    fn a_domain_is_a_lowercase_dns_host_name_and_nothing_else() {
        let longest_label = "a".repeat(63);
        for domain in [
            "example.com",
            "localhost",
            "login.example.co.uk",
            "xn--bcher-kva.example",
            "3com.example",
            "a-b.c-d.example",
            "a.b",
            &format!("{longest_label}.example"),
        ] {
            assert!(is_domain(domain), "{domain}");
        }
        for domain in [
            "",
            ".",
            "Example.com",
            "example.com.",
            ".example.com",
            "example..com",
            "example.com:443",
            "example.com/login",
            "https://example.com",
            "user@example.com",
            "exa mple.com",
            "my_app.example",
            "-example.com",
            "example-.com",
            "127.0.0.1",
            "example.123",
            "12345",
            "ex\u{e4}mple.com",
            "example.com\n",
            &format!("a{longest_label}.example"),
        ] {
            assert!(!is_domain(domain), "{domain:?}");
        }
    }

    #[test]
    fn a_canonical_request_validates_to_the_wallets_own_address() {
        let vectors = vectors();
        for vector in &vectors.proofs {
            let name = &vector.name;
            assert!(transaction_claims(&vector.unsigned), "{name}");
            let validated = vectors.validate(&vector.request()).expect(name);
            assert_eq!(validated.path.name(), vector.path, "{name}");
            assert_eq!(validated.address_index, vector.address_index, "{name}");
            assert_eq!(validated.proof.code(), vector.code, "{name}");
            assert_eq!(validated.proof.domain(), vector.domain, "{name}");
            assert_eq!(validated.proof.public_key(), vector.public_key, "{name}");
            assert_eq!(validated.proof.unsigned(), vector.unsigned, "{name}");
        }
    }

    #[test]
    fn signing_reproduces_the_reference_signed_proof() {
        let vectors = vectors();
        for vector in &vectors.proofs {
            let name = &vector.name;
            assert!(
                vector
                    .derivation_path
                    .starts_with(&vectors.wallet.account_path),
                "{name}"
            );
            let proof = vectors.validate(&vector.request()).expect(name).proof;
            let signed = proof
                .sign(vectors.private_key(&vector.derivation_path))
                .expect(name);
            assert_eq!(signed, vector.signed, "{name}");
            assert!(is_sign_in_proof(&signed), "{name}");

            // The signature covers this proof's own signing serialization,
            // and the signed bytes are the unsigned ones plus the unlocking.
            let (decoded, unlocking) = tx::decode_with_input_scripts(&signed).unwrap();
            let parts = data_pushes(&unlocking[0]).unwrap();
            let [signature, public_key] = parts.as_slice() else {
                panic!("{name}: unlocking is not <signature> <public key>");
            };
            assert_eq!(*public_key, vector.public_key, "{name}");
            let (schnorr_signature, sighash) = signature.split_last_chunk::<1>().unwrap();
            assert_eq!(sighash, &[SIGHASH], "{name}");
            let preimage = connect::signing_serialization(
                &proof.signing_context(),
                proof.locking_bytecode(),
                SIGHASH,
            )
            .unwrap();
            assert!(
                schnorr::verify(
                    public_key,
                    schnorr_signature.try_into().unwrap(),
                    &connect::hash256(&preimage)
                ),
                "{name}"
            );
            let unsigned = tx::decode(&vector.unsigned).unwrap();
            assert_eq!(decoded.inputs, unsigned.inputs, "{name}");
            assert_eq!(decoded.version, unsigned.version, "{name}");
            assert_eq!(decoded.locktime, unsigned.locktime, "{name}");
            assert_eq!(decoded.outputs.len(), unsigned.outputs.len(), "{name}");
            for (signed, unsigned) in decoded.outputs.iter().zip(&unsigned.outputs) {
                assert_eq!(signed.value, unsigned.value, "{name}");
                assert_eq!(signed.script_pubkey, unsigned.script_pubkey, "{name}");
            }
        }
    }

    #[test]
    fn a_key_for_another_address_cannot_sign_the_proof() {
        let vectors = vectors();
        let [first, second, ..] = vectors.proofs.as_slice() else {
            panic!("two proof vectors");
        };
        let proof = vectors.validate(&first.request()).unwrap().proof;
        assert!(matches!(
            proof.sign(vectors.private_key(&second.derivation_path)),
            Err(Refusal::Signer(_))
        ));
        for length in [0, 31, 33] {
            assert!(matches!(
                proof.sign(vec![1; length]),
                Err(Refusal::Signer(_))
            ));
        }
    }

    #[test]
    fn every_tagged_request_that_is_not_the_canonical_proof_is_refused() {
        let vectors = vectors();
        assert!(!vectors.refusals.is_empty());
        // Collected, so one run shows every case that moved.
        let mut wrong = Vec::new();
        for vector in &vectors.refusals {
            let name = &vector.name;
            assert!(transaction_claims(&vector.request.transaction), "{name}");
            match vectors.validate(&vector.request) {
                Ok(_) => wrong.push(format!("{name}: accepted")),
                Err(refusal) if refusal.to_string() != vector.reason => {
                    wrong.push(format!("{name}: {refusal}, not {}", vector.reason));
                }
                Err(_) => {}
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    #[test]
    fn untagged_requests_do_not_claim_to_be_proofs() {
        let vectors = vectors();
        assert!(!vectors.unclaimed.is_empty());
        for vector in &vectors.unclaimed {
            let name = &vector.name;
            assert!(!transaction_claims(&vector.request.transaction), "{name}");
            // What the broadcast guard makes of each is under `broadcastGuard`:
            // it is wider than the claim. Asked directly, the validator still
            // accepts nothing but a proof.
            assert!(vectors.validate(&vector.request).is_err(), "{name}");
        }
    }

    #[test]
    fn the_broadcast_guard_flags_anything_spending_the_fake_outpoint() {
        let vectors = vectors();
        for vector in &vectors.broadcast_guard {
            assert_eq!(
                is_sign_in_proof(&vector.transaction),
                vector.sign_in_proof,
                "{}",
                vector.name
            );
        }
        assert!(vectors.broadcast_guard.iter().any(|v| v.sign_in_proof));
        assert!(vectors.broadcast_guard.iter().any(|v| !v.sign_in_proof));
    }
}

//! Writing a CHIP-BCMR registry for a token the wallet is about to create.
//!
//! `bcmr` reads registries; this module writes one. The two are kept apart
//! because they answer different questions: resolution asks "what does the
//! chain say this identity is", authoring asks "what exactly are we about to
//! commit to, forever, with a hash on chain".
//!
//! Three decisions shape everything here.
//!
//! **Every registry has the same shape.** A field that is safe to leave empty
//! is always written, empty, so any two registries this wallet publishes can
//! be read side by side. A field whose *presence* changes its meaning is only
//! written with a real value, because the specification gives those fields a
//! meaning when present that no empty value can undo:
//!
//! - `parse.bytecode` present means "parsable"; an empty bytecode leaves the
//!   altstack empty, so every NFT in the category fails to parse. Absent is
//!   what "sequential" means.
//! - `migrated` present tells wallets a migration is under way. It is never
//!   written here.
//! - `token.nfts` present claims NFTs exist. A fungible-only token omits it.
//!
//! **Defaults are real values, not placeholders.** `status` is `active`,
//! `splitId` is the network the token is minted on, and a parsable collection
//! gets a working type-and-serial layout. A registry without `defaultChain`
//! is read as mainnet by the specification, so a chipnet token that omitted it
//! would claim to live on mainnet.
//!
//! **The parse bytecode is generated, never typed.** Its first two bytes must
//! be `OP_0 OP_UTXOTOKENCOMMITMENT` (`00cf`). The specification's own example
//! uses `00d2`, which is `OP_OUTPUTTOKENCOMMITMENT`: in the standardized parsing
//! transaction output 0 carries no token, so that bytecode reads an empty
//! commitment and every NFT is unparsable. Generating the bytecode from a field
//! layout removes both that mistake and the offset slips hand-written layouts
//! suffer from.

use std::collections::BTreeMap;

use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::network::Network;

/// The JSON Schema every registry points at.
pub const SCHEMA_URI: &str = "https://cashtokens.org/bcmr-v2.schema.json";

/// Split ID of BCH mainnet, the BCH side of the BCH/XEC split.
pub const SPLIT_ID_MAINNET: &str =
    "0000000000000000029e471c41818d24b8b74c911071c4ef0b4a0509f9b5a8ce";
/// Split ID of chipnet, as listed by the specification.
pub const SPLIT_ID_CHIPNET: &str =
    "00000000040ba9641ba98a37b2e5ceead38e4e2930ac8f145c8094f94c708727";
/// Regtest has never split, so its split ID is its genesis block.
pub const SPLIT_ID_REGTEST: &str =
    "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";

/// Largest NFT commitment the VM accepts since the May 2026 upgrade.
pub const MAX_COMMITMENT_LENGTH: usize = 128;

/// Type-and-serial layout: one type byte, then the serial as a VM number.
///
/// `OP_0 OP_UTXOTOKENCOMMITMENT OP_1 OP_SPLIT OP_SWAP OP_TOALTSTACK
/// OP_TOALTSTACK`.
pub const DEFAULT_PARSE_BYTECODE: &str = "00cf517f7c6b6b";

/// Type key of the single NFT type in the default parsable layout.
pub const DEFAULT_NFT_TYPE_KEY: &str = "00";

/// Field identifier of the serial number in the default parsable layout.
pub const DEFAULT_SERIAL_FIELD: &str = "serial";

const OP_0: u8 = 0x00;
const OP_1: u8 = 0x51;
const OP_SPLIT: u8 = 0x7f;
const OP_SWAP: u8 = 0x7c;
const OP_TOALTSTACK: u8 = 0x6b;
const OP_EQUALVERIFY: u8 = 0x88;
const OP_UTXOTOKENCOMMITMENT: u8 = 0xcf;

const NFT_FIELD_ENCODINGS: [&str; 8] = [
    "binary",
    "boolean",
    "hex",
    "https-url",
    "ipfs-cid",
    "locktime",
    "number",
    "utf8",
];

/// The split ID a registry should name for tokens minted on `network`.
pub fn split_id(network: Network) -> &'static str {
    match network {
        Network::Mainnet => SPLIT_ID_MAINNET,
        Network::Chipnet => SPLIT_ID_CHIPNET,
        Network::Regtest => SPLIT_ID_REGTEST,
    }
}

/// Minimal VM number encoding of a non-negative integer.
///
/// Little-endian, with a trailing `00` whenever the top bit of the last byte
/// is set, because that bit is the sign. `128` is `8000`, not `80`: `80` is
/// negative zero, which wallets render as `X80`. Zero is the empty string.
pub fn vm_number(value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    let mut remaining = value;
    while remaining > 0 {
        out.push((remaining & 0xff) as u8);
        remaining >>= 8;
    }
    if out.last().is_some_and(|last| last & 0x80 != 0) {
        out.push(0);
    }
    out
}

/// The commitment of NFT number `number` in a sequential collection.
pub fn sequential_commitment(number: u64) -> Vec<u8> {
    vm_number(number)
}

/// The commitment of an NFT in the default parsable layout.
pub fn parsable_commitment(type_byte: u8, serial: u64) -> Vec<u8> {
    let mut out = vec![type_byte];
    out.extend(vm_number(serial));
    out
}

/// One segment of a parsable commitment, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldWidth {
    /// Exactly this many bytes.
    Fixed(u8),
    /// Whatever remains. Only valid as the final segment.
    Rest,
}

/// Parse bytecode for a commitment laid out as `segments`, type segment first.
///
/// Each fixed segment is `<width> OP_SPLIT OP_SWAP OP_TOALTSTACK`, which leaves
/// the head on the altstack and the tail on the stack. A final `Rest` segment
/// moves the tail to the altstack as it is. A layout ending in a fixed segment
/// instead requires the tail to be empty (`OP_0 OP_EQUALVERIFY`), so a longer
/// commitment than the layout describes fails to parse rather than losing its
/// trailing bytes without a word. A commitment too short for the layout fails
/// at its `OP_SPLIT`. The unlocking `OP_1` of the parsing transaction is what
/// remains on the stack.
pub fn parse_bytecode(segments: &[FieldWidth]) -> Result<Vec<u8>, AuthorError> {
    if segments.is_empty() {
        return Err(AuthorError::new(
            ErrorField::NftBytecode,
            "Parse layout must have at least a type segment.",
        ));
    }
    let mut fixed_total = 0usize;
    let mut out = vec![OP_0, OP_UTXOTOKENCOMMITMENT];
    for (index, segment) in segments.iter().enumerate() {
        let last = index + 1 == segments.len();
        match segment {
            FieldWidth::Fixed(0) => {
                return Err(AuthorError::new(
                    ErrorField::NftBytecode,
                    "Parse layout segments must be at least one byte wide.",
                ))
            }
            FieldWidth::Fixed(width) => {
                fixed_total += usize::from(*width);
                out.extend(push_small_number(*width));
                out.extend([OP_SPLIT, OP_SWAP, OP_TOALTSTACK]);
            }
            FieldWidth::Rest if !last => {
                return Err(AuthorError::new(
                    ErrorField::NftBytecode,
                    "Only the last parse layout segment can take the remaining bytes.",
                ))
            }
            FieldWidth::Rest => out.push(OP_TOALTSTACK),
        }
    }
    if fixed_total > MAX_COMMITMENT_LENGTH {
        return Err(AuthorError::new(
            ErrorField::NftBytecode,
            format!(
                "Parse layout needs {fixed_total} bytes; NFT commitments hold at most {MAX_COMMITMENT_LENGTH}."
            ),
        ));
    }
    if segments.last() != Some(&FieldWidth::Rest) {
        out.extend([OP_0, OP_EQUALVERIFY]);
    }
    Ok(out)
}

/// The shortest push of a small positive number: `OP_1`..`OP_16`, else data.
fn push_small_number(value: u8) -> Vec<u8> {
    if (1..=16).contains(&value) {
        return vec![OP_1 + value - 1];
    }
    let bytes = vm_number(u64::from(value));
    let mut out = vec![bytes.len() as u8];
    out.extend(bytes);
    out
}

/// Whether `symbol` is a valid ticker: capitals, digits and inner dashes.
///
/// The JSON Schema only documents this rule in prose, so no validator checks
/// it; an empty or lowercase symbol passes every schema tool and still breaks
/// the specification.
pub fn validate_symbol(symbol: &str) -> Result<(), AuthorError> {
    let valid = symbol
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_uppercase() || first.is_ascii_digit())
        && symbol
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(AuthorError::new(
            ErrorField::Symbol,
            "Token symbol must use capital letters, digits and dashes, and start with a letter or digit.",
        ))
    }
}

/// A default name and symbol derived from the token's category.
///
/// Derived rather than generic so no two tokens share one: every token named
/// "My Token" would be indistinguishable in a wallet list, and the
/// specification asks for base symbols to be unique among unrelated assets.
/// The symbol is six characters, inside both the recommended range for
/// fungible tokens (4 to 6) and for NFT collections (6 to 13).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SuggestedIdentity {
    pub name: String,
    pub symbol: String,
}

pub fn suggest_identity(category: &str, has_nfts: bool) -> Result<SuggestedIdentity, AuthorError> {
    let category = normalize_txid(category, ErrorField::Category, "Token category")?;
    let noun = if has_nfts { "Collection" } else { "Token" };
    Ok(SuggestedIdentity {
        name: format!("{noun} {}", &category[..6]),
        symbol: format!("T{}", category[..5].to_ascii_uppercase()),
    })
}

/// The IPFS CID of content whose SHA-256 is `digest`.
///
/// CIDv1, `raw` codec, SHA-256 multihash, base32. For content that fits one
/// IPFS block (256 KiB; registries are a few KiB) this is the CID IPFS assigns
/// when the file is added with `cid-version=1`, so the link can be written on
/// chain before, or without, any upload — and anyone holding the file can pin
/// it again later and the same link resolves.
pub fn ipfs_raw_cid(digest: &[u8; 32]) -> String {
    let mut bytes = vec![0x01, 0x55, 0x12, 0x20];
    bytes.extend_from_slice(digest);
    format!("b{}", base32_lower(&bytes))
}

/// RFC 4648 base32, lowercase, unpadded: the multibase `b` alphabet.
fn base32_lower(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Which input a rejection is about, so the wallet can put the message next
/// to the right field. Serialized with the wallet's own field names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorField {
    #[serde(rename = "tokenCategory")]
    Category,
    #[serde(rename = "tokenName")]
    Name,
    #[serde(rename = "tokenSymbol")]
    Symbol,
    #[serde(rename = "tokenDecimals")]
    Decimals,
    #[serde(rename = "iconUri")]
    IconUri,
    #[serde(rename = "webUri")]
    WebUri,
    #[serde(rename = "nftBytecode")]
    NftBytecode,
    #[serde(rename = "nftTypes")]
    NftTypes,
    #[serde(rename = "nftFields")]
    NftFields,
    #[serde(rename = "registry")]
    Registry,
    #[serde(rename = "general")]
    General,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuthorError {
    pub field: ErrorField,
    pub message: String,
}

impl AuthorError {
    fn new(field: ErrorField, message: impl Into<String>) -> Self {
        Self {
            field,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AuthorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AuthorError {}

/// What the wallet wants published, before defaults are applied.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorRequest {
    /// `mainnet`, `chipnet` or `regtest`.
    pub network: String,
    /// Timestamp of the new snapshot, `YYYY-MM-DDTHH:mm:ss.sssZ`. Passed in
    /// rather than read from a clock so the same request always produces the
    /// same bytes, and therefore the same hash.
    pub revision: String,
    /// The identity's current registry, if it already has one.
    #[serde(default)]
    pub base_registry: Option<String>,
    pub identity: IdentityDraft,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityDraft {
    pub authbase: String,
    pub category: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub symbol: String,
    #[serde(default)]
    pub decimals: u32,
    #[serde(default)]
    pub icon_uri: String,
    #[serde(default)]
    pub web_uri: String,
    /// Present exactly when the category will hold NFTs.
    #[serde(default)]
    pub nfts: Option<NftDraft>,
}

/// How the category's NFT commitments are read.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NftDraft {
    /// Commitments carry fields read by a parse bytecode. Omitting `bytecode`,
    /// `fields` and `types` selects the default type-and-serial layout.
    Parsable {
        #[serde(default)]
        description: String,
        #[serde(default)]
        bytecode: Option<String>,
        #[serde(default)]
        fields: Option<Map<String, Value>>,
        #[serde(default)]
        types: Option<Map<String, Value>>,
    },
    /// Each commitment is itself the NFT's type key, normally a VM number.
    Sequential {
        #[serde(default)]
        description: String,
        #[serde(default)]
        types: Map<String, Value>,
    },
}

/// A registry ready to publish, and how to find it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authored {
    /// The exact bytes to upload and hash. Any re-serialization changes the
    /// hash, so this string is what gets published, not a parsed copy of it.
    pub registry_json: String,
    /// SHA-256 of `registry_json`, hex, in the byte order the publication
    /// output commits to.
    pub sha256: String,
    pub ipfs_cid: String,
    pub ipfs_uri: String,
}

#[derive(Serialize)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

#[derive(Serialize)]
struct NftsOut {
    description: String,
    fields: Map<String, Value>,
    parse: ParseOut,
}

#[derive(Serialize)]
struct ParseOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    bytecode: Option<String>,
    types: Map<String, Value>,
}

#[derive(Serialize)]
struct TokenOut {
    category: String,
    symbol: String,
    decimals: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    nfts: Option<NftsOut>,
}

#[derive(Serialize)]
struct SnapshotOut {
    name: String,
    description: String,
    status: &'static str,
    #[serde(rename = "splitId")]
    split_id: &'static str,
    tags: Vec<String>,
    uris: BTreeMap<String, String>,
    extensions: Map<String, Value>,
    token: TokenOut,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Snapshot {
    Authored(Box<SnapshotOut>),
    Existing(Value),
}

/// Snapshots newest first, as the specification recommends for exported
/// registries.
struct IdentityHistory(Vec<(String, Snapshot)>);

impl Serialize for IdentityHistory {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (timestamp, snapshot) in &self.0 {
            map.serialize_entry(timestamp, snapshot)?;
        }
        map.end()
    }
}

/// The registry, keys in the order the specification introduces them, with
/// anything else the base registry carried (a license, locales) kept after.
struct RegistryOut {
    version: Version,
    latest_revision: String,
    registry_identity: Value,
    default_chain: String,
    chains: Value,
    identities: BTreeMap<String, IdentityHistory>,
    tags: Value,
    extensions: Value,
    other: Map<String, Value>,
}

impl Serialize for RegistryOut {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("$schema", SCHEMA_URI)?;
        map.serialize_entry("version", &self.version)?;
        map.serialize_entry("latestRevision", &self.latest_revision)?;
        map.serialize_entry("registryIdentity", &self.registry_identity)?;
        map.serialize_entry("defaultChain", &self.default_chain)?;
        map.serialize_entry("chains", &self.chains)?;
        map.serialize_entry("identities", &self.identities)?;
        map.serialize_entry("tags", &self.tags)?;
        map.serialize_entry("extensions", &self.extensions)?;
        for (key, value) in &self.other {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// Keys `RegistryOut` writes itself; everything else in a base is carried.
const REGISTRY_KEYS: [&str; 9] = [
    "$schema",
    "version",
    "latestRevision",
    "registryIdentity",
    "defaultChain",
    "chains",
    "identities",
    "tags",
    "extensions",
];

/// Build the registry to publish for `request`.
pub fn author_registry(request: &AuthorRequest) -> Result<Authored, AuthorError> {
    let network: Network = request
        .network
        .parse()
        .map_err(|message: String| AuthorError::new(ErrorField::General, message))?;
    let revision = validate_revision(&request.revision)?;
    let draft = &request.identity;
    let authbase = normalize_txid(&draft.authbase, ErrorField::General, "Authbase")?;
    let category = normalize_txid(&draft.category, ErrorField::Category, "Token category")?;
    let name = draft.name.trim();
    if name.is_empty() {
        return Err(AuthorError::new(
            ErrorField::Name,
            "Token name is required.",
        ));
    }
    let symbol = draft.symbol.trim();
    validate_symbol(symbol)?;
    if draft.decimals > 18 {
        return Err(AuthorError::new(
            ErrorField::Decimals,
            "Token decimals must be between 0 and 18.",
        ));
    }

    let mut uris = BTreeMap::new();
    let icon = draft.icon_uri.trim();
    if !icon.is_empty() {
        require_scheme(
            icon,
            &["ipfs://", "https://", "http://"],
            ErrorField::IconUri,
            "Icon URI",
        )?;
        uris.insert("icon".to_owned(), icon.to_owned());
    }
    let web = draft.web_uri.trim();
    if !web.is_empty() {
        require_scheme(
            web,
            &["https://", "http://"],
            ErrorField::WebUri,
            "Official site",
        )?;
        uris.insert("web".to_owned(), web.to_owned());
    }

    let base = match &request.base_registry {
        Some(json) if !json.trim().is_empty() => Some(parse_base(json)?),
        _ => None,
    };
    let base_history = base
        .as_ref()
        .and_then(|b| b.get("identities"))
        .and_then(|ids| ids.get(&authbase))
        .and_then(Value::as_object);
    if let Some(history) = base_history {
        if let Some(latest) = history.keys().max() {
            if revision.as_str() <= latest.as_str() {
                return Err(AuthorError::new(
                    ErrorField::Registry,
                    format!(
                        "Registry revision {revision} is not newer than the identity's latest snapshot {latest}."
                    ),
                ));
            }
        }
    }
    let previous_nfts = base_history
        .and_then(|history| history.iter().max_by(|a, b| a.0.cmp(b.0)))
        .and_then(|(_, snapshot)| snapshot.get("token"))
        .and_then(|token| token.get("nfts"));

    let nfts = match &draft.nfts {
        None => None,
        Some(nft_draft) => Some(build_nfts(nft_draft, name, previous_nfts)?),
    };

    let snapshot = SnapshotOut {
        name: name.to_owned(),
        description: draft.description.trim().to_owned(),
        status: "active",
        split_id: split_id(network),
        tags: Vec::new(),
        uris,
        extensions: Map::new(),
        token: TokenOut {
            category,
            symbol: symbol.to_owned(),
            decimals: draft.decimals,
            nfts,
        },
    };

    let registry = assemble(base, authbase, revision, network, snapshot)?;
    let registry_json = serde_json::to_string_pretty(&registry).map_err(|e| {
        AuthorError::new(
            ErrorField::General,
            format!("Could not serialize registry: {e}"),
        )
    })?;
    let digest: [u8; 32] = Sha256::digest(registry_json.as_bytes()).into();
    let ipfs_cid = ipfs_raw_cid(&digest);
    Ok(Authored {
        sha256: digest.iter().map(|b| format!("{b:02x}")).collect(),
        ipfs_uri: format!("ipfs://{ipfs_cid}"),
        ipfs_cid,
        registry_json,
    })
}

fn assemble(
    base: Option<Value>,
    authbase: String,
    revision: String,
    network: Network,
    snapshot: SnapshotOut,
) -> Result<RegistryOut, AuthorError> {
    let mut base = match base {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let version = match base.get("version") {
        Some(existing) => {
            let part = |key: &str| existing.get(key).and_then(Value::as_u64).unwrap_or(0);
            // A new snapshot is a minor change by the specification's rules.
            Version {
                major: part("major"),
                minor: part("minor") + 1,
                patch: 0,
            }
        }
        None => Version {
            major: 0,
            minor: 1,
            patch: 0,
        },
    };

    let mut identities: BTreeMap<String, IdentityHistory> = BTreeMap::new();
    if let Some(Value::Object(existing)) = base.remove("identities") {
        for (id, history) in existing {
            let Value::Object(snapshots) = history else {
                return Err(AuthorError::new(
                    ErrorField::Registry,
                    format!("Existing registry identity {id} is not a snapshot map."),
                ));
            };
            let entries = snapshots
                .into_iter()
                .map(|(timestamp, value)| (timestamp, Snapshot::Existing(value)))
                .collect();
            identities.insert(id, IdentityHistory(entries));
        }
    }
    let history = identities
        .entry(authbase.clone())
        .or_insert_with(|| IdentityHistory(Vec::new()));
    history
        .0
        .push((revision.clone(), Snapshot::Authored(Box::new(snapshot))));
    for history in identities.values_mut() {
        history.0.sort_by(|a, b| b.0.cmp(&a.0));
    }

    let take_object = |base: &mut Map<String, Value>, key: &str| match base.remove(key) {
        Some(value @ Value::Object(_)) => value,
        _ => Value::Object(Map::new()),
    };
    let chains = take_object(&mut base, "chains");
    let tags = take_object(&mut base, "tags");
    let extensions = take_object(&mut base, "extensions");
    let registry_identity = base
        .remove("registryIdentity")
        .unwrap_or_else(|| Value::String(authbase.clone()));
    let default_chain = match base.remove("defaultChain") {
        Some(Value::String(existing)) => existing,
        _ => split_id(network).to_owned(),
    };
    for key in REGISTRY_KEYS {
        base.remove(key);
    }

    Ok(RegistryOut {
        version,
        latest_revision: revision,
        registry_identity,
        default_chain,
        chains,
        identities,
        tags,
        extensions,
        other: base,
    })
}

fn build_nfts(
    draft: &NftDraft,
    collection_name: &str,
    previous: Option<&Value>,
) -> Result<NftsOut, AuthorError> {
    let (description, bytecode, mut fields, mut types) = match draft {
        NftDraft::Parsable {
            description,
            bytecode,
            fields,
            types,
        } => {
            let bytecode = match bytecode.as_deref().map(str::trim) {
                None => DEFAULT_PARSE_BYTECODE.to_owned(),
                Some("") => {
                    return Err(AuthorError::new(
                        ErrorField::NftBytecode,
                        "Parse bytecode cannot be empty: an empty bytecode makes every NFT unparsable. Choose sequential instead.",
                    ))
                }
                Some(hex) => normalize_hex(hex, ErrorField::NftBytecode, "Parse bytecode")?,
            };
            let custom = bytecode != DEFAULT_PARSE_BYTECODE;
            let fields = match fields {
                Some(fields) => fields.clone(),
                None if custom => Map::new(),
                None => default_fields(),
            };
            let types = match types {
                Some(types) => types.clone(),
                None if custom => {
                    return Err(AuthorError::new(
                        ErrorField::NftTypes,
                        "NFT types are required with a custom parse bytecode.",
                    ))
                }
                None => default_types(collection_name),
            };
            (description, Some(bytecode), fields, types)
        }
        NftDraft::Sequential { description, types } => {
            (description, None, Map::new(), types.clone())
        }
    };

    // Carry forward the types and fields a previous snapshot defined, but only
    // for the same layout: types keyed under another bytecode describe
    // different commitments.
    if let Some(previous) = previous {
        let previous_bytecode = previous
            .get("parse")
            .and_then(|parse| parse.get("bytecode"))
            .and_then(Value::as_str);
        if previous_bytecode == bytecode.as_deref() {
            merge_missing(
                &mut types,
                previous.get("parse").and_then(|p| p.get("types")),
            );
            merge_missing(&mut fields, previous.get("fields"));
        }
    }

    validate_fields(&fields)?;
    validate_types(&types, &fields)?;
    Ok(NftsOut {
        description: description.trim().to_owned(),
        fields,
        parse: ParseOut { bytecode, types },
    })
}

fn merge_missing(into: &mut Map<String, Value>, from: Option<&Value>) {
    if let Some(Value::Object(from)) = from {
        for (key, value) in from {
            into.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
}

fn default_fields() -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert(
        DEFAULT_SERIAL_FIELD.to_owned(),
        serde_json::json!({
            "name": "Serial",
            "description": "Number of this NFT within the collection.",
            "encoding": { "type": "number" }
        }),
    );
    fields
}

fn default_types(collection_name: &str) -> Map<String, Value> {
    let mut types = Map::new();
    types.insert(
        DEFAULT_NFT_TYPE_KEY.to_owned(),
        serde_json::json!({
            "name": collection_name,
            "description": "",
            "fields": [DEFAULT_SERIAL_FIELD]
        }),
    );
    types
}

/// Keys the specification defines on an NFT field and on an NFT type.
///
/// Anything else is refused rather than carried: a stray key is published
/// forever under a hash, and schema validators that forbid additional
/// properties would then reject the whole registry.
const NFT_FIELD_KEYS: [&str; 5] = ["name", "description", "encoding", "uris", "extensions"];
const NFT_TYPE_KEYS: [&str; 5] = ["name", "description", "fields", "uris", "extensions"];

/// The first key of `object` outside `allowed`, if any.
fn unknown_key<'a>(object: &'a Map<String, Value>, allowed: &[&str]) -> Option<&'a str> {
    object
        .keys()
        .map(String::as_str)
        .find(|key| !allowed.contains(key))
}

fn validate_fields(fields: &Map<String, Value>) -> Result<(), AuthorError> {
    for (id, field) in fields {
        let fail = |message: String| Err(AuthorError::new(ErrorField::NftFields, message));
        if id.trim().is_empty() {
            return fail("NFT field identifiers cannot be empty.".to_owned());
        }
        let Some(field) = field.as_object() else {
            return fail(format!("NFT field \"{id}\" must be an object."));
        };
        if let Some(key) = unknown_key(field, &NFT_FIELD_KEYS) {
            return fail(format!("NFT field \"{id}\" has an unknown key \"{key}\"."));
        }
        let Some(encoding) = field.get("encoding").and_then(Value::as_object) else {
            return fail(format!("NFT field \"{id}\" needs an encoding."));
        };
        let kind = encoding.get("type").and_then(Value::as_str).unwrap_or("");
        if !NFT_FIELD_ENCODINGS.contains(&kind) {
            return fail(format!(
                "NFT field \"{id}\" has an unsupported encoding type \"{kind}\"."
            ));
        }
        let encoding_keys: &[&str] = if kind == "number" {
            &["type", "aggregate", "decimals", "unit"]
        } else {
            &["type"]
        };
        if let Some(key) = unknown_key(encoding, encoding_keys) {
            return fail(format!(
                "NFT field \"{id}\" encoding has an unknown key \"{key}\"."
            ));
        }
        if kind == "number" {
            if let Some(decimals) = encoding.get("decimals") {
                if !decimals.as_u64().is_some_and(|d| d <= 18) {
                    return fail(format!(
                        "NFT field \"{id}\" decimals must be an integer between 0 and 18."
                    ));
                }
            }
            if let Some(aggregate) = encoding.get("aggregate") {
                if aggregate.as_str() != Some("add") {
                    return fail(format!("NFT field \"{id}\" aggregate must be \"add\"."));
                }
            }
        }
    }
    Ok(())
}

fn validate_types(
    types: &Map<String, Value>,
    fields: &Map<String, Value>,
) -> Result<(), AuthorError> {
    for (key, nft_type) in types {
        let fail = |message: String| Err(AuthorError::new(ErrorField::NftTypes, message));
        if !key.len().is_multiple_of(2) || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return fail(format!("NFT type key \"{key}\" must be even-length hex."));
        }
        if key.bytes().any(|b| b.is_ascii_uppercase()) {
            return fail(format!("NFT type key \"{key}\" must be lowercase hex."));
        }
        let Some(object) = nft_type.as_object() else {
            return fail(format!("NFT type \"{key}\" must be an object."));
        };
        if let Some(unknown) = unknown_key(object, &NFT_TYPE_KEYS) {
            return fail(format!(
                "NFT type \"{key}\" has an unknown key \"{unknown}\"."
            ));
        }
        let named = nft_type
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty());
        if !named {
            return fail(format!("NFT type \"{key}\" needs a name."));
        }
        if let Some(referenced) = nft_type.get("fields") {
            let Some(list) = referenced.as_array() else {
                return fail(format!("NFT type \"{key}\" fields must be a list."));
            };
            for field in list {
                let known = field.as_str().is_some_and(|id| fields.contains_key(id));
                if !known {
                    return fail(format!(
                        "NFT type \"{key}\" refers to a field that is not defined: {field}."
                    ));
                }
            }
        }
    }
    Ok(())
}

fn parse_base(json: &str) -> Result<Value, AuthorError> {
    let value: Value = serde_json::from_str(json).map_err(|e| {
        AuthorError::new(
            ErrorField::Registry,
            format!("Existing registry is not valid JSON: {e}"),
        )
    })?;
    if !value.is_object() {
        return Err(AuthorError::new(
            ErrorField::Registry,
            "Existing registry must be a JSON object.",
        ));
    }
    Ok(value)
}

fn validate_revision(revision: &str) -> Result<String, AuthorError> {
    let bytes = revision.as_bytes();
    let digit_at = |i: usize| bytes.get(i).is_some_and(u8::is_ascii_digit);
    let shape = bytes.len() == 24
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22]
            .iter()
            .all(|&i| digit_at(i))
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z';
    if shape {
        Ok(revision.to_owned())
    } else {
        Err(AuthorError::new(
            ErrorField::Registry,
            "Registry revision must be an ISO timestamp like 2026-01-01T00:00:00.000Z.",
        ))
    }
}

fn normalize_txid(value: &str, field: ErrorField, label: &str) -> Result<String, AuthorError> {
    let out = value.trim().to_ascii_lowercase();
    if out.len() == 64 && out.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(out)
    } else {
        Err(AuthorError::new(
            field,
            format!("{label} must be 64 hex characters."),
        ))
    }
}

fn normalize_hex(value: &str, field: ErrorField, label: &str) -> Result<String, AuthorError> {
    let out = value.trim().to_ascii_lowercase();
    if out.len().is_multiple_of(2) && out.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(out)
    } else {
        Err(AuthorError::new(
            field,
            format!("{label} must be even-length hex."),
        ))
    }
}

fn require_scheme(
    value: &str,
    schemes: &[&str],
    field: ErrorField,
    label: &str,
) -> Result<(), AuthorError> {
    let lower = value.to_ascii_lowercase();
    if schemes
        .iter()
        .any(|scheme| lower.starts_with(scheme) && lower.len() > scheme.len())
    {
        Ok(())
    } else {
        Err(AuthorError::new(
            field,
            format!("{label} must start with {}.", schemes.join(" or ")),
        ))
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATEGORY: &str = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
    const REVISION: &str = "2026-09-25T12:00:00.000Z";

    fn request(nfts: Option<NftDraft>) -> AuthorRequest {
        AuthorRequest {
            network: "chipnet".to_owned(),
            revision: REVISION.to_owned(),
            base_registry: None,
            identity: IdentityDraft {
                authbase: CATEGORY.to_owned(),
                category: CATEGORY.to_owned(),
                name: "Token ab12cd".to_owned(),
                description: String::new(),
                symbol: "TAB12C".to_owned(),
                decimals: 0,
                icon_uri: String::new(),
                web_uri: String::new(),
                nfts,
            },
        }
    }

    fn parsable_default() -> NftDraft {
        NftDraft::Parsable {
            description: String::new(),
            bytecode: None,
            fields: None,
            types: None,
        }
    }

    fn parsed(authored: &Authored) -> Value {
        serde_json::from_str(&authored.registry_json).unwrap()
    }

    #[test]
    fn vm_numbers_are_minimal_and_positive() {
        // The encoding table every sequential collection depends on. 128 and
        // 255 are where hand-built keys usually go wrong.
        let cases: [(u64, &str); 10] = [
            (0, ""),
            (1, "01"),
            (127, "7f"),
            (128, "8000"),
            (200, "c800"),
            (255, "ff00"),
            (256, "0001"),
            (300, "2c01"),
            (32767, "ff7f"),
            (32768, "008000"),
        ];
        for (value, hex) in cases {
            assert_eq!(to_hex(&vm_number(value)), hex, "vm_number({value})");
            assert_eq!(to_hex(&sequential_commitment(value)), hex);
        }
        assert_eq!(to_hex(&parsable_commitment(0, 128)), "008000");
        assert_eq!(to_hex(&parsable_commitment(1, 0)), "01");
    }

    #[test]
    fn default_bytecode_is_type_then_serial() {
        let generated = parse_bytecode(&[FieldWidth::Fixed(1), FieldWidth::Rest]).unwrap();
        assert_eq!(to_hex(&generated), DEFAULT_PARSE_BYTECODE);
    }

    #[test]
    fn bytecode_matches_the_hand_checked_example_layout() {
        // type 1, serial 2, amount 4, active 1, deadline 4, flags 4, raw 4,
        // link 20, image CID 34, then a label taking the rest. Verified by
        // evaluating it in the BCH 2026 VM against a commitment with those
        // offsets.
        let layout = [
            FieldWidth::Fixed(1),
            FieldWidth::Fixed(2),
            FieldWidth::Fixed(4),
            FieldWidth::Fixed(1),
            FieldWidth::Fixed(4),
            FieldWidth::Fixed(4),
            FieldWidth::Fixed(4),
            FieldWidth::Fixed(20),
            FieldWidth::Fixed(34),
            FieldWidth::Rest,
        ];
        assert_eq!(
            to_hex(&parse_bytecode(&layout).unwrap()),
            "00cf517f7c6b527f7c6b547f7c6b517f7c6b547f7c6b547f7c6b547f7c6b01147f7c6b01227f7c6b6b"
        );
    }

    #[test]
    fn a_fixed_final_segment_requires_nothing_left_over() {
        let generated = parse_bytecode(&[FieldWidth::Fixed(1), FieldWidth::Fixed(2)]).unwrap();
        assert_eq!(to_hex(&generated), "00cf517f7c6b527f7c6b0088");
    }

    #[test]
    fn widths_above_sixteen_are_data_pushes() {
        assert_eq!(push_small_number(16), vec![0x60]);
        assert_eq!(push_small_number(17), vec![0x01, 0x11]);
        assert_eq!(push_small_number(127), vec![0x01, 0x7f]);
        assert_eq!(push_small_number(128), vec![0x02, 0x80, 0x00]);
    }

    #[test]
    fn broken_layouts_are_refused() {
        assert!(parse_bytecode(&[]).is_err());
        assert!(parse_bytecode(&[FieldWidth::Fixed(0)]).is_err());
        assert!(parse_bytecode(&[FieldWidth::Rest, FieldWidth::Fixed(1)]).is_err());
        assert!(parse_bytecode(&[FieldWidth::Fixed(100), FieldWidth::Fixed(29)]).is_err());
    }

    #[test]
    fn symbols_follow_the_specification() {
        for good in ["BCH", "TAB12C", "XAMPL-A", "1INCH", "A-B-C"] {
            assert!(validate_symbol(good).is_ok(), "{good}");
        }
        for bad in ["", "bch", "-BCH", "BC H", "BCH!", "ÄBC"] {
            let err = validate_symbol(bad).unwrap_err();
            assert_eq!(err.field, ErrorField::Symbol, "{bad}");
        }
    }

    #[test]
    fn suggestions_come_from_the_category() {
        let token = suggest_identity(CATEGORY, false).unwrap();
        assert_eq!(token.name, "Token ab12cd");
        assert_eq!(token.symbol, "TAB12C");
        assert!(validate_symbol(&token.symbol).is_ok());
        assert_eq!(
            suggest_identity(CATEGORY, true).unwrap().name,
            "Collection ab12cd"
        );
        assert!(suggest_identity("nope", false).is_err());
    }

    #[test]
    fn raw_cid_matches_the_ipfs_library() {
        // Reference computed with the `multiformats` package:
        // CID.create(1, raw.code, sha256.digest(bytes)).
        let content = r#"{"version":{"major":0,"minor":1,"patch":0},"latestRevision":"2026-09-25T00:00:00.000Z"}"#;
        let digest: [u8; 32] = Sha256::digest(content.as_bytes()).into();
        assert_eq!(
            to_hex(&digest),
            "1a6984c7feeb3ca0ca27e0f9da7d66cf6e0cccaec61a011851a540a7f6a7dce0"
        );
        assert_eq!(
            ipfs_raw_cid(&digest),
            "bafkreia2ngcmp7xlhsqmuj7a7hnh2zwpnygmzlwgdiarqunfict7nj644a"
        );
    }

    #[test]
    fn fungible_registry_has_the_full_skeleton_and_no_nfts() {
        let authored = author_registry(&request(None)).unwrap();
        let registry = parsed(&authored);
        assert_eq!(registry["$schema"], SCHEMA_URI);
        assert_eq!(
            registry["version"],
            serde_json::json!({"major": 0, "minor": 1, "patch": 0})
        );
        assert_eq!(registry["latestRevision"], REVISION);
        assert_eq!(registry["registryIdentity"], CATEGORY);
        assert_eq!(registry["defaultChain"], SPLIT_ID_CHIPNET);
        assert_eq!(registry["chains"], serde_json::json!({}));
        assert_eq!(registry["tags"], serde_json::json!({}));
        assert_eq!(registry["extensions"], serde_json::json!({}));
        let snapshot = &registry["identities"][CATEGORY][REVISION];
        assert_eq!(snapshot["name"], "Token ab12cd");
        assert_eq!(snapshot["description"], "");
        assert_eq!(snapshot["status"], "active");
        assert_eq!(snapshot["splitId"], SPLIT_ID_CHIPNET);
        assert_eq!(snapshot["tags"], serde_json::json!([]));
        assert_eq!(snapshot["uris"], serde_json::json!({}));
        assert_eq!(snapshot["extensions"], serde_json::json!({}));
        assert_eq!(snapshot["token"]["category"], CATEGORY);
        assert_eq!(snapshot["token"]["symbol"], "TAB12C");
        assert_eq!(snapshot["token"]["decimals"], 0);
        assert!(snapshot["token"].get("nfts").is_none());
        assert!(snapshot.get("migrated").is_none());
        assert!(registry.get("locales").is_none());

        // Key order is fixed, so every published registry reads the same way.
        let json = &authored.registry_json;
        let order = [
            "\"$schema\"",
            "\"version\"",
            "\"latestRevision\"",
            "\"registryIdentity\"",
            "\"defaultChain\"",
            "\"chains\"",
            "\"identities\"",
            "\"tags\"",
            "\"extensions\"",
        ];
        let positions: Vec<usize> = order.iter().map(|k| json.find(k).unwrap()).collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]), "{positions:?}");

        let digest: [u8; 32] = Sha256::digest(json.as_bytes()).into();
        assert_eq!(authored.sha256, to_hex(&digest));
        assert_eq!(authored.ipfs_cid, ipfs_raw_cid(&digest));
        assert_eq!(authored.ipfs_uri, format!("ipfs://{}", authored.ipfs_cid));
    }

    #[test]
    fn same_request_same_bytes() {
        let a = author_registry(&request(Some(parsable_default()))).unwrap();
        let b = author_registry(&request(Some(parsable_default()))).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn parsable_is_prefilled_with_a_working_layout() {
        let registry = parsed(&author_registry(&request(Some(parsable_default()))).unwrap());
        let nfts = &registry["identities"][CATEGORY][REVISION]["token"]["nfts"];
        assert_eq!(nfts["parse"]["bytecode"], DEFAULT_PARSE_BYTECODE);
        assert_eq!(nfts["parse"]["types"]["00"]["name"], "Token ab12cd");
        assert_eq!(
            nfts["parse"]["types"]["00"]["fields"],
            serde_json::json!(["serial"])
        );
        assert_eq!(nfts["fields"]["serial"]["encoding"]["type"], "number");
        assert_eq!(nfts["description"], "");
    }

    #[test]
    fn sequential_has_no_bytecode_at_all() {
        let mut types = Map::new();
        types.insert("01".to_owned(), serde_json::json!({"name": "#1"}));
        types.insert("8000".to_owned(), serde_json::json!({"name": "#128"}));
        let draft = NftDraft::Sequential {
            description: String::new(),
            types,
        };
        let registry = parsed(&author_registry(&request(Some(draft))).unwrap());
        let parse = &registry["identities"][CATEGORY][REVISION]["token"]["nfts"]["parse"];
        assert!(parse.get("bytecode").is_none());
        assert_eq!(parse["types"]["8000"]["name"], "#128");
    }

    #[test]
    fn an_empty_bytecode_is_refused_not_published() {
        let draft = NftDraft::Parsable {
            description: String::new(),
            bytecode: Some(String::new()),
            fields: None,
            types: None,
        };
        let err = author_registry(&request(Some(draft))).unwrap_err();
        assert_eq!(err.field, ErrorField::NftBytecode);
    }

    #[test]
    fn custom_layouts_must_describe_their_types_and_fields() {
        let draft = NftDraft::Parsable {
            description: String::new(),
            bytecode: Some("00cf527f7c6b6b".to_owned()),
            fields: None,
            types: None,
        };
        assert_eq!(
            author_registry(&request(Some(draft))).unwrap_err().field,
            ErrorField::NftTypes
        );

        let mut types = Map::new();
        types.insert(
            "00".to_owned(),
            serde_json::json!({"name": "A", "fields": ["missing"]}),
        );
        let draft = NftDraft::Parsable {
            description: String::new(),
            bytecode: Some("00cf527f7c6b6b".to_owned()),
            fields: None,
            types: Some(types),
        };
        assert_eq!(
            author_registry(&request(Some(draft))).unwrap_err().field,
            ErrorField::NftTypes
        );

        let mut fields = Map::new();
        fields.insert(
            "x".to_owned(),
            serde_json::json!({"encoding": {"type": "float"}}),
        );
        let draft = NftDraft::Parsable {
            description: String::new(),
            bytecode: None,
            fields: Some(fields),
            types: None,
        };
        assert_eq!(
            author_registry(&request(Some(draft))).unwrap_err().field,
            ErrorField::NftFields
        );
    }

    #[test]
    fn keys_outside_the_specification_are_refused() {
        let mut fields = Map::new();
        fields.insert(
            "serial".to_owned(),
            serde_json::json!({"encoding": {"type": "number"}, "offset": "1"}),
        );
        let draft = NftDraft::Parsable {
            description: String::new(),
            bytecode: None,
            fields: Some(fields),
            types: None,
        };
        assert_eq!(
            author_registry(&request(Some(draft))).unwrap_err().field,
            ErrorField::NftFields
        );

        let mut fields = Map::new();
        fields.insert(
            "flag".to_owned(),
            serde_json::json!({"encoding": {"type": "boolean", "decimals": 2}}),
        );
        let draft = NftDraft::Parsable {
            description: String::new(),
            bytecode: None,
            fields: Some(fields),
            types: None,
        };
        assert_eq!(
            author_registry(&request(Some(draft))).unwrap_err().field,
            ErrorField::NftFields
        );

        let mut types = Map::new();
        types.insert(
            "01".to_owned(),
            serde_json::json!({"name": "#1", "migrated": "x"}),
        );
        let draft = NftDraft::Sequential {
            description: String::new(),
            types,
        };
        assert_eq!(
            author_registry(&request(Some(draft))).unwrap_err().field,
            ErrorField::NftTypes
        );
    }

    #[test]
    fn bad_identity_input_names_the_field() {
        let mut r = request(None);
        r.identity.symbol = "bad".to_owned();
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::Symbol);

        let mut r = request(None);
        r.identity.name = "  ".to_owned();
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::Name);

        let mut r = request(None);
        r.identity.decimals = 19;
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::Decimals);

        let mut r = request(None);
        r.identity.category = "abc".to_owned();
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::Category);

        let mut r = request(None);
        r.identity.icon_uri = "icon.png".to_owned();
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::IconUri);

        let mut r = request(None);
        r.identity.web_uri = "ipfs://site".to_owned();
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::WebUri);

        let mut r = request(None);
        r.revision = "2026-09-25".to_owned();
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::Registry);

        let mut r = request(None);
        r.network = "dogecoin".to_owned();
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::General);
    }

    #[test]
    fn uris_keep_their_values() {
        let mut r = request(None);
        r.identity.icon_uri = "ipfs://bafkreiicon".to_owned();
        r.identity.web_uri = "https://example.com/".to_owned();
        let registry = parsed(&author_registry(&r).unwrap());
        let uris = &registry["identities"][CATEGORY][REVISION]["uris"];
        assert_eq!(uris["icon"], "ipfs://bafkreiicon");
        assert_eq!(uris["web"], "https://example.com/");
    }

    #[test]
    fn mainnet_names_mainnet() {
        let mut r = request(None);
        r.network = "mainnet".to_owned();
        let registry = parsed(&author_registry(&r).unwrap());
        assert_eq!(registry["defaultChain"], SPLIT_ID_MAINNET);
        assert_eq!(
            registry["identities"][CATEGORY][REVISION]["splitId"],
            SPLIT_ID_MAINNET
        );
    }

    #[test]
    fn a_base_registry_is_extended_not_replaced() {
        let other = "cd".repeat(32);
        let base = serde_json::json!({
            "$schema": SCHEMA_URI,
            "version": {"major": 2, "minor": 3, "patch": 4},
            "latestRevision": "2026-01-01T00:00:00.000Z",
            "registryIdentity": {"name": "Registry"},
            "license": "CC0-1.0",
            "identities": {
                CATEGORY: {
                    "2026-01-01T00:00:00.000Z": {
                        "name": "Old",
                        "token": {
                            "category": CATEGORY,
                            "symbol": "OLD",
                            "nfts": {
                                "fields": {"serial": {"encoding": {"type": "number"}}},
                                "parse": {
                                    "bytecode": DEFAULT_PARSE_BYTECODE,
                                    "types": {"01": {"name": "Older type", "fields": ["serial"]}}
                                }
                            }
                        }
                    }
                },
                other.clone(): {"2025-01-01T00:00:00.000Z": {"name": "Other"}}
            }
        });
        let mut r = request(Some(parsable_default()));
        r.base_registry = Some(base.to_string());
        let authored = author_registry(&r).unwrap();
        let registry = parsed(&authored);

        assert_eq!(
            registry["version"],
            serde_json::json!({"major": 2, "minor": 4, "patch": 0})
        );
        assert_eq!(
            registry["registryIdentity"],
            serde_json::json!({"name": "Registry"})
        );
        assert_eq!(registry["license"], "CC0-1.0");
        assert_eq!(
            registry["identities"][other.as_str()]["2025-01-01T00:00:00.000Z"]["name"],
            "Other"
        );
        let history = &registry["identities"][CATEGORY];
        assert_eq!(history["2026-01-01T00:00:00.000Z"]["name"], "Old");
        let types = &history[REVISION]["token"]["nfts"]["parse"]["types"];
        assert_eq!(types["00"]["name"], "Token ab12cd");
        assert_eq!(types["01"]["name"], "Older type");

        // Newest snapshot first.
        let json = &authored.registry_json;
        assert!(json.find(REVISION).unwrap() < json.find("2026-01-01T00:00:00.000Z\": {").unwrap());
    }

    #[test]
    fn a_revision_must_move_forward() {
        let base = serde_json::json!({
            "version": {"major": 0, "minor": 1, "patch": 0},
            "latestRevision": "2027-01-01T00:00:00.000Z",
            "registryIdentity": CATEGORY,
            "identities": {CATEGORY: {"2027-01-01T00:00:00.000Z": {"name": "Future"}}}
        });
        let mut r = request(None);
        r.base_registry = Some(base.to_string());
        assert_eq!(author_registry(&r).unwrap_err().field, ErrorField::Registry);
    }

    #[test]
    fn requests_deserialize_from_the_wallet_shape() {
        let json = serde_json::json!({
            "network": "chipnet",
            "revision": REVISION,
            "identity": {
                "authbase": CATEGORY,
                "category": CATEGORY,
                "name": "Token ab12cd",
                "symbol": "TAB12C",
                "decimals": 2,
                "nfts": {"kind": "parsable"}
            }
        });
        let request: AuthorRequest = serde_json::from_value(json).unwrap();
        let registry = parsed(&author_registry(&request).unwrap());
        let token = &registry["identities"][CATEGORY][REVISION]["token"];
        assert_eq!(token["decimals"], 2);
        assert_eq!(token["nfts"]["parse"]["bytecode"], DEFAULT_PARSE_BYTECODE);

        let unknown = serde_json::json!({
            "network": "chipnet",
            "revision": REVISION,
            "identity": {"authbase": CATEGORY, "category": CATEGORY, "name": "A", "symbol": "A", "migrated": "x"}
        });
        assert!(serde_json::from_value::<AuthorRequest>(unknown).is_err());
    }
}

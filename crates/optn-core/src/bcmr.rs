//! CHIP-BCMR: what a token's identity is, and how to tell.
//!
//! A token category on its own is a 32-byte number. What makes it a *thing*
//! with a name, an icon and a supply is a metadata registry, and what makes a
//! registry authentic is a chain of transactions the identity's owner controls.
//!
//! The chain is simple and unforgiving. Output 0 of a transaction is its
//! **identity output**; a **zeroth-descendant transaction chain** is a run of
//! transactions where each spends the previous one's output 0. The first is the
//! **authbase** — for a token, the transaction that created the category. The
//! last, whose identity output nobody has spent, is the **authhead**, and only
//! the authhead speaks for the identity now.
//!
//! Two rules in here exist because getting them wrong is how a wallet shows a
//! confident lie:
//!
//! - An authhead with no publication output has no current metadata. It does
//!   **not** inherit its parent's. The specification is explicit that only the
//!   authhead's own outputs are examined, and an identity whose owner removed
//!   the publication is saying something by doing so.
//! - An authhead whose identity output starts with `OP_RETURN` is **burned**.
//!   Nobody can continue that chain, so the identity is finished rather than
//!   merely quiet, and that is a different thing to tell a holder.
//!
//! This module decides none of that from the network. It reads bytes and
//! reports what they say; finding the authhead, and judging how much a source's
//! word is worth, belongs to the runtime.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// `OP_RETURN` followed by a 4-byte push of `BCMR`.
///
/// The whole prefix is fixed, so a publication is recognisable without
/// parsing: `6a` `04` `42 43 4d 52`.
pub const PUBLICATION_PREFIX: [u8; 6] = [0x6a, 0x04, 0x42, 0x43, 0x4d, 0x52];

const OP_RETURN: u8 = 0x6a;
const OP_PUSHDATA1: u8 = 0x4c;
const OP_PUSHDATA2: u8 = 0x4d;
const OP_PUSHDATA4: u8 = 0x4e;

/// The path a bare authority resolves to, per the specification's
/// Well-Known URI rule.
pub const WELL_KNOWN_PATH: &str = "/.well-known/bitcoin-cash-metadata-registry.json";

/// A registry publication found in an authhead's outputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryPublication {
    /// SHA-256 of the registry contents, in `OP_SHA256` byte order.
    ///
    /// That is the digest as the hash function produces it, not the reversed
    /// order block explorers show. Reversing it here would make every
    /// verification fail against a registry that is perfectly valid.
    pub content_hash: [u8; 32],
    /// Where to fetch it. Several are alternatives, not a sequence.
    pub uris: Vec<String>,
}

impl RegistryPublication {
    /// The publication that would commit to `contents`.
    ///
    /// The one place the committed hash is computed, so a publisher, a
    /// verifier and a test cannot each pick a different digest.
    pub fn committing_to(contents: &[u8], uris: Vec<String>) -> Self {
        Self {
            content_hash: Sha256::digest(contents).into(),
            uris,
        }
    }

    /// Whether `contents` is the registry this publication commits to.
    ///
    /// Single SHA-256, because that is what the specification commits to.
    /// Using the double hash Bitcoin uses elsewhere would reject every real
    /// registry.
    pub fn matches(&self, contents: &[u8]) -> bool {
        let digest: [u8; 32] = Sha256::digest(contents).into();
        digest == self.content_hash
    }

    /// Turn one published URI into something fetchable.
    ///
    /// A bare authority means HTTPS at the Well-Known path; an authority with
    /// a path means HTTPS at that path. HTTPS authorities without a path also
    /// use the Well-Known path. Other schemes are returned untouched because deciding
    /// whether this client can reach them is the caller's job and not a
    /// property of the publication.
    pub fn resolve_uri(uri: &str) -> String {
        let authority_and_path = match uri.split_once("://") {
            Some((scheme, rest)) if scheme.eq_ignore_ascii_case("https") => rest,
            Some(_) => return uri.to_owned(),
            None => uri,
        };
        let suffix_at = authority_and_path
            .find(['?', '#'])
            .unwrap_or(authority_and_path.len());
        let (path, suffix) = authority_and_path.split_at(suffix_at);
        if path.contains('/') {
            format!("https://{authority_and_path}")
        } else {
            format!("https://{path}{WELL_KNOWN_PATH}{suffix}")
        }
    }
}

/// Why an identity chain stops here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IdentityOutputState {
    /// Spendable, so the chain can continue.
    Live,
    /// `OP_RETURN`: provably unspendable, so nobody can ever continue it.
    ///
    /// Recognising this locally matters. Without it a client asks the network
    /// "has anything spent this?", is told no, and cannot distinguish an
    /// identity that was deliberately ended from one whose successor it simply
    /// failed to find.
    Burned,
    /// There is no output 0 at all.
    Missing,
}

/// What the identity output of this transaction says about its future.
pub fn identity_output_state(output_zero_script: Option<&[u8]>) -> IdentityOutputState {
    match output_zero_script {
        None => IdentityOutputState::Missing,
        Some(script) if script.first() == Some(&OP_RETURN) => IdentityOutputState::Burned,
        Some(_) => IdentityOutputState::Live,
    }
}

/// Whether `candidate` continues the chain from `predecessor`.
///
/// Forward and unambiguous: the successor is whatever spends the predecessor's
/// output 0, whichever of its inputs does so. This is deliberately not the
/// backwards question — walking ancestry by picking an input that happens to
/// have `prevout_n == 0` guesses, because an ordinary transaction may spend
/// several outputs numbered zero from unrelated parents.
pub fn continues_authchain(candidate_inputs: &[([u8; 32], u32)], predecessor: [u8; 32]) -> bool {
    candidate_inputs
        .iter()
        .any(|(txid, vout)| *vout == 0 && *txid == predecessor)
}

/// Read a publication out of one output's locking script.
///
/// Returns `None` for anything that is not a BCMR publication, including an
/// `OP_RETURN` carrying some other protocol. A publication with no hash is not
/// a publication.
pub fn parse_publication(script: &[u8]) -> Option<RegistryPublication> {
    if script.len() < PUBLICATION_PREFIX.len() || script[..6] != PUBLICATION_PREFIX {
        return None;
    }
    let mut pos = PUBLICATION_PREFIX.len();
    let content_hash: [u8; 32] = read_push(script, &mut pos)?.try_into().ok()?;
    let mut uris = Vec::new();
    while pos < script.len() {
        let bytes = read_push(script, &mut pos)?;
        // A registry that cannot be named is better skipped than guessed at.
        uris.push(String::from_utf8(bytes.to_vec()).ok()?);
    }
    Some(RegistryPublication { content_hash, uris })
}

/// The first BCMR publication among a transaction's outputs.
///
/// Only this transaction's outputs are examined. An authhead that publishes
/// nothing has no current metadata, and reaching back to an ancestor for one
/// would present withdrawn metadata as though it were still endorsed.
/// The first matching prefix is definitive even when its payload is malformed;
/// later publication outputs cannot override it (CHIP-BCMR publication outputs).
pub fn publication_in<'a>(
    output_scripts: impl IntoIterator<Item = &'a [u8]>,
) -> Option<RegistryPublication> {
    output_scripts
        .into_iter()
        .find(|script| script.starts_with(&PUBLICATION_PREFIX))
        .and_then(parse_publication)
}

/// Bounded display data from authenticated registry bytes. URI strings are
/// references only, never permission to contact a remote service.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "serde_json::Value")]
pub struct TokenPresentation {
    pub description: Option<String>,
    pub uris: BTreeMap<String, String>,
    pub nfts: Option<NftCategory>,
}

/// BCMR's NFT schema, carried without interpreting its bytecode or commitments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NftCategory {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, NftField>>,
    pub parse: NftCollection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NftCollection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytecode: Option<String>,
    pub types: BTreeMap<String, NftType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NftType {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uris: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NftField {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub encoding: NftFieldEncoding,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uris: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum NftFieldEncoding {
    Binary,
    Boolean,
    Hex,
    HttpsUrl,
    IpfsCid,
    Utf8,
    Locktime,
    Number {
        #[serde(skip_serializing_if = "Option::is_none")]
        aggregate: Option<NftAggregate>,
        #[serde(skip_serializing_if = "Option::is_none")]
        decimals: Option<u8>,
        #[serde(skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NftAggregate {
    Add,
}

// ponytail: bounded schema projection only; add shared Rust VM evaluation when
// commitment-specific NFT rendering is implemented. Never evaluate in adapters.
const MAX_PRESENTATION_BYTES: usize = 64 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 4096;
const MAX_PRESENTATION_NODES: usize = 4096;

fn bounded_text(value: &str, limit: usize) -> bool {
    value.len() <= limit
        && value
            .chars()
            .all(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
}

fn bounded_description(value: Option<&str>) -> bool {
    value.is_none_or(|text| bounded_text(text, MAX_DESCRIPTION_BYTES))
}

fn bounded_uris(uris: &BTreeMap<String, String>) -> bool {
    uris.len() <= 16
        && uris.iter().all(|(key, uri)| {
            !key.is_empty()
                && key.len() <= 64
                && key
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && uri.len() <= 2048
                && !uri.chars().any(|c| {
                    c.is_control() || c.is_whitespace() || matches!(c, '\\' | '<' | '>' | '"')
                })
                && uri.split_once("://").is_some_and(|(scheme, rest)| {
                    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
                    (scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("ipfs"))
                        && !authority.is_empty()
                        && authority.bytes().any(|b| b.is_ascii_alphanumeric())
                        && authority.bytes().all(|b| {
                            b.is_ascii_alphanumeric()
                                || matches!(b, b'.' | b'-' | b':' | b'[' | b']')
                        })
                })
        })
}

fn bounded_hex(value: &str, limit: usize) -> bool {
    value.len() <= limit
        && value.len().is_multiple_of(2)
        && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Also bounds ignored/extension fields before typed decoding. No recursive
/// data from a registry or checkpoint can evade the depth/node/size budget.
fn bounded_presentation_json(value: &serde_json::Value) -> bool {
    fn visit(
        value: &serde_json::Value,
        depth: usize,
        nodes: &mut usize,
        bytes: &mut usize,
    ) -> bool {
        *nodes += 1;
        if depth > 12 || *nodes > MAX_PRESENTATION_NODES {
            return false;
        }
        let valid = match value {
            serde_json::Value::String(text) => {
                *bytes += text.len();
                true
            }
            serde_json::Value::Array(items) => {
                items.len() <= 256 && items.iter().all(|v| visit(v, depth + 1, nodes, bytes))
            }
            serde_json::Value::Object(items) => {
                items.len() <= 256
                    && items.iter().all(|(key, v)| {
                        *bytes += key.len();
                        key.len() <= 256 && visit(v, depth + 1, nodes, bytes)
                    })
            }
            _ => true,
        };
        valid && *bytes <= MAX_PRESENTATION_BYTES
    }
    visit(value, 0, &mut 0, &mut 0)
        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_PRESENTATION_BYTES)
}

impl TokenPresentation {
    /// Rechecked for in-process values as well as serde's untrusted inputs.
    pub fn is_valid(&self) -> bool {
        bounded_description(self.description.as_deref())
            && bounded_uris(&self.uris)
            && self.nfts.as_ref().is_none_or(NftCategory::is_valid)
            && serde_json::to_value(self).is_ok_and(|value| bounded_presentation_json(&value))
    }
}

impl TryFrom<serde_json::Value> for TokenPresentation {
    type Error = &'static str;

    fn try_from(value: serde_json::Value) -> Result<Self, Self::Error> {
        #[derive(Default, Deserialize)]
        #[serde(default)]
        struct Fields {
            description: Option<String>,
            uris: BTreeMap<String, String>,
            nfts: Option<NftCategory>,
        }
        if !value.is_object() || !bounded_presentation_json(&value) {
            return Err("token presentation exceeds structural or resource bounds");
        }
        let fields: Fields =
            serde_json::from_value(value).map_err(|_| "invalid token presentation schema")?;
        let presentation = Self {
            description: fields.description,
            uris: fields.uris,
            nfts: fields.nfts,
        };
        if !presentation.is_valid() {
            return Err("invalid or oversized token presentation");
        }
        Ok(presentation)
    }
}

impl NftCategory {
    fn is_valid(&self) -> bool {
        bounded_description(self.description.as_deref())
            && self
                .parse
                .bytecode
                .as_ref()
                .is_none_or(|code| bounded_hex(code, 20_000))
            && self.fields.as_ref().is_none_or(|fields| {
                fields.len() <= 64
                    && fields.iter().all(|(id, field)| {
                        !id.is_empty()
                            && bounded_text(id, 128)
                            && field
                                .name
                                .as_deref()
                                .is_none_or(|name| bounded_text(name, 512))
                            && bounded_description(field.description.as_deref())
                            && field.uris.as_ref().is_none_or(bounded_uris)
                            && match &field.encoding {
                                NftFieldEncoding::Number { decimals, unit, .. } => {
                                    decimals.is_none_or(|d| d <= 18)
                                        && unit.as_deref().is_none_or(|s| bounded_text(s, 64))
                                }
                                _ => true,
                            }
                    })
            })
            && self.parse.types.len() <= 256
            && self.parse.types.iter().all(|(id, nft)| {
                bounded_hex(id, 256)
                    && !nft.name.is_empty()
                    && bounded_text(&nft.name, 512)
                    && bounded_description(nft.description.as_deref())
                    && nft.uris.as_ref().is_none_or(bounded_uris)
                    && nft.fields.as_ref().is_none_or(|ids| {
                        ids.len() <= 64
                            && ids.iter().all(|id| {
                                self.parse.bytecode.is_some()
                                    && self
                                        .fields
                                        .as_ref()
                                        .is_some_and(|fields| fields.contains_key(id))
                            })
                    })
            })
    }
}

/// Name, ticker, decimals and display data taken from a hash-verified registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryNames {
    pub name: String,
    pub ticker: Option<String>,
    pub decimals: u8,
    pub presentation: TokenPresentation,
}

/// Parse the identity fields for `category_hex` from verified registry bytes.
///
/// Only call this on contents whose hash already matched a publication. A
/// registry that cannot name this category is not a name.
pub fn names_for_category(contents: &[u8], category_hex: &str) -> Option<RegistryNames> {
    let json: serde_json::Value = serde_json::from_slice(contents).ok()?;
    let identities = json.get("identities")?.as_object()?;
    let wanted = category_hex.to_ascii_lowercase();
    let mut best: Option<(u64, RegistryNames)> = None;
    for snapshots in identities.values() {
        let Some(obj) = snapshots.as_object() else {
            continue;
        };
        for (timestamp, snapshot) in obj {
            let token = match snapshot.get("token") {
                Some(token) => token,
                None => continue,
            };
            let category = match token.get("category").and_then(|value| value.as_str()) {
                Some(category) => category,
                None => continue,
            };
            if category.to_ascii_lowercase() != wanted {
                continue;
            }
            let name = match snapshot.get("name").and_then(|value| value.as_str()) {
                Some(name) if !name.is_empty() && bounded_text(name, 512) => name.to_owned(),
                _ => return None,
            };
            let ticker = match token.get("symbol") {
                None => None,
                Some(value) => match value.as_str() {
                    Some(symbol) if !symbol.is_empty() && bounded_text(symbol, 64) => {
                        Some(symbol.to_owned())
                    }
                    _ => return None,
                },
            };
            let decimals = match token.get("decimals") {
                None => 0,
                Some(value) => match value.as_u64() {
                    Some(decimals) if decimals <= 18 => decimals as u8,
                    _ => return None,
                },
            };
            let stamp = timestamp.parse::<u64>().unwrap_or(0);
            if best.as_ref().is_none_or(|(known, _)| *known <= stamp) {
                let presentation = serde_json::from_value(serde_json::json!({
                    "description": snapshot.get("description"),
                    "uris": snapshot.get("uris").cloned().unwrap_or_else(|| serde_json::json!({})),
                    "nfts": token.get("nfts"),
                }))
                .ok()?;
                best = Some((
                    stamp,
                    RegistryNames {
                        name,
                        ticker,
                        decimals,
                        presentation,
                    },
                ));
            }
        }
    }
    best.map(|(_, names)| names)
}

/// One data push, or `None` if the script is malformed or truncated.
fn read_push<'a>(script: &'a [u8], pos: &mut usize) -> Option<&'a [u8]> {
    let opcode = *script.get(*pos)?;
    *pos += 1;
    let length = match opcode {
        1..=0x4b => opcode as usize,
        OP_PUSHDATA1 => {
            let value = *script.get(*pos)? as usize;
            *pos += 1;
            value
        }
        OP_PUSHDATA2 => {
            let bytes = script.get(*pos..*pos + 2)?;
            *pos += 2;
            u16::from_le_bytes(bytes.try_into().ok()?) as usize
        }
        OP_PUSHDATA4 => {
            let bytes = script.get(*pos..*pos + 4)?;
            *pos += 4;
            u32::from_le_bytes(bytes.try_into().ok()?) as usize
        }
        // Not a push: OP_0, OP_1NEGATE, the numeric opcodes, anything else.
        _ => return None,
    };
    let bytes = script.get(*pos..*pos + length)?;
    *pos += length;
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn publication_script(hash: [u8; 32], uris: &[&str]) -> Vec<u8> {
        let mut script = PUBLICATION_PREFIX.to_vec();
        script.push(32);
        script.extend_from_slice(&hash);
        for uri in uris {
            script.push(uri.len() as u8);
            script.extend_from_slice(uri.as_bytes());
        }
        script
    }

    #[test]
    fn a_publication_carries_its_hash_and_every_uri() {
        let hash = [7u8; 32];
        let script = publication_script(hash, &["example.com", "ipfs://bafy"]);
        let publication = parse_publication(&script).expect("a publication");
        assert_eq!(publication.content_hash, hash);
        assert_eq!(publication.uris, vec!["example.com", "ipfs://bafy"]);
    }

    /// A publication may name no download at all; the hash still identifies it.
    #[test]
    fn a_publication_without_uris_is_still_a_publication() {
        let script = publication_script([1u8; 32], &[]);
        let publication = parse_publication(&script).expect("a publication");
        assert!(publication.uris.is_empty());
    }

    #[test]
    fn other_op_return_protocols_are_not_publications() {
        // Same OP_RETURN, different four bytes.
        let mut script = vec![0x6a, 0x04, b'S', b'L', b'P', b'\0'];
        script.push(32);
        script.extend_from_slice(&[9u8; 32]);
        assert_eq!(parse_publication(&script), None);

        // The prefix alone, with no hash to commit to.
        assert_eq!(parse_publication(&PUBLICATION_PREFIX), None);

        // A hash push that runs off the end.
        let mut truncated = PUBLICATION_PREFIX.to_vec();
        truncated.push(32);
        truncated.extend_from_slice(&[0u8; 8]);
        assert_eq!(parse_publication(&truncated), None);
    }

    /// The committed hash is a single SHA-256, in the order the VM produces.
    ///
    /// Using the double hash Bitcoin applies elsewhere, or reversing to the
    /// order explorers display, rejects registries that are perfectly valid.
    #[test]
    fn the_committed_hash_is_a_single_sha256_in_vm_order() {
        let contents = br#"{"version":{"major":1}}"#;
        let digest: [u8; 32] = Sha256::digest(contents).into();
        let publication = RegistryPublication {
            content_hash: digest,
            uris: Vec::new(),
        };
        assert!(publication.matches(contents));

        let mut reversed = digest;
        reversed.reverse();
        assert!(
            !RegistryPublication {
                content_hash: reversed,
                uris: Vec::new(),
            }
            .matches(contents),
            "display order is not what the publication commits to"
        );

        let doubled: [u8; 32] = Sha256::digest(digest).into();
        assert!(
            !RegistryPublication {
                content_hash: doubled,
                uris: Vec::new(),
            }
            .matches(contents),
            "BCMR commits to one round of SHA-256, not two"
        );
    }

    #[test]
    fn altered_contents_do_not_match() {
        let publication = RegistryPublication {
            content_hash: Sha256::digest(b"registry").into(),
            uris: Vec::new(),
        };
        assert!(publication.matches(b"registry"));
        assert!(!publication.matches(b"registrz"));
    }

    /// An OP_RETURN identity output ends the chain, and saying so needs no
    /// network round trip.
    #[test]
    fn an_op_return_identity_output_is_burned() {
        assert_eq!(
            identity_output_state(Some(&[0x6a, 0x04, 1, 2, 3, 4])),
            IdentityOutputState::Burned
        );
        assert_eq!(
            identity_output_state(Some(&[0x76, 0xa9, 0x14])),
            IdentityOutputState::Live
        );
        assert_eq!(identity_output_state(None), IdentityOutputState::Missing);
    }

    /// The successor is whatever spends output 0, from any input position.
    #[test]
    fn a_successor_is_recognised_wherever_it_spends_the_identity_output() {
        let parent = [3u8; 32];
        let other = [9u8; 32];
        assert!(continues_authchain(&[(other, 1), (parent, 0)], parent));
        assert!(continues_authchain(&[(parent, 0)], parent));
    }

    /// Spending some *other* transaction's output 0 is not continuation.
    ///
    /// This is the ambiguity that makes walking ancestry backwards unsound: an
    /// ordinary transaction can spend several outputs numbered zero, and only
    /// one of them, if any, is the identity it belongs to.
    #[test]
    fn spending_a_different_output_zero_is_not_continuation() {
        let parent = [3u8; 32];
        let stranger = [4u8; 32];
        assert!(!continues_authchain(&[(stranger, 0)], parent));
        // The right transaction, but not its identity output.
        assert!(!continues_authchain(&[(parent, 1)], parent));
    }

    #[test]
    fn bare_authorities_resolve_to_the_well_known_path() {
        assert_eq!(
            RegistryPublication::resolve_uri("example.com"),
            format!("https://example.com{WELL_KNOWN_PATH}")
        );
        assert_eq!(
            RegistryPublication::resolve_uri("example.com/registry.json"),
            "https://example.com/registry.json"
        );
        // A scheme the client may not support is still returned as published,
        // rather than mangled into something that would fetch the wrong thing.
        assert_eq!(
            RegistryPublication::resolve_uri("ipfs://bafy"),
            "ipfs://bafy"
        );
    }

    /// Only the authhead's own outputs are examined.
    #[test]
    fn a_publication_is_found_among_outputs() {
        let hash = [5u8; 32];
        let payment: &[u8] = &[0x76, 0xa9, 0x14];
        let script = publication_script(hash, &["example.com"]);
        let found = publication_in([payment, script.as_slice()]).expect("a publication");
        assert_eq!(found.content_hash, hash);
        assert_eq!(publication_in([payment]), None);
        let later = publication_script([6; 32], &["later.example"]);
        assert_eq!(
            publication_in([script.as_slice(), later.as_slice()]),
            Some(found)
        );
        // Do not let a second output override the definitive malformed first.
        assert_eq!(
            publication_in([PUBLICATION_PREFIX.as_slice(), script.as_slice()]),
            None
        );
    }

    #[test]
    fn explicit_https_authorities_use_well_known_but_explicit_paths_are_preserved() {
        for input in ["https://example.com", "HTTPS://example.com"] {
            assert_eq!(
                RegistryPublication::resolve_uri(input),
                format!("https://example.com{WELL_KNOWN_PATH}")
            );
        }
        assert_eq!(
            RegistryPublication::resolve_uri("https://example.com?version=1"),
            format!("https://example.com{WELL_KNOWN_PATH}?version=1")
        );
        for input in [
            "https://example.com/",
            "https://example.com/registry.json",
            "ipfs://CaseSensitiveCid/path",
        ] {
            assert_eq!(RegistryPublication::resolve_uri(input), input);
        }
    }

    /// Long URIs use PUSHDATA1, and must still be read.
    #[test]
    fn pushdata1_uris_are_read() {
        let uri = "a".repeat(200);
        let mut script = PUBLICATION_PREFIX.to_vec();
        script.push(32);
        script.extend_from_slice(&[2u8; 32]);
        script.push(OP_PUSHDATA1);
        script.push(uri.len() as u8);
        script.extend_from_slice(uri.as_bytes());
        let publication = parse_publication(&script).expect("a publication");
        assert_eq!(publication.uris, vec![uri]);
    }

    #[test]
    fn a_registry_names_the_category_it_commits_to() {
        let category = "aa".repeat(32);
        let body = format!(
            r#"{{"identities":{{"{}":{{"1700000000":{{"name":"Bitcats","token":{{"category":"{category}","symbol":"BCAT","decimals":2}}}}}}}}}}"#,
            "00".repeat(32)
        );
        let names = names_for_category(body.as_bytes(), &category).expect("named");
        assert_eq!(names.name, "Bitcats");
        assert_eq!(names.ticker.as_deref(), Some("BCAT"));
        assert_eq!(names.decimals, 2);
        assert_eq!(names_for_category(body.as_bytes(), &"bb".repeat(32)), None);
        assert_eq!(names_for_category(b"not json", &category), None);
    }

    fn rich_presentation() -> serde_json::Value {
        serde_json::json!({
            "description": "Authenticated collection\nDetails",
            "uris": {"web": "https://example.test/collection", "icon": "ipfs://bafy/icon.png"},
            "nfts": {
                "description": "Tickets",
                "fields": {"seat": {
                    "name": "Seat", "description": "Seat number",
                    "encoding": {"type": "number", "decimals": 0, "aggregate": "add", "unit": "seats"},
                    "uris": {"web": "https://example.test/seats"},
                    "extensions": {"test": {"version": 1}}
                }},
                "parse": {"bytecode": "00d2517f7c6b", "types": {"01": {
                    "name": "Ticket", "description": "Admission", "fields": ["seat"],
                    "uris": {"icon": "ipfs://bafy/ticket.png"},
                    "extensions": {"test": [1, 2]}
                }}}
            }
        })
    }

    #[test]
    fn authenticated_presentation_preserves_bcmr_schema_without_interpreting_it() {
        let value = rich_presentation();
        let presentation: TokenPresentation = serde_json::from_value(value.clone()).unwrap();
        assert!(presentation.is_valid());
        assert_eq!(serde_json::to_value(&presentation).unwrap(), value);
        let category = "aa".repeat(32);
        let registry = serde_json::json!({"identities": {"authbase": {"1": {
            "name": "Tickets", "description": value["description"], "uris": value["uris"],
            "token": {"category": category, "symbol": "TKT", "nfts": value["nfts"]}
        }}}});
        let names = names_for_category(&serde_json::to_vec(&registry).unwrap(), &category).unwrap();
        assert_eq!(names.presentation, presentation);

        // Sequential types use the commitment itself, including empty commitment.
        let sequential = serde_json::json!({"nfts": {"parse": {"types": {"": {"name": "Zero"}}}}});
        let parsed: TokenPresentation = serde_json::from_value(sequential).unwrap();
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["nfts"],
            serde_json::json!({"parse": {"types": {"": {"name": "Zero"}}}})
        );
        assert_eq!(
            serde_json::from_str::<TokenPresentation>("{}").unwrap(),
            TokenPresentation::default()
        );
    }

    #[test]
    fn presentation_rejects_malformed_fields_and_unsafe_uri_references() {
        let invalid = [
            serde_json::json!({"description": 7}),
            serde_json::json!({"description": "bad\u{0000}text"}),
            serde_json::json!({"uris": {"Icon": "https://example.test/a"}}),
            serde_json::json!({"uris": {"icon": "javascript:alert(1)"}}),
            serde_json::json!({"uris": {"icon": "data:image/png;base64,AAAA"}}),
            serde_json::json!({"uris": {"icon": "http://example.test/a"}}),
            serde_json::json!({"uris": {"web": "https://user@example.test/a"}}),
            serde_json::json!({"uris": {"web": "https://example.test\\a"}}),
            serde_json::json!({"uris": {"web": "https:///a"}}),
            serde_json::json!({"uris": {"web": "https://example.test/\n"}}),
            serde_json::json!({"uris": {"web": 3}}),
            serde_json::json!({"nfts": []}),
            serde_json::json!({"nfts": {"parse": {}}}),
            serde_json::json!({"nfts": {"parse": {"bytecode": "zz", "types": {}}}}),
            serde_json::json!({"nfts": {"parse": {"types": {"0": {"name": "Odd hex"}}}}}),
        ];
        for value in invalid {
            assert!(
                serde_json::from_value::<TokenPresentation>(value.clone()).is_err(),
                "accepted {value}"
            );
        }
        for (pointer, invalid) in [
            ("/nfts/parse/types/01/name", serde_json::json!(null)),
            (
                "/nfts/parse/types/01/fields",
                serde_json::json!(["undefined-field"]),
            ),
            (
                "/nfts/parse/types/01/uris/icon",
                serde_json::json!("file:///private"),
            ),
            (
                "/nfts/fields/seat/uris/web",
                serde_json::json!("javascript:alert(1)"),
            ),
            (
                "/nfts/fields/seat/encoding/type",
                serde_json::json!("unknown"),
            ),
            ("/nfts/fields/seat/encoding/decimals", serde_json::json!(19)),
            (
                "/nfts/fields/seat/encoding/aggregate",
                serde_json::json!("multiply"),
            ),
        ] {
            let mut value = rich_presentation();
            *value.pointer_mut(pointer).unwrap() = invalid;
            assert!(
                serde_json::from_value::<TokenPresentation>(value).is_err(),
                "accepted {pointer}"
            );
        }
    }

    #[test]
    fn presentation_bounds_apply_to_schema_extensions_and_ignored_fields() {
        let mut deep = serde_json::json!(0);
        for _ in 0..14 {
            deep = serde_json::json!({"nested": deep});
        }
        let uris: BTreeMap<_, _> = (0..17)
            .map(|n| (format!("uri-{n}"), "https://example.test"))
            .collect();
        let types: BTreeMap<_, _> = (0..257)
            .map(|n| (format!("{n:04x}"), serde_json::json!({"name": "NFT"})))
            .collect();
        let fields: BTreeMap<_, _> = (0..65)
            .map(|n| {
                (
                    format!("field-{n}"),
                    serde_json::json!({"encoding": {"type": "hex"}}),
                )
            })
            .collect();
        // Each individual array fits; the aggregate node budget does not.
        let nodes = vec![vec![0; 256]; 17];
        for value in [
            serde_json::json!({"description": "x".repeat(4097)}),
            serde_json::json!({"uris": uris}),
            serde_json::json!({"uris": {"x".repeat(65): "https://example.test"}}),
            serde_json::json!({"uris": {"web": format!("https://example.test/{}", "x".repeat(2048))}}),
            serde_json::json!({"nfts": {"parse": {"types": types}}}),
            serde_json::json!({"nfts": {"fields": fields, "parse": {"types": {}}}}),
            serde_json::json!({"nfts": {"parse": {"bytecode": "00".repeat(10_001), "types": {}}}}),
            serde_json::json!({"ignored": deep}),
            serde_json::json!({"ignored": nodes}),
            serde_json::json!({"nfts": {"parse": {"types": {"": {
                "name": "NFT", "extensions": {"large": "x".repeat(65_536)}
            }}}}}),
        ] {
            assert!(serde_json::from_value::<TokenPresentation>(value).is_err());
        }
        let boundary: TokenPresentation =
            serde_json::from_value(serde_json::json!({"description": "x".repeat(4096)})).unwrap();
        assert!(boundary.is_valid());
    }

    #[test]
    fn malformed_selected_presentation_cannot_fall_back_to_an_older_identity() {
        let category = "aa".repeat(32);
        let registry = serde_json::json!({"identities": {"authbase": {
            "1": {"name": "Old", "token": {"category": category}},
            "2": {"name": "New", "description": "x".repeat(4097), "token": {"category": category}}
        }}});
        assert!(names_for_category(&serde_json::to_vec(&registry).unwrap(), &category).is_none());
    }

    #[test]
    fn registry_labels_and_decimals_are_bounded_before_projection() {
        let category = "aa".repeat(32);
        let mut snapshot = serde_json::json!({"name": "x".repeat(512), "token": {
            "category": category, "symbol": "X".repeat(64), "decimals": 18
        }});
        let extract = |snapshot: &serde_json::Value| {
            names_for_category(
                &serde_json::to_vec(
                    &serde_json::json!({"identities": {"authbase": {"1": snapshot}}}),
                )
                .unwrap(),
                &category,
            )
        };
        assert_eq!(extract(&snapshot).unwrap().decimals, 18);
        for (pointer, value) in [
            ("/name", serde_json::json!("x".repeat(513))),
            ("/name", serde_json::json!("bad\u{0000}name")),
            ("/token/symbol", serde_json::json!("X".repeat(65))),
            ("/token/symbol", serde_json::json!(42)),
            ("/token/decimals", serde_json::json!(19)),
            ("/token/decimals", serde_json::json!(-1)),
            ("/token/decimals", serde_json::json!(1.5)),
            ("/token/decimals", serde_json::json!("2")),
        ] {
            let mut invalid = snapshot.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(extract(&invalid).is_none(), "accepted {pointer}");
        }
        snapshot["token"]
            .as_object_mut()
            .unwrap()
            .remove("decimals");
        assert_eq!(extract(&snapshot).unwrap().decimals, 0);
    }
}

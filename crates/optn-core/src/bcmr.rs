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
    /// a path means HTTPS at that path. Anything already carrying a scheme is
    /// returned untouched, including `ipfs:` and friends, because deciding
    /// whether this client can reach them is the caller's job and not a
    /// property of the publication.
    pub fn resolve_uri(uri: &str) -> String {
        if uri.contains("://") {
            return uri.to_owned();
        }
        match uri.split_once('/') {
            None => format!("https://{uri}{WELL_KNOWN_PATH}"),
            Some(_) => format!("https://{uri}"),
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
pub fn publication_in<'a>(
    output_scripts: impl IntoIterator<Item = &'a [u8]>,
) -> Option<RegistryPublication> {
    output_scripts.into_iter().find_map(parse_publication)
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
}

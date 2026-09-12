// `test-vectors/fusion-components.json` is read by BOTH encoders of the
// CashFusion component wire format: this one, and the hand-written protobuf in
// src/platform/desktop/nostr/fusionComponentV4.ts.
//
// The two already agree on one Electron Cash golden value — the same literal is
// duplicated in both files. One input component, one amount, one index. Nothing
// covers the varint boundaries, and a hand-rolled writer against prost is
// exactly where those drift: 127 vs 128 is one byte or two, and an off-by-one
// there produces a component the other side hashes differently, so the blind
// credential is signed over bytes the round will not recognise.
//
// Regenerate with:
//
//   WRITE_FUSION_COMPONENT_VECTORS=1 cargo test -p optn-wallet-desktop component_vectors
//
// A diff in that file is a change to the wire format, and should be read as one.
use super::p2p_component::{
    component_blind_message, encode_blank_component, encode_input_component,
    encode_output_component,
};
use sha2::{Digest, Sha256};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../test-vectors/fusion-components.json"
);

/// The Electron Cash wire vector both encoders already carry. Kept here so the
/// shared file is anchored to a value from outside this repository rather than
/// to whatever the two of us happen to agree on.
const EC_INPUT_COMPONENT_HEX: &str = concat!(
    "0a20",
    "1111111111111111111111111111111111111111111111111111111111111111",
    "124b0a20",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "10031a21",
    "020202020202020202020202020202020202020202020202020202020202020202",
    "20c09a0c"
);

fn repeat(byte: u8, len: usize) -> Vec<u8> {
    vec![byte; len]
}

/// Display order is what an explorer shows and what the TypeScript encoder
/// takes; the wire is its reverse. Both are stored so the boundary is explicit
/// rather than something each side remembers separately.
fn display_of(wire: &[u8]) -> String {
    let mut reversed = wire.to_vec();
    reversed.reverse();
    hex::encode(reversed)
}

fn build() -> serde_json::Value {
    // Amounts and indexes chosen to straddle every varint width boundary:
    // one byte up to 127, two to 16383, three to 2097151, and so on.
    const VARINT_EDGES: [u64; 9] = [
        0, 1, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152, 200_000,
    ];

    let mut inputs = Vec::new();
    for (index, amount) in VARINT_EDGES.iter().enumerate() {
        // Deliberately not a run of one byte: a uniform txid is its own
        // reverse, which would let a wire/display mix-up pass every vector in
        // this file unnoticed. The Electron Cash golden below keeps its own
        // 0xaa fixture, because that value is not ours to choose.
        let prev_txid_wire: Vec<u8> = (0u8..32).collect();
        let salt_commitment = repeat(0x11, 32);
        let pubkey = repeat(0x02, 33);
        // The index walks the same boundaries as the amount, one place offset,
        // so no case has both fields at the same width.
        let prev_index = VARINT_EDGES[(index + 1) % VARINT_EDGES.len()] as u32;
        let serialized = encode_input_component(
            &prev_txid_wire,
            prev_index,
            &pubkey,
            *amount,
            &salt_commitment,
        )
        .expect("fixture input component encodes");
        inputs.push(serde_json::json!({
            "prevTxidDisplayHex": display_of(&prev_txid_wire),
            "prevTxidWireHex": hex::encode(&prev_txid_wire),
            "prevIndex": prev_index,
            "pubkeyHex": hex::encode(&pubkey),
            "amount": amount,
            "saltCommitmentHex": hex::encode(&salt_commitment),
            "serializedHex": hex::encode(&serialized),
            "blindMessageHex": hex::encode(component_blind_message(&serialized)),
        }));
    }

    let mut outputs = Vec::new();
    // Script lengths straddle the length-delimiter's own varint boundary at 127.
    for (script_len, amount) in [
        (25usize, 0u64),
        (25, 546),
        (32, 16_384),
        (127, 200_000),
        (128, 2_097_152),
    ] {
        let script = repeat(0x76, script_len);
        let salt_commitment = repeat(0x22, 32);
        let serialized = encode_output_component(&script, amount, &salt_commitment)
            .expect("fixture output component encodes");
        outputs.push(serde_json::json!({
            "scriptHex": hex::encode(&script),
            "amount": amount,
            "saltCommitmentHex": hex::encode(&salt_commitment),
            "serializedHex": hex::encode(&serialized),
            "blindMessageHex": hex::encode(component_blind_message(&serialized)),
        }));
    }

    let mut blanks = Vec::new();
    for byte in [0x00u8, 0x33, 0xff] {
        let salt_commitment = repeat(byte, 32);
        let serialized =
            encode_blank_component(&salt_commitment).expect("fixture blank component encodes");
        blanks.push(serde_json::json!({
            "saltCommitmentHex": hex::encode(&salt_commitment),
            "serializedHex": hex::encode(&serialized),
            "blindMessageHex": hex::encode(component_blind_message(&serialized)),
        }));
    }

    // salt_commitment = sha256(salt), and the InitialCommitment's
    // salted_component_hash = sha256(salt || component). Both are computed
    // inline inside build_round_commit here and as named exports on the
    // TypeScript side, which is how they came to be unchecked against
    // each other.
    let mut salts = Vec::new();
    for byte in [0x00u8, 0x5a, 0xff] {
        let salt = repeat(byte, 32);
        let commitment: [u8; 32] = Sha256::digest(&salt).into();
        let component = encode_blank_component(&commitment).expect("blank encodes");
        let mut salted = Vec::with_capacity(salt.len() + component.len());
        salted.extend_from_slice(&salt);
        salted.extend_from_slice(&component);
        let salted_hash: [u8; 32] = Sha256::digest(&salted).into();
        salts.push(serde_json::json!({
            "saltHex": hex::encode(&salt),
            "saltCommitmentHex": hex::encode(commitment),
            "componentHex": hex::encode(&component),
            "saltedComponentHashHex": hex::encode(salted_hash),
        }));
    }

    serde_json::json!({
        "note": concat!(
            "CashFusion component wire format, shared by src-tauri/src/fusion/p2p_component.rs ",
            "and src/platform/desktop/nostr/fusionComponentV4.ts. Regenerate with ",
            "WRITE_FUSION_COMPONENT_VECTORS=1 cargo test -p optn-wallet-desktop component_vectors. ",
            "A diff here is a wire-format change."
        ),
        "electronCashGolden": {
            "note": "Anchored outside this repo: the Electron Cash input-component wire vector.",
            "prevTxidWireHex": hex::encode(repeat(0xaa, 32)),
            "prevIndex": 3,
            "pubkeyHex": hex::encode(repeat(0x02, 33)),
            "amount": 200_000,
            "saltCommitmentHex": hex::encode(repeat(0x11, 32)),
            "serializedHex": EC_INPUT_COMPONENT_HEX,
        },
        "inputComponents": inputs,
        "outputComponents": outputs,
        "blankComponents": blanks,
        "salts": salts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored() -> serde_json::Value {
        if std::env::var_os("WRITE_FUSION_COMPONENT_VECTORS").is_some() {
            return build();
        }
        let raw =
            std::fs::read_to_string(PATH).expect("test-vectors/fusion-components.json exists");
        serde_json::from_str(&raw).expect("test-vectors/fusion-components.json is valid JSON")
    }

    #[test]
    fn vectors_match_the_encoder() {
        let built = build();
        if std::env::var("WRITE_FUSION_COMPONENT_VECTORS").is_ok() {
            let mut text = serde_json::to_string_pretty(&built).expect("serializable");
            text.push('\n');
            std::fs::write(PATH, text).expect("vector file is writable");
            return;
        }
        assert_eq!(
            built,
            stored(),
            "the component encoder no longer produces the stored vectors. If that is \
             intended, fusionComponentV4.ts has to change with it -- regenerate with \
             WRITE_FUSION_COMPONENT_VECTORS=1 and check both."
        );
    }

    #[test]
    fn the_golden_vector_still_encodes_from_its_inputs() {
        // Re-derived rather than compared to itself: an anchor nobody can
        // reproduce is just a number in a file.
        let doc = stored();
        let golden = &doc["electronCashGolden"];
        let ser = encode_input_component(
            &hex::decode(golden["prevTxidWireHex"].as_str().expect("hex")).expect("hex"),
            golden["prevIndex"].as_u64().expect("u64") as u32,
            &hex::decode(golden["pubkeyHex"].as_str().expect("hex")).expect("hex"),
            golden["amount"].as_u64().expect("u64"),
            &hex::decode(golden["saltCommitmentHex"].as_str().expect("hex")).expect("hex"),
        )
        .expect("golden encodes");
        assert_eq!(
            hex::encode(ser),
            golden["serializedHex"].as_str().expect("hex")
        );
    }

    #[test]
    fn display_and_wire_txids_are_reverses_of_each_other() {
        // The one field where the two encoders take different byte orders, so
        // the file states both and this checks the relationship holds.
        let doc = stored();
        for case in doc["inputComponents"].as_array().expect("array") {
            let wire = hex::decode(case["prevTxidWireHex"].as_str().expect("hex")).expect("hex");
            let display =
                hex::decode(case["prevTxidDisplayHex"].as_str().expect("hex")).expect("hex");
            let mut reversed = wire.clone();
            reversed.reverse();
            assert_eq!(reversed, display);
        }
    }

    #[test]
    fn blind_messages_are_sha256_of_the_stored_component_bytes() {
        let doc = stored();
        for group in ["inputComponents", "outputComponents", "blankComponents"] {
            for case in doc[group].as_array().expect("array") {
                let ser = hex::decode(case["serializedHex"].as_str().expect("hex")).expect("hex");
                assert_eq!(
                    hex::encode(component_blind_message(&ser)),
                    case["blindMessageHex"].as_str().expect("hex"),
                    "{group} blind message does not reproduce"
                );
            }
        }
    }

    #[test]
    fn the_varint_boundaries_are_actually_covered() {
        // Guards the fixtures from being quietly narrowed: if every amount
        // ended up under 128, this file would prove far less than it looks.
        let doc = stored();
        let amounts: Vec<u64> = doc["inputComponents"]
            .as_array()
            .expect("array")
            .iter()
            .map(|c| c["amount"].as_u64().expect("u64"))
            .collect();
        assert!(amounts.iter().any(|a| *a < 128));
        assert!(amounts.iter().any(|a| (128..16_384).contains(a)));
        assert!(amounts.iter().any(|a| *a >= 2_097_152));
    }
}

//! Rust against what the TypeScript peers computed
//! (`test-vectors/p2p-fusion.json`, from `scripts/generate-p2p-fusion-vectors.mts`).
//!
//! A mixed round works only if both sides agree on every one of these: who
//! coordinates, which group forms, the transaction and its fee gate, the
//! onion, which messages are legal, which blame holds, and what a signed
//! transaction looks like.

use serde_json::Value;

use super::allocation::{plan_output_values, quantization_grid, DEFAULT_MIN_OUTPUT};
use super::assemble::{assemble, finalize, verify_final, verify_safety, Assembled, Contribution};
use super::blame::{verify, BlameCode, BlameEvidence, BlameReport, VerifyContext};
use super::credentials::{input_credential_hash, output_credential_hash};
use super::onion::{decode_authorized_output, from_base64, peel, unpad};
use super::pool::{
    build_announcement, elect_coordinator, parse_announcement, select_group, AnnouncementEvent,
    GroupPeer,
};
use super::wire::{
    parse_round_message, AuthorizedOutput, InputRef, InputSig, OutputRef, PoolNetwork,
};
use super::{hex, unhex_array};

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../../test-vectors/p2p-fusion.json"))
        .expect("p2p-fusion.json parses")
}

fn strings(value: &Value) -> Vec<String> {
    serde_json::from_value(value.clone()).expect("string array")
}

fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).expect("vector shape")
}

#[test]
fn the_same_coordinator_is_elected() {
    for case in vectors()["election"].as_array().unwrap() {
        let keys = strings(&case["keys"]);
        assert_eq!(
            elect_coordinator(&keys).as_deref(),
            case["coordinator"].as_str(),
            "{keys:?}"
        );
    }
}

#[test]
fn the_same_group_forms() {
    for case in vectors()["groups"].as_array().unwrap() {
        let peers: Vec<GroupPeer> = case["peers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|peer| GroupPeer {
                pubkey: peer["pubkey"].as_str().unwrap().into(),
                tiers: parse(&peer["tiers"]),
                num_inputs: peer["numInputs"].as_u64().unwrap(),
            })
            .collect();
        let group = select_group(
            &peers,
            case["min"].as_u64().unwrap() as usize,
            case["max"].as_u64().unwrap() as usize,
        );
        match case["group"].as_object() {
            None => assert!(group.is_none()),
            Some(expected) => {
                let group = group.expect("a group forms");
                assert_eq!(group.tier, expected["tier"].as_u64().unwrap());
                assert_eq!(group.participants, strings(&expected["participants"]));
            }
        }
    }
}

#[test]
fn the_same_canonical_transaction_and_fee_gate() {
    let assembly = &vectors()["assembly"];
    let contribution = &assembly["contributions"][0];
    let inputs: Vec<InputRef> = parse(&contribution["inputs"]);
    let outputs: Vec<OutputRef> = parse(&contribution["outputs"]);
    let tx = assemble([(&inputs[..], &outputs[..])]).unwrap();
    let expected = Assembled {
        inputs: parse(&assembly["assembled"]["inputs"]),
        outputs: parse(&assembly["assembled"]["outputs"]),
    };
    assert_eq!(tx, expected);
    assert_eq!(
        tx.estimated_size(),
        assembly["estimatedSize"].as_u64().unwrap()
    );
    assert_eq!(
        tx.minimum_fee(1_000),
        assembly["minimumFeeAt1000"].as_u64().unwrap()
    );
    for case in assembly["safety"].as_array().unwrap() {
        let mine = Contribution {
            inputs: parse(&case["mine"]["inputs"]),
            outputs: parse(&case["mine"]["outputs"]),
        };
        let verdict = verify_safety(&tx, &mine, case["feerate"].as_u64().unwrap());
        assert_eq!(
            verdict.ok,
            case["verdict"]["ok"].as_bool().unwrap(),
            "{case}"
        );
        assert_eq!(
            verdict.reason.as_deref(),
            case["verdict"]["reason"].as_str(),
            "{case}"
        );
        assert_eq!(
            verdict.required_fee,
            case["verdict"]["requiredFee"].as_u64().unwrap()
        );
    }
}

#[test]
fn a_typescript_signed_transaction_finalizes_and_verifies_identically() {
    let final_tx = &vectors()["finalTx"];
    let tx = Assembled {
        inputs: parse(&final_tx["assembled"]["inputs"]),
        outputs: parse(&final_tx["assembled"]["outputs"]),
    };
    let sigs: Vec<InputSig> = parse(&final_tx["sigs"]);
    let (tx_hex, txid) = finalize(&tx, &sigs).unwrap();
    assert_eq!(tx_hex, final_tx["txHex"].as_str().unwrap());
    assert_eq!(txid, final_tx["txid"].as_str().unwrap());
    assert_eq!(
        verify_final(&tx, &tx_hex, &txid).unwrap(),
        txid,
        "libauth's Schnorr signatures verify in Rust"
    );
}

#[test]
fn a_typescript_onion_peels_in_rust() {
    let onion = &vectors()["onion"];
    let mut blob = from_base64(onion["blob"].as_str().unwrap()).unwrap();
    for secret in strings(&onion["peelerSecrets"]) {
        blob = peel(&blob, &unhex_array::<32>(&secret).unwrap()).unwrap();
    }
    assert_eq!(unpad(&blob), onion["payload"].as_str().unwrap());
    let decoded = decode_authorized_output(&unpad(&blob)).unwrap();
    assert_eq!(decoded, parse::<AuthorizedOutput>(&onion["output"]));
}

#[test]
fn credentials_sign_the_same_component_hashes() {
    let credentials = &vectors()["credentials"];
    let input: InputRef = parse(&credentials["input"]);
    let output: OutputRef = parse(&credentials["output"]);
    assert_eq!(
        hex(
            &input_credential_hash(&input, credentials["inputSaltCommitment"].as_str().unwrap())
                .unwrap()
        ),
        credentials["inputHash"].as_str().unwrap()
    );
    assert_eq!(
        hex(&output_credential_hash(
            &output,
            credentials["outputSaltCommitment"].as_str().unwrap()
        )
        .unwrap()),
        credentials["outputHash"].as_str().unwrap()
    );
}

#[test]
fn the_parser_accepts_and_refuses_what_the_typescript_does() {
    let vectors = vectors();
    let now = vectors["nowUnix"].as_u64().unwrap();
    for case in vectors["messages"].as_array().unwrap() {
        let json = case["json"].as_str().unwrap();
        let accepted = parse_round_message(json, now).is_some();
        assert_eq!(
            accepted,
            case["accepted"].as_bool().unwrap(),
            "{}: {json}",
            case["why"]
        );
    }
}

#[test]
fn blame_verdicts_agree() {
    let vectors = vectors();
    // The blame cases use the round of the first message, a proposal.
    let proposal: Value =
        serde_json::from_str(vectors["messages"][0]["json"].as_str().unwrap()).unwrap();
    let participants = strings(&proposal["participants"]);
    let session = proposal["session"].as_str().unwrap().to_owned();
    let ctx = VerifyContext {
        session: &session,
        participants: &participants,
        feerate: Some(1_000),
    };
    for case in vectors["blame"].as_array().unwrap() {
        let report = &case["report"];
        let report = BlameReport {
            session: report["session"].as_str().unwrap().into(),
            accused: report["accused"].as_str().unwrap().into(),
            code: parse::<BlameCode>(&report["code"]),
            evidence: parse::<BlameEvidence>(&report["evidence"]),
        };
        assert_eq!(
            verify(&report, &ctx).is_ok(),
            case["ok"].as_bool().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn announcements_match_and_parse() {
    let announcement = &vectors()["announcement"];
    let now = announcement["nowUnix"].as_u64().unwrap();
    let event = &announcement["event"];
    let draft = build_announcement(
        PoolNetwork::Chipnet,
        &[100_000, 5, 1_000_000, 100_000],
        3,
        now,
        false,
    )
    .unwrap();
    assert_eq!(
        draft.content,
        event["content"].as_str().unwrap(),
        "byte-identical content"
    );
    let tags: Vec<Vec<String>> = parse(&event["tags"]);
    assert_eq!(draft.tags, tags);
    assert_eq!(draft.created_at, event["created_at"].as_u64().unwrap());
    let parsed = parse_announcement(
        &AnnouncementEvent {
            pubkey: event["pubkey"].as_str().unwrap(),
            kind: event["kind"].as_u64().unwrap() as u16,
            created_at: event["created_at"].as_u64().unwrap(),
            tags: &tags,
            content: event["content"].as_str().unwrap(),
        },
        PoolNetwork::Chipnet,
        now,
    )
    .expect("the TypeScript announcement is admitted");
    assert_eq!(parsed.tiers, vec![100_000, 1_000_000]);
}

#[test]
fn output_plans_match_for_the_same_random_draws() {
    let planning = &vectors()["planning"];
    for grid in planning["grids"].as_array().unwrap() {
        assert_eq!(
            quantization_grid(grid["tier"].as_u64().unwrap()),
            grid["grid"].as_u64().unwrap()
        );
    }
    for case in planning["cases"].as_array().unwrap() {
        let units: Vec<f64> = parse(&case["units"]);
        let mut at = 0;
        let inputs: Vec<(u64, usize)> = case["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|input| {
                (
                    input["value"].as_u64().unwrap(),
                    input["pubkey"].as_str().unwrap().len(),
                )
            })
            .collect();
        let plan = plan_output_values(
            &inputs,
            case["participantCount"].as_u64().unwrap() as usize,
            1_000,
            DEFAULT_MIN_OUTPUT,
            case["tier"].as_u64(),
            || {
                let unit = units[at % units.len()];
                at += 1;
                unit
            },
        )
        .unwrap();
        assert_eq!(
            plan.values,
            parse::<Vec<u64>>(&case["plan"]["values"]),
            "{case}"
        );
        assert_eq!(
            plan.fee_share,
            case["plan"]["feeShare"].as_u64().unwrap(),
            "{case}"
        );
    }
}

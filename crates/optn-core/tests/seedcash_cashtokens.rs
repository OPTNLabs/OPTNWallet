#[path = "support/cash_tokens.rs"]
mod support;

use optn_core::{network::Network, psbt};

#[test]
fn fresh_seedcash_returns_finalize_and_supplied_broken_origins_are_rejected() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test-vectors/seedcash-cashtokens.json"
    ))
    .unwrap();
    let generated = support::cases();
    for case in fixtures["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let original = support::unhex(case["psbt_hex"].as_str().unwrap());
        if let Some(generated) = generated.iter().find(|c| c.id == id) {
            assert_eq!(generated.psbt, original, "generator drift: {id}");
        } else {
            assert!(id.starts_with("supplied-"), "unknown fixture {id}");
        }
        let review = psbt::review_p2pkh(&original, Network::Chipnet);
        assert_eq!(
            review.is_ok(),
            case["expected_review_success"].as_bool().unwrap(),
            "{id}: {review:?}"
        );
        let Some(signed) = case["signed_psbt_hex"].as_str() else {
            continue;
        };
        let signed = support::unhex(signed);
        let finalization = psbt::finalize_cash_tokens_p2pkh(&original, &signed, Network::Chipnet);
        if let Some(raw) = case["raw_transaction_hex"].as_str() {
            assert_eq!(finalization.unwrap(), support::unhex(raw), "{id}");
            let review = review.unwrap();
            if !review.categories.is_empty() {
                assert!(
                    psbt::finalize_p2pkh(&original, &signed, Network::Chipnet).is_err(),
                    "ordinary BCH wallet must still refuse tokens"
                );
            }
            let json = serde_json::to_value(&review).unwrap();
            for output in json["spent_outputs"]
                .as_array()
                .unwrap()
                .iter()
                .chain(json["outputs"].as_array().unwrap())
            {
                if !output["token"].is_null() {
                    assert!(
                        output["token"]["amount"].is_string(),
                        "FT amounts must survive JS's integer limit"
                    );
                }
            }
        } else {
            assert!(finalization.is_err(), "{id}");
        }
    }
}

#[test]
fn exported_corpus_reviews_token_transitions() {
    for case in support::cases() {
        assert_eq!(
            case.parents.len(),
            psbt::parse(&case.psbt).unwrap().inputs.len()
        );
        let result = psbt::review_p2pkh(&case.psbt, Network::Chipnet);
        assert_eq!(result.is_ok(), case.valid, "{}: {result:?}", case.id);
        assert!(psbt::review_p2pkh(&case.psbt, Network::Mainnet).is_err());
        assert_eq!(support::unhex(&support::hex(&case.psbt)), case.psbt);
        if case.id == "mega-mix-genesis-mint-mutate-ft-nft-burn" {
            let review = result.unwrap();
            assert_eq!(review.genesis_candidates.len(), 3);
            assert_eq!(review.categories.iter().filter(|c| c.genesis).count(), 2);
            assert_eq!(
                review
                    .categories
                    .iter()
                    .filter(|c| c.burned_fungible != "0")
                    .count(),
                2
            );
            assert!(review
                .categories
                .iter()
                .any(|c| c.input_nfts.len() == 1 && c.output_nfts.is_empty()));
            assert_eq!(case.scenario_ids, [100]);
        }
    }
}

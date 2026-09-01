use app_lib::multisig_inspect;

const KEY_A: &str = "02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8";
const KEY_B: &str = "02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f";
const REDEEM_SCRIPT: &str = "522102fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f2102ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f852ae";

#[test]
fn desktop_multisig_inspection_matches_the_cli_core_vector() {
    let inspection = multisig_inspect(
        "chipnet".to_string(),
        2,
        vec![KEY_A.to_string(), KEY_B.to_string()],
    )
    .expect("valid public policy");
    let value = serde_json::to_value(inspection).expect("serializable inspection");

    assert_eq!(value["redeemScript"], REDEEM_SCRIPT);
    assert_eq!(value["sortedPublicKeys"], serde_json::json!([KEY_B, KEY_A]));
    assert!(value["address"].as_str().unwrap().starts_with("bchtest:p"));
    assert!(value["tokenAddress"]
        .as_str()
        .unwrap()
        .starts_with("bchtest:r"));
}

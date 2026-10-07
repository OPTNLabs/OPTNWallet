use super::*;
use optn_core::{
    hd::{Wallet, BIP39_TEST_VECTOR_MNEMONIC},
    network::Network,
    tx,
};
use serde_json::json;
fn fixture() -> (Value, BchTransactionRequest, Vec<u8>, Vec<u8>) {
    let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").unwrap();
    let payer = wallet.address(Network::Chipnet, "m/44'/1'/0'/0/0").unwrap();
    let merchant = wallet.address(Network::Chipnet, "m/44'/1'/5'/0/0").unwrap();
    let change = wallet.address(Network::Chipnet, "m/44'/1'/0'/1/0").unwrap();
    let parent = tx::Transaction::new(
        vec![tx::Utxo {
            txid: [7; 32],
            vout: 0,
            value: 21_000,
            script_pubkey: payer.script_pubkey(),
        }],
        vec![tx::Output::new(20_000, payer.script_pubkey())],
    )
    .sign(&[wallet.signing_key("m/44'/1'/0'/0/0").unwrap()])
    .unwrap();
    let transaction = tx::Transaction::new(
        vec![tx::Utxo {
            txid: tx::double_sha256(&parent),
            vout: 0,
            value: 20_000,
            script_pubkey: payer.script_pubkey(),
        }],
        vec![
            tx::Output::new(10_000, merchant.script_pubkey()),
            tx::Output::new(9_700, change.script_pubkey()),
        ],
    );
    let raw = transaction
        .sign(&[wallet.signing_key("m/44'/1'/0'/0/0").unwrap()])
        .unwrap();
    let document = json!({"x402Version":2,"resource":{"url":"https://merchant.invalid/item","description":"Fixture"},
        "extensions":{"test-extension":{"info":{"nonce":"fixture"}}},"accepts":[{
            "scheme":"exact","network":"bch:bchtest","asset":"BCH","amount":"10000","payTo":merchant.encode(),"maxTimeoutSeconds":60,
            "extra":{"assetTransferMethod":"native","paymentFlow":"upfront","invoiceId":"retained"},"merchantField":"retained"}]});
    let request = BchTransactionRequest {
        network: BchTransactionNetwork::Chipnet,
        recipient: BchRecipient {
            address: merchant.encode(),
        },
        value: "10000".into(),
        token: None,
    };
    (document, request, parent, raw)
}
#[tokio::test]
async fn sdk_verifies_optn_signatures_and_preserves_original_offer_and_extensions() {
    let (document, request, parent, raw) = fixture();
    let offer = Offer::parse(
        Some(&STANDARD.encode(document.to_string())),
        "not a quote",
        BchChainReference::Chipnet,
    )
    .unwrap();
    assert_eq!(offer.request, request);
    let header = offer
        .payment_header(
            PreparedWallet::new(request.clone(), raw.clone()).unwrap(),
            PaymentSources::new(BchChainReference::Chipnet, &[parent.clone()]).unwrap(),
        )
        .await
        .unwrap();
    let payload: Value = serde_json::from_slice(&STANDARD.decode(header).unwrap()).unwrap();
    assert_eq!(payload["accepted"], document["accepts"][0]);
    assert_eq!(payload["extensions"], document["extensions"]);
    assert_eq!(payload["resource"], document["resource"]);
    assert_eq!(
        STANDARD
            .decode(payload["payload"]["transaction"].as_str().unwrap())
            .unwrap(),
        raw
    );
    let mut damaged = raw;
    damaged[50] ^= 1;
    assert!(offer
        .payment_header(
            PreparedWallet::new(request, damaged).unwrap(),
            PaymentSources::new(BchChainReference::Chipnet, &[parent]).unwrap()
        )
        .await
        .is_err());
}
#[test]
fn invalid_headers_networks_versions_and_ambiguous_asset_details_fail_closed() {
    let (document, _, _, _) = fixture();
    let parse = |value: &Value| Offer::parse(None, &value.to_string(), BchChainReference::Chipnet);
    assert!(Offer::parse(
        Some("not-base64"),
        &document.to_string(),
        BchChainReference::Chipnet
    )
    .is_err());
    assert!(Offer::parse(None, &document.to_string(), BchChainReference::Mainnet).is_err());
    let mut bad = document.clone();
    bad["x402Version"] = json!(1);
    assert!(parse(&bad).is_err());
    let mut bad = document.clone();
    bad["accepts"][0]["scheme"] = json!("utxo");
    assert!(parse(&bad).is_err());
    let mut bad = document.clone();
    bad["accepts"][0]["extra"]["token"] = json!({"category":"09".repeat(32),"amount":"10000"});
    assert!(parse(&bad).is_err());
    let mut bad = document.clone();
    bad["accepts"][0]["extra"]["paymentFlow"] = json!("deferred");
    assert!(parse(&bad).is_err());
    let mut bad = document.clone();
    bad["accepts"] = json!(vec![document["accepts"][0].clone(); 65]);
    assert!(parse(&bad).is_err());
    assert!(Offer::parse(
        None,
        &" ".repeat(MAX_REQUIREMENTS_BYTES + 1),
        BchChainReference::Chipnet
    )
    .is_err());
}
#[test]
fn receipt_must_name_this_transaction_and_chain() {
    let id = "11".repeat(32);
    let receipt = |network: &str, transaction: &str| {
        STANDARD.encode(
            json!({"success":true,"payer":"fixture","network":network,"transaction":transaction})
                .to_string(),
        )
    };
    assert!(settlement_receipt(
        &receipt("bch:bchtest", &id),
        &id,
        BchChainReference::Chipnet
    )
    .is_ok());
    assert!(settlement_receipt(
        &receipt("bch:bitcoincash", &id),
        &id,
        BchChainReference::Chipnet
    )
    .is_err());
    assert!(settlement_receipt(
        &receipt("bch:bchtest", &"22".repeat(32)),
        &id,
        BchChainReference::Chipnet
    )
    .is_err());
}

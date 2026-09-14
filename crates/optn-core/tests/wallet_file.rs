//! Wallet-file tests live in the test target so dummy unlock strings are not
//! compiled into the published `optn-core` library. They still call the shipped
//! `WalletFile::{parse,unlock,change_password,validate_new_password}` APIs.

use optn_core::{
    hd::{Wallet, BIP39_TEST_VECTOR_MNEMONIC},
    network::Network,
    wallet_file::{validate_new_password, SecretText, WalletFile},
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyUnlock {
    unlock_password: String,
    rotated_password: String,
    bip39_passphrase: String,
}

fn password_of_len(n: usize) -> String {
    (0..n).map(|i| char::from(b'a' + (i % 26) as u8)).collect()
}

#[test]
fn library_source_does_not_embed_dummy_unlock_passwords() {
    let src = include_str!("../src/wallet_file.rs");
    assert!(
        !src.contains("12345678"),
        "policy-length dummy must not live in published wallet_file.rs"
    );
    assert!(
        !src.contains("old-password"),
        "legacy vector password must not live in published wallet_file.rs"
    );
    assert!(
        !src.contains("new-password"),
        "rotated vector password must not live in published wallet_file.rs"
    );
}

#[test]
fn legacy_ciphertext_migrates_without_changing_identity_or_optional_metadata() {
    let unlock: LegacyUnlock =
        serde_json::from_slice(include_bytes!("fixtures/legacy-wallet-v1.unlock.json")).unwrap();
    let file = WalletFile::parse(include_bytes!("fixtures/legacy-wallet-v1.json")).unwrap();
    let (_, account) = file.account(Network::Mainnet).unwrap();
    let expected = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, &unlock.bip39_passphrase)
        .unwrap()
        .account_xpub_at(account)
        .unwrap();
    assert_eq!(
        file.unlock(&unlock.unlock_password)
            .unwrap()
            .account_xpub_at(account)
            .unwrap(),
        expected
    );
    let entropy = std::array::from_fn(|index| index as u8);
    let changed = file
        .change_password(
            &unlock.unlock_password,
            &unlock.rotated_password,
            &unlock.rotated_password,
            &entropy,
        )
        .unwrap();
    let changed = WalletFile::parse(&changed.encode().unwrap()).unwrap();
    assert_eq!(
        changed.source_id, 0,
        "legacy mirrors must no longer own the updated file"
    );
    assert_eq!(changed.extra["legacySourceId"], 7);
    assert_eq!(changed.extra["optionalMarker"], "preserve");
    assert_eq!(
        changed.account(Network::Mainnet).unwrap(),
        (Network::Chipnet, account)
    );
    assert_eq!(
        changed
            .unlock(&unlock.rotated_password)
            .unwrap()
            .account_xpub_at(account)
            .unwrap(),
        expected
    );
    assert!(changed.unlock(&unlock.unlock_password).is_err());
}

#[test]
fn password_and_os_empty_value_rules_are_distinct() {
    let empty = String::new();
    let too_short = password_of_len(7);
    let long_enough = password_of_len(8);
    let other = password_of_len(9);
    assert!(validate_new_password(&empty, &empty).is_ok());
    assert!(validate_new_password(&too_short, &too_short).is_err());
    assert!(validate_new_password(&long_enough, &long_enough).is_ok());
    assert!(validate_new_password(&long_enough, &other).is_err());
    let secret = SecretText::new("never-in-debug".into());
    assert!(!format!("{secret:?}").contains("never-in-debug"));
}

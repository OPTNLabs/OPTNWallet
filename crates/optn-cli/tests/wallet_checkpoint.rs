use optn_chain_native::wallet_checkpoint::WalletCheckpointFile;
use optn_core::{
    hd::{AccountPath, Wallet, BIP39_TEST_VECTOR_MNEMONIC},
    header_hash::sha256d,
    wallet_pack::{self, derive_key_with_rounds, PackKey, NONCE_LEN},
};
use optn_runtime::{chain::Evidence, wallet_checkpoint::WalletCheckpoint};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static TEST_FILE_ID: AtomicU64 = AtomicU64::new(0);

struct TestFile {
    path: PathBuf,
}

impl Drop for TestFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(self.path.with_extension("lock"));
    }
}

fn test_file() -> TestFile {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("target")
        });
    fs::create_dir_all(&target).expect("test target directory");
    TestFile {
        path: target.join(format!(
            "optn-wallet-checkpoint-{}-{}.bin",
            std::process::id(),
            TEST_FILE_ID.fetch_add(1, Ordering::Relaxed),
        )),
    }
}

fn empty_checkpoint(key: &PackKey, account: AccountPath) -> WalletCheckpoint {
    let xpub = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
        .expect("published BIP39 fixture")
        .account_xpub_at(account)
        .expect("fixture account");
    let fixture = serde_json::json!({
        "format": "optn-hd-restart-v1",
        "network": "chipnet",
        "account_path": account.to_string(),
        "account_xpub": xpub,
        "branch_lengths": [1, 1, 1],
        "source": "checkpoint-file-test",
        "evidence": serde_json::to_value(Evidence::ServerAssertion).expect("evidence JSON"),
        "tip": null,
        "transactions": [],
        "annotations": [],
    });
    let plaintext = serde_json::to_vec(&fixture).expect("checkpoint fixture JSON");
    // Fixed nonce under a test-only derived key; native storage generates a fresh nonce.
    let nonce = [7; NONCE_LEN];
    let mut bytes = nonce.to_vec();
    bytes.extend(wallet_pack::seal(key, &nonce, &plaintext).expect("authenticate fixture"));
    WalletCheckpoint::open(key, &bytes).expect("open authenticated empty checkpoint")
}

#[test]
fn wallet_checkpoint_file_preserves_authenticated_compare_and_swap() {
    let key = derive_key_with_rounds("public checkpoint fixture", &[1; 16], 1).expect("test key");
    let wrong_key = derive_key_with_rounds("different public checkpoint fixture", &[1; 16], 1)
        .expect("wrong key");
    let account = AccountPath::new(1, 0).expect("chipnet account");
    let checkpoint = empty_checkpoint(&key, account);
    let different_account =
        empty_checkpoint(&wrong_key, AccountPath::new(1, 1).expect("second account"));
    let test_file = test_file();
    let file = WalletCheckpointFile::new(test_file.path.clone());

    assert!(file.load(&key).expect("empty file load").is_none());
    let first_revision = file.store(&checkpoint, &key, None).expect("initial store");
    let first_ciphertext = fs::read(&test_file.path).expect("initial ciphertext");
    let (loaded, loaded_revision) = file.load(&key).expect("load").expect("stored checkpoint");
    assert_eq!(loaded_revision, first_revision);
    assert!(loaded.same_wallet(&checkpoint));

    let second_revision = file
        .store(&checkpoint, &key, Some(first_revision))
        .expect("revision-matched store");
    let second_ciphertext = fs::read(&test_file.path).expect("updated ciphertext");
    assert_ne!(
        second_revision, first_revision,
        "fresh nonce changes the revision"
    );
    assert_ne!(
        second_ciphertext, first_ciphertext,
        "fresh nonce changes the ciphertext"
    );

    assert!(file.store(&checkpoint, &key, Some(first_revision)).is_err());
    assert!(file.store(&checkpoint, &key, None).is_err());
    assert_eq!(
        fs::read(&test_file.path).expect("ciphertext after stale stores"),
        second_ciphertext
    );

    assert!(file.load(&wrong_key).is_err());
    assert!(file
        .store(&checkpoint, &wrong_key, Some(second_revision))
        .is_err());
    assert!(file
        .store(&different_account, &key, Some(second_revision))
        .is_err());
    assert_eq!(
        fs::read(&test_file.path).expect("ciphertext after refused stores"),
        second_ciphertext
    );

    let corrupt = b"not an authenticated checkpoint";
    fs::write(&test_file.path, corrupt).expect("write exact corrupt test file");
    assert!(file.load(&key).is_err());
    assert!(file
        .store(&checkpoint, &key, Some(sha256d(corrupt)))
        .is_err());
    assert_eq!(
        fs::read(&test_file.path).expect("corrupt file remains"),
        corrupt
    );
}

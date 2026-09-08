//! Public-key HD discovery planning. The runtime performs provider I/O and
//! publishes only after every ordinary branch reaches a complete unused gap.

use crate::{chain_service::WalletInterest, sync_worker::WalletNetworkSnapshot};
use optn_core::{
    cashaddr::Address,
    discovery::{GapScan, ScanStop, ADDRESS_CAP, GAP_LIMIT},
    hd::AccountPath,
    network::Network,
    watch_only::{address_under_account, parse_account_xpub, HdAddressBook, PublicAddressPreview},
};
use std::collections::BTreeSet;

/// Receive, change, and the existing ordinary DeFi/Cauldron branch. RPA branch
/// 3 is a key gate; it must not be scanned as ordinary P2PKH addresses.
const BRANCHES: [u32; 3] = [0, 1, 2];
pub(crate) const MAX_HD_BRANCH_ADDRESSES: u32 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HdSyncLimits {
    pub gap_limit: u32,
    pub addresses_per_branch: u32,
}

impl Default for HdSyncLimits {
    fn default() -> Self {
        Self {
            gap_limit: GAP_LIMIT,
            addresses_per_branch: ADDRESS_CAP,
        }
    }
}

impl HdSyncLimits {
    pub fn validate(self) -> Result<(), String> {
        if self.gap_limit == 0
            || self.addresses_per_branch < self.gap_limit
            || self.addresses_per_branch > MAX_HD_BRANCH_ADDRESSES
        {
            return Err(
                "HD scan requires a nonzero gap and a per-branch cap between the gap and 10000"
                    .into(),
            );
        }
        Ok(())
    }
}

pub(crate) struct HdAccountScan {
    network: Network,
    xpub: String,
    account: AccountPath,
    limits: HdSyncLimits,
    derived: [Vec<PublicAddressPreview>; 3],
    horizon: [usize; 3],
    minimum: [usize; 3],
    last_used: [Option<u32>; 3],
}

impl HdAccountScan {
    pub(crate) fn new(
        network: Network,
        xpub: String,
        account: AccountPath,
        limits: HdSyncLimits,
        mut required: BTreeSet<Vec<u8>>,
    ) -> Result<Self, String> {
        limits.validate()?;
        let public = parse_account_xpub(&xpub).map_err(|error| error.to_string())?;
        if u32::from(public.attrs().child_number) & 0x7fff_ffff != account.account() {
            return Err("account xPub index differs from the selected account path".into());
        }
        let gap = limits.gap_limit as usize;
        let mut scan = Self {
            network,
            xpub,
            account,
            limits,
            derived: Default::default(),
            horizon: [gap; 3],
            minimum: [gap; 3],
            last_used: [None; 3],
        };
        // Locate retained scripts locally, without asking providers to decide
        // ownership or dropping an older branch just because it is empty now.
        for index in 0..limits.addresses_per_branch as usize {
            for branch in 0..BRANCHES.len() {
                scan.derive_through(branch, index + 1)?;
                let script = Address::decode(&scan.derived[branch][index].address)?.script_pubkey();
                if required.remove(&script) {
                    scan.minimum[branch] = scan.minimum[branch].max(index + 1);
                    scan.horizon[branch] = scan.minimum[branch];
                }
            }
            if required.is_empty() && index + 1 >= gap {
                return Ok(scan);
            }
        }
        Err("retained wallet scripts are outside this HD account or scan cap".into())
    }

    fn derive_through(&mut self, branch: usize, count: usize) -> Result<(), String> {
        // ponytail: reuse bounded public derivation; cache parsed branch keys
        // here if large-account profiling shows derivation is the bottleneck.
        for index in self.derived[branch].len()..count {
            let mut address =
                address_under_account(self.network, &self.xpub, BRANCHES[branch], index as u32)
                    .map_err(|error| error.to_string())?;
            // Preserve the actual origin path, including imported nondefault
            // coin types; the network only controls CashAddr encoding here.
            address.path = format!("{}/{}/{index}", self.account, BRANCHES[branch]);
            self.derived[branch].push(address);
        }
        Ok(())
    }

    /// Reconstruct authenticated local scope. This does not mark it fresh or
    /// complete; the restored raw history and next live scan are checked too.
    pub(crate) fn restore_horizons(&mut self, counts: [u32; 3]) -> Result<(), String> {
        for (branch, count) in counts.into_iter().enumerate() {
            if count == 0 || count > self.limits.addresses_per_branch {
                return Err("invalid stored HD branch length".into());
            }
            self.derive_through(branch, count as usize)?;
            self.horizon[branch] = count as usize;
            self.minimum[branch] = count as usize;
        }
        Ok(())
    }

    pub(crate) fn addresses(&self) -> Vec<String> {
        self.derived
            .iter()
            .zip(self.horizon)
            .flat_map(|(branch, horizon)| {
                branch[..horizon]
                    .iter()
                    .map(|address| address.address.clone())
            })
            .collect()
    }

    pub(crate) fn interests(&self) -> Vec<WalletInterest> {
        let mut interests = self
            .addresses()
            .iter()
            .map(|address| {
                WalletInterest::script(
                    Address::decode(address)
                        .expect("derived CashAddr")
                        .script_pubkey(),
                )
            })
            .collect::<Vec<_>>();
        interests.sort();
        interests.dedup();
        interests
    }

    pub(crate) fn address_book(&self) -> HdAddressBook {
        HdAddressBook {
            account: self.account,
            account_xpub: self.xpub.clone(),
            branches: std::array::from_fn(|branch| {
                self.derived[branch][..self.horizon[branch]].to_vec()
            }),
            last_used: self.last_used,
        }
    }

    /// Return true only after every branch has an unused gap covering retained
    /// scope. History determines usage; a fully spent address is still used.
    pub(crate) fn advance(&mut self, snapshot: &WalletNetworkSnapshot) -> Result<bool, String> {
        if snapshot.interests != self.interests() {
            return Err("HD response does not cover the requested script scope".into());
        }
        let used = snapshot.used_scripts().map_err(|error| error.to_string())?;
        let mut complete = true;
        for (branch, number) in BRANCHES.iter().enumerate() {
            let mut gap =
                GapScan::with_limits(self.limits.gap_limit, self.limits.addresses_per_branch);
            let mut last_used = None;
            for index in 0..self.horizon[branch] {
                let script = Address::decode(&self.derived[branch][index].address)?.script_pubkey();
                let was_used = used.contains(&script);
                if was_used {
                    last_used = Some(index);
                }
                gap.observe(was_used);
            }
            self.last_used[branch] = last_used.map(|index| index as u32);
            if gap.stop() == Some(ScanStop::GapReached) {
                continue;
            }
            if gap.stop() == Some(ScanStop::CapReached) {
                return Err(format!(
                    "HD branch {} reached its scan cap before an unused gap",
                    number
                ));
            }
            complete = false;
            let required = last_used.map_or(0, |index| index + 1) + self.limits.gap_limit as usize;
            self.horizon[branch] = required
                .max(self.minimum[branch])
                .min(self.limits.addresses_per_branch as usize);
            self.derive_through(branch, self.horizon[branch])?;
        }
        Ok(complete)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        chain::{
            Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, ChainSource,
            ConnectionPolicy, Endpoint, EndpointKind, Evidence, ProtocolFamily, ProviderHealth,
            SourceCatalog, SourceDisposition, SourceId, SourceOrigin,
        },
        chain_service::{
            BackendObservation, ChainBackend, ChainFuture, ChainOperation, ChainPayload,
            ChainRequest, ChainService, ChainTip, ObservedTransaction,
        },
        reconciliation::ReconciliationDecision,
        sync_worker::ProgressiveSyncWorker,
        wallet_sync::WalletSyncError,
        AppRuntime,
    };
    use optn_app::{AppAction, AppState, OpenedWallet, WalletKind};
    use optn_core::{
        hd::{Wallet, BIP39_TEST_VECTOR_MNEMONIC},
        header_hash::sha256d,
        token::TokenData,
    };
    use std::sync::{Arc, Mutex};
    use tokio::sync::Notify;

    const LIMITS: HdSyncLimits = HdSyncLimits {
        gap_limit: 2,
        addresses_per_branch: 6,
    };

    struct Backend {
        id: SourceId,
        endpoint: Endpoint,
        caps: CapabilitySet,
        transactions: Vec<ObservedTransaction>,
        calls: Mutex<Vec<usize>>,
        entered: Notify,
        hold: bool,
    }

    impl ChainBackend for Backend {
        fn source_id(&self) -> &SourceId {
            &self.id
        }
        fn protocol(&self) -> ProtocolFamily {
            ProtocolFamily::Electrum
        }
        fn endpoint(&self) -> Option<&Endpoint> {
            Some(&self.endpoint)
        }
        fn capabilities(&self) -> &CapabilitySet {
            &self.caps
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }
        fn supports(&self, operation: ChainOperation) -> bool {
            operation == ChainOperation::WalletRefresh
        }
        fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            Box::pin(async move {
                let ChainRequest::WalletRefresh {
                    interests,
                    from_height,
                } = request
                else {
                    unreachable!()
                };
                assert!(
                    from_height.is_none(),
                    "each discovery round covers the entire watched scope"
                );
                self.calls.lock().unwrap().push(interests.len());
                self.entered.notify_one();
                if self.hold {
                    std::future::pending::<()>().await;
                }
                Ok(BackendObservation {
                    payload: ChainPayload::WalletRefresh {
                        transactions: self.transactions.clone(),
                        tip: Some(ChainTip {
                            height: 100,
                            hash: [7; 32],
                        }),
                    },
                    evidence: Evidence::ServerAssertion,
                    chain_tip: Some((100, [7; 32])),
                })
            })
        }
    }

    fn service(transactions: Vec<ObservedTransaction>, hold: bool) -> (ChainService, Arc<Backend>) {
        let id = SourceId::new("hd-fixture");
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "fixture".into(),
            port: Some(50001),
        };
        let mut caps = CapabilitySet::default();
        caps.record(
            Capability::UtxoQuery,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        let backend = Arc::new(Backend {
            id: id.clone(),
            endpoint: endpoint.clone(),
            caps,
            transactions,
            calls: Mutex::new(vec![]),
            entered: Notify::new(),
            hold,
        });
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: id.clone(),
                label: "HD fixture".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![endpoint],
                capabilities: Default::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let mut service = ChainService::new(
            catalog,
            ConnectionPolicy::exact(id, ProtocolFamily::Electrum),
        );
        service.register(backend.clone());
        (service, backend)
    }

    fn account() -> (AppRuntime, String) {
        let account = AccountPath::new(145, 1).unwrap(); // imported nondefault Chipnet origin
        let xpub = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
            .unwrap()
            .account_xpub_at(account)
            .unwrap();
        let receive = address_under_account(Network::Chipnet, &xpub, 0, 0)
            .unwrap()
            .address;
        let runtime = AppRuntime::spawn(AppState {
            network: Network::Chipnet,
            wallet: Some(OpenedWallet {
                kind: WalletKind::WatchOnly,
                name: "HD fixture".into(),
                receive_address: receive,
                master_fingerprint: None,
                account_path: account.to_string(),
                multisig_policy: None,
                account_xpub: Some(xpub.clone()),
            }),
            ..Default::default()
        });
        (runtime, xpub)
    }

    fn script(xpub: &str, branch: u32, index: u32) -> Vec<u8> {
        Address::decode(
            &address_under_account(Network::Chipnet, xpub, branch, index)
                .unwrap()
                .address,
        )
        .unwrap()
        .script_pubkey()
    }

    // Serialization fixtures only. The first transaction has no input; these
    // are not consensus or signing fixtures and are never broadcast.
    fn transaction(
        previous: Option<[u8; 32]>,
        outputs: Vec<(u64, Vec<u8>)>,
    ) -> ObservedTransaction {
        let mut raw = vec![2, 0, 0, 0, u8::from(previous.is_some())];
        if let Some(previous) = previous {
            raw.extend_from_slice(&previous);
            raw.extend_from_slice(&[0; 5]); // vout 0, empty scriptSig
            raw.extend_from_slice(&[0xff; 4]);
        }
        raw.extend_from_slice(&optn_core::tx::varint(outputs.len() as u64));
        for (value, script) in outputs {
            raw.extend_from_slice(&value.to_le_bytes());
            raw.extend_from_slice(&optn_core::tx::varint(script.len() as u64));
            raw.extend_from_slice(&script);
        }
        raw.extend_from_slice(&[0; 4]);
        ObservedTransaction {
            txid: sha256d(&raw),
            raw,
            block_height: Some(50),
        }
    }

    fn history(xpub: &str) -> Vec<ObservedTransaction> {
        let receive = transaction(None, vec![(1200, script(xpub, 0, 1))]);
        let change = transaction(Some(receive.txid), vec![(900, script(xpub, 1, 1))]);
        let mut token = TokenData::fungible([9; 32], 42).encode_prefix().unwrap();
        token.extend_from_slice(&script(xpub, 2, 1));
        let final_change = transaction(
            Some(change.txid),
            vec![(800, script(xpub, 1, 3)), (0, token)],
        );
        vec![receive, change, final_change]
    }

    #[tokio::test]
    async fn hd_runtime_finds_spent_receive_change_and_zero_value_defi_tokens() {
        let (runtime, xpub) = account();
        let (mut service, backend) = service(history(&xpub), false);
        let mut worker = ProgressiveSyncWorker::new(Default::default());
        assert_eq!(
            runtime
                .sync_hd_wallet(&mut service, &mut worker, xpub.clone(), LIMITS)
                .await
                .unwrap(),
            ReconciliationDecision::Accepted
        );
        assert_eq!(*backend.calls.lock().unwrap(), [6, 12, 14]);
        let state = runtime.state();
        assert_eq!(state.coins.len(), 2);
        assert_eq!(state.coins.spendable_sats(), 800);
        assert_eq!(
            state
                .coins
                .iter()
                .filter_map(|coin| coin.token())
                .next()
                .unwrap()
                .amount,
            42
        );
        assert_eq!(state.wallet.unwrap().account_path, "m/44'/145'/1'");
        let status = runtime.subscribe_wallet_sync();
        assert!(status.borrow().sync.utxos_fresh);
        assert_eq!(
            status
                .borrow()
                .authoritative
                .as_ref()
                .unwrap()
                .value
                .interests
                .len(),
            14
        );
        // A rescan must not forget already-watched high indexes, even after an
        // unused gap earlier in that branch or when their balance becomes zero.
        assert_eq!(
            runtime
                .sync_hd_wallet(&mut service, &mut worker, xpub, LIMITS)
                .await
                .unwrap(),
            ReconciliationDecision::Accepted
        );
        assert_eq!(*backend.calls.lock().unwrap(), [6, 12, 14, 14]);
    }

    #[derive(Default)]
    struct CheckpointDisk {
        files: std::collections::BTreeMap<[u8; 32], Vec<u8>>,
        writes: u64,
        fail: bool,
        revoke_on_save: Option<Arc<std::sync::atomic::AtomicU64>>,
    }

    #[derive(Clone, Default)]
    struct Checkpoints(Arc<Mutex<CheckpointDisk>>);

    impl crate::wallet_checkpoint::WalletCheckpointStorage for Checkpoints {
        fn load(
            &self,
            id: &[u8; 32],
            key: &optn_core::wallet_pack::PackKey,
        ) -> Result<Option<(crate::wallet_checkpoint::WalletCheckpoint, [u8; 32])>, String>
        {
            self.0
                .lock()
                .unwrap()
                .files
                .get(id)
                .map(|bytes| {
                    Ok((
                        crate::wallet_checkpoint::WalletCheckpoint::open(key, bytes)?,
                        sha256d(bytes),
                    ))
                })
                .transpose()
        }
        fn store(
            &self,
            id: &[u8; 32],
            checkpoint: &crate::wallet_checkpoint::WalletCheckpoint,
            key: &optn_core::wallet_pack::PackKey,
            expected: Option<[u8; 32]>,
        ) -> Result<[u8; 32], String> {
            let mut disk = self.0.lock().unwrap();
            if disk.fail || disk.files.get(id).map(|bytes| sha256d(bytes)) != expected {
                return Err("injected storage failure or stale revision".into());
            }
            disk.writes += 1;
            // Test-only counter; the native adapter uses fallible OS randomness.
            let mut nonce = [0; 12];
            nonce[..8].copy_from_slice(&disk.writes.to_le_bytes());
            let bytes = checkpoint.seal(key, &nonce)?;
            let revision = sha256d(&bytes);
            disk.files.insert(*id, bytes);
            if let Some(revocation) = disk.revoke_on_save.take() {
                revocation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(revision)
        }
    }

    fn private_runtime(
        storage: crate::wallet_security::tests::Storage,
        checkpoints: Checkpoints,
    ) -> AppRuntime {
        let security = crate::wallet_security::WalletSecurity::new(Box::new(storage), None)
            .with_checkpoints(Box::new(checkpoints));
        let (runtime, driver) =
            AppRuntime::new_with_security(AppState::default(), security).unwrap();
        tokio::spawn(driver.run());
        runtime
    }

    #[tokio::test]
    async fn private_hd_checkpoint_lifecycle_is_durable_stale_on_restore_and_cas_guarded() {
        use optn_app::SecretText;
        use optn_transport::WalletSecurityRequest as Request;
        let storage = crate::wallet_security::tests::Storage::default();
        let checkpoints = Checkpoints::default();
        let runtime = private_runtime(storage.clone(), checkpoints.clone());
        let status = runtime
            .wallet_security(Request::Create {
                name: "Public restart fixture".into(),
                mnemonic: SecretText::new(BIP39_TEST_VECTOR_MNEMONIC.into()),
                bip39_passphrase: SecretText::default(),
                password: SecretText::default(),
                confirmation: SecretText::default(),
                network: "chipnet".into(),
                account_path: "m/44'/1'/0'".into(),
            })
            .await
            .unwrap();
        let handle = status.active.unwrap();
        let xpub = runtime.state().wallet.unwrap().account_xpub.unwrap();
        let (mut provider, _) = service(history(&xpub), false);
        let mut worker = ProgressiveSyncWorker::new(Default::default());

        checkpoints.0.lock().unwrap().fail = true;
        assert!(matches!(
            runtime
                .sync_hd_wallet(&mut provider, &mut worker, xpub.clone(), LIMITS)
                .await,
            Err(WalletSyncError::Persistence(_))
        ));
        assert!(runtime.state().coins.is_empty());
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        assert!(checkpoints.0.lock().unwrap().files.is_empty());
        checkpoints.0.lock().unwrap().fail = false;
        runtime
            .sync_hd_wallet(&mut provider, &mut worker, xpub.clone(), LIMITS)
            .await
            .unwrap();
        let outpoint = runtime
            .state()
            .coins
            .iter()
            .find(|coin| coin.token().is_none())
            .unwrap()
            .outpoint();
        runtime
            .dispatch(AppAction::FreezeCoin(outpoint))
            .await
            .unwrap();
        runtime
            .dispatch(AppAction::SetCoinLabel {
                outpoint,
                label: Some("durable hold".into()),
            })
            .await
            .unwrap();
        let before = runtime.state().coins;
        let ciphertext = checkpoints.0.lock().unwrap().files.clone();
        assert!(!ciphertext.values().any(|bytes| bytes
            .windows(xpub.len())
            .any(|window| window == xpub.as_bytes())));

        checkpoints.0.lock().unwrap().fail = true;
        runtime
            .dispatch(AppAction::UnfreezeCoin(outpoint))
            .await
            .unwrap();
        assert_eq!(runtime.state().coins, before);
        assert!(runtime
            .state()
            .notice
            .unwrap()
            .contains("could not be saved"));
        assert_eq!(checkpoints.0.lock().unwrap().files, ciphertext);
        checkpoints.0.lock().unwrap().fail = false;
        runtime
            .wallet_security(Request::ChangePassword {
                current: None,
                password: SecretText::new("new-password".into()),
                confirmation: SecretText::new("new-password".into()),
                epoch: status.epoch,
            })
            .await
            .unwrap();
        assert_eq!(runtime.state().coins, before);
        assert!(runtime
            .subscribe_wallet_sync()
            .borrow()
            .authoritative
            .is_some());
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        assert_eq!(
            checkpoints.0.lock().unwrap().files,
            ciphertext,
            "password rotation does not rekey or lose the restart file"
        );

        let restarted = private_runtime(storage, checkpoints.clone());
        assert!(restarted
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::default()
            })
            .await
            .is_err());
        assert!(restarted.state().wallet.is_none());
        restarted
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::new("new-password".into()),
            })
            .await
            .unwrap();
        assert_eq!(restarted.state().coins, before);
        assert!(!restarted.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        assert!(restarted
            .wallet_for_operation(optn_app::AuthScope::Spend)
            .await
            .is_err());
        restarted
            .dispatch(AppAction::SetCoinLabel {
                outpoint,
                label: Some("newer process".into()),
            })
            .await
            .unwrap();
        let newest = checkpoints.0.lock().unwrap().files.clone();
        runtime
            .dispatch(AppAction::UnfreezeCoin(outpoint))
            .await
            .unwrap();
        assert_eq!(
            runtime.state().coins,
            before,
            "stale process cannot overwrite the newer annotations"
        );
        assert_eq!(checkpoints.0.lock().unwrap().files, newest);

        // A queued lock while synchronous storage finishes cannot publish fresh coins.
        checkpoints.0.lock().unwrap().revoke_on_save = Some(restarted.revocation.clone());
        assert_eq!(
            restarted
                .sync_hd_wallet(&mut provider, &mut worker, xpub, LIMITS)
                .await,
            Err(WalletSyncError::Superseded)
        );
        assert!(!restarted.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        let prior = restarted.state().coins;
        for bytes in checkpoints.0.lock().unwrap().files.values_mut() {
            bytes[0] ^= 1;
        }
        assert!(restarted
            .wallet_security(Request::Open {
                handle,
                password: SecretText::new("new-password".into())
            })
            .await
            .is_err());
        assert_eq!(
            restarted.state().coins,
            prior,
            "corrupt restart data cannot replace an existing wallet session"
        );
    }

    #[tokio::test]
    async fn hd_cap_failure_preserves_previous_wallet_and_marks_it_incomplete() {
        let (runtime, xpub) = account();
        let mut transactions = history(&xpub);
        let (mut initial, _) = service(transactions.clone(), false);
        let mut worker = ProgressiveSyncWorker::new(Default::default());
        runtime
            .sync_hd_wallet(&mut initial, &mut worker, xpub.clone(), LIMITS)
            .await
            .unwrap();
        let before = runtime.state().coins;
        transactions.push(transaction(None, vec![(500, script(&xpub, 0, 5))]));
        // Index 3 drives the scan toward index 5; hitting the cap is not a gap.
        transactions.push(transaction(None, vec![(500, script(&xpub, 0, 3))]));
        let (mut capped, _) = service(transactions, false);
        assert!(matches!(
            runtime
                .sync_hd_wallet(&mut capped, &mut worker, xpub, LIMITS)
                .await,
            Err(WalletSyncError::HdDiscovery(_))
        ));
        assert_eq!(runtime.state().coins, before);
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
    }

    #[tokio::test]
    async fn encrypted_hd_restart_retains_scope_and_holds_but_never_restores_freshness() {
        use crate::wallet_checkpoint::WalletCheckpoint;
        use optn_core::{coins::FreezeReason, wallet_pack::derive_key_with_rounds};
        let (runtime, xpub) = account();
        let (mut initial, _) = service(history(&xpub), false);
        let mut worker = ProgressiveSyncWorker::new(Default::default());
        runtime
            .sync_hd_wallet(&mut initial, &mut worker, xpub.clone(), LIMITS)
            .await
            .unwrap();
        let outpoint = runtime
            .state()
            .coins
            .iter()
            .find(|coin| coin.token().is_none())
            .unwrap()
            .outpoint();
        runtime
            .dispatch(AppAction::FreezeCoin(outpoint))
            .await
            .unwrap();
        runtime
            .dispatch(AppAction::SetCoinLabel {
                outpoint,
                label: Some("retained hold".into()),
            })
            .await
            .unwrap();
        let before = runtime.state().coins;
        let key = derive_key_with_rounds("public checkpoint test fixture", &[33; 16], 1).unwrap();
        let wrong = derive_key_with_rounds("different public test fixture", &[33; 16], 1).unwrap();
        // Fixed nonce under a test-only key for a deterministic corruption test.
        let bytes = runtime
            .wallet_checkpoint()
            .await
            .unwrap()
            .seal(&key, &[44; 12])
            .unwrap();
        assert!(WalletCheckpoint::open(&wrong, &bytes).is_err());
        // Bounded mutation regression: changing any byte of this populated
        // envelope (including its nonce) must fail before restoring anything.
        for index in 0..bytes.len() {
            let mut tampered = bytes.clone();
            tampered[index] ^= 1;
            assert!(WalletCheckpoint::open(&key, &tampered).is_err());
        }
        let plaintext = optn_core::wallet_pack::open(&key, &[44; 12], &bytes[12..]).unwrap();
        let stored: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        for (index, (field, bad_value)) in [
            ("format", serde_json::json!("future-unknown-format")),
            ("branch_lengths", serde_json::json!([0, 4, 4])),
            ("branch_lengths", serde_json::json!([10001, 4, 4])),
            ("annotations", serde_json::json!([])),
        ]
        .into_iter()
        .enumerate()
        {
            let mut malformed = stored.clone();
            malformed[field] = bad_value;
            // Distinct test nonce for each authenticated malformed fixture.
            let nonce = [index as u8; 12];
            let mut malformed_bytes = nonce.to_vec();
            malformed_bytes.extend(
                optn_core::wallet_pack::seal(
                    &key,
                    &nonce,
                    &serde_json::to_vec(&malformed).unwrap(),
                )
                .unwrap(),
            );
            assert!(WalletCheckpoint::open(&key, &malformed_bytes).is_err());
        }
        assert!(runtime
            .restore_wallet_checkpoint(WalletCheckpoint::open(&key, &bytes).unwrap())
            .await
            .is_err());
        assert_eq!(
            runtime.state().coins,
            before,
            "late load must not overwrite current state"
        );

        let (restarted, _) = account();
        restarted
            .restore_wallet_checkpoint(WalletCheckpoint::open(&key, &bytes).unwrap())
            .await
            .unwrap();
        assert_eq!(restarted.state().coins, before);
        assert_eq!(
            restarted.state().coins.get(outpoint).unwrap().freeze(),
            Some(FreezeReason::User)
        );
        assert_eq!(
            restarted.state().wallet.as_ref().unwrap().account_path,
            "m/44'/145'/1'"
        );
        assert!(!restarted.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        for action in [
            AppAction::PrepareSend {
                destination: restarted.state().wallet.unwrap().receive_address,
                amount_sats: 600,
                coin: None,
            },
            AppAction::AuthorizeSpend { now_ms: 10 },
            AppAction::AuthorizeBackground { now_ms: 10 },
        ] {
            restarted.dispatch(AppAction::ClearNotice).await.unwrap();
            restarted.dispatch(action).await.unwrap();
            assert!(restarted.state().spend.is_none());
            assert!(restarted
                .state()
                .notice
                .unwrap()
                .contains("Refresh the wallet"));
        }
        let mut mismatched = runtime.state();
        mismatched.coins = Default::default();
        mismatched.network = Network::Mainnet;
        let foreign = AppRuntime::spawn(mismatched);
        assert!(foreign
            .restore_wallet_checkpoint(WalletCheckpoint::open(&key, &bytes).unwrap())
            .await
            .is_err());
        let locked = AppRuntime::spawn(Default::default());
        assert!(locked
            .restore_wallet_checkpoint(WalletCheckpoint::open(&key, &bytes).unwrap())
            .await
            .is_err());
        let (different, _) = account();
        different
            .dispatch(AppAction::OpenImportedWallet {
                name: "another account".into(),
                receive_address: runtime.state().wallet.unwrap().receive_address,
                account_path: "m/44'/145'/0'".into(),
            })
            .await
            .unwrap();
        assert!(different
            .restore_wallet_checkpoint(WalletCheckpoint::open(&key, &bytes).unwrap())
            .await
            .is_err());

        let (mut live, backend) = service(history(&xpub), false);
        let mut resumed_worker = ProgressiveSyncWorker::new(Default::default());
        restarted
            .sync_hd_wallet(&mut live, &mut resumed_worker, xpub, LIMITS)
            .await
            .unwrap();
        assert_eq!(
            *backend.calls.lock().unwrap(),
            [14],
            "restart must retain all discovered branches"
        );
        assert_eq!(restarted.state().coins, before);
        assert!(restarted.subscribe_wallet_sync().borrow().sync.utxos_fresh);
    }

    #[tokio::test]
    async fn hd_cannot_publish_a_first_address_only_result_and_aborted_tasks_retire() {
        let (runtime, xpub) = account();
        let (mut initial, backend) = service(history(&xpub), false);
        let mut worker = ProgressiveSyncWorker::new(Default::default());
        let address = runtime.state().wallet.unwrap().receive_address;
        for kind in [WalletKind::Seed, WalletKind::Hardware] {
            let mut state = runtime.state();
            let wallet = state.wallet.as_mut().unwrap();
            wallet.kind = kind;
            wallet.account_xpub = None; // missing public material is not single-address permission
            let subject = AppRuntime::spawn(state);
            assert!(matches!(
                subject
                    .sync_wallet(&mut initial, &mut worker, vec![address.clone()], None)
                    .await,
                Err(WalletSyncError::InvalidScope(_))
            ));
        }
        assert!(matches!(
            runtime
                .sync_wallet(&mut initial, &mut worker, vec![address], None)
                .await,
            Err(WalletSyncError::InvalidScope(_))
        ));
        assert!(
            backend.calls.lock().unwrap().is_empty(),
            "HD bypass must be rejected before provider I/O"
        );
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        runtime
            .sync_hd_wallet(&mut initial, &mut worker, xpub.clone(), LIMITS)
            .await
            .unwrap();
        let before = runtime.state().coins;

        let (mut held, backend) = service(history(&xpub), true);
        let task_runtime = runtime.clone();
        let task_xpub = xpub.clone();
        let task = tokio::spawn(async move {
            task_runtime
                .sync_hd_wallet(&mut held, &mut worker, task_xpub, LIMITS)
                .await
        });
        backend.entered.notified().await;
        let mut status = runtime.subscribe_wallet_sync();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if status.borrow().sync.degraded_reason.as_deref()
                    == Some("wallet refresh cancelled before completion")
                {
                    break;
                }
                status.changed().await.unwrap();
            }
        })
        .await
        .expect("dropping the caller retires the active lease without another request");
        assert_eq!(runtime.state().coins, before);
        assert!(!status.borrow().sync.utxos_fresh);
        let mut worker = ProgressiveSyncWorker::new(Default::default());
        runtime
            .sync_hd_wallet(&mut initial, &mut worker, xpub, LIMITS)
            .await
            .unwrap();
        assert!(status.borrow().sync.utxos_fresh);
        assert_eq!(runtime.state().coins, before);
    }

    #[tokio::test]
    async fn fresh_hd_history_is_not_password_verification() {
        let (fixture, xpub) = account();
        let mut initial = fixture.state();
        initial.surface = optn_app::AppSurface::Desktop;
        initial.wallet.as_mut().unwrap().kind = WalletKind::Seed;
        initial.lock.mark_unlocked();
        initial.lock.observe(1); // The original unlock approval is expired below.
        let (runtime, mut driver) = AppRuntime::new(initial);
        driver.started = std::time::Instant::now() - std::time::Duration::from_millis(1_000_000);
        tokio::spawn(driver.run());
        let (mut service, _) = service(history(&xpub), false);
        runtime
            .sync_hd_wallet(
                &mut service,
                &mut ProgressiveSyncWorker::new(Default::default()),
                xpub,
                LIMITS,
            )
            .await
            .unwrap();
        assert!(runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        for action in [
            AppAction::RequestReveal { now_ms: 1_000_000 },
            AppAction::AuthorizeSpend { now_ms: 1_000_000 },
        ] {
            runtime.dispatch(action).await.unwrap();
            let before = runtime.state().lock;
            assert!(before.prompt.is_some());
            let transport = crate::DirectTransport::new(runtime.clone());
            let wire =
                optn_transport::WireAction::from(AppAction::ConfirmAuth { now_ms: 1_000_001 });
            assert!(AppAction::try_from(wire).is_err());
            assert!(optn_transport::AppTransport::dispatch(
                &transport,
                AppAction::ConfirmAuth { now_ms: 1_000_001 }
            )
            .await
            .is_err());
            assert_eq!(runtime.state().lock, before);
            assert!(!runtime.state().identity_revealed);
            runtime.dispatch(AppAction::CancelAuth).await.unwrap();
        }
    }

    #[tokio::test]
    async fn locking_cancels_an_hd_provider_request_before_it_can_continue() {
        let (runtime, xpub) = account();
        let (mut service, backend) = service(history(&xpub), true);
        let mut worker = ProgressiveSyncWorker::new(Default::default());
        let task_runtime = runtime.clone();
        let task = tokio::spawn(async move {
            task_runtime
                .sync_hd_wallet(&mut service, &mut worker, xpub, LIMITS)
                .await
        });
        backend.entered.notified().await;
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap(),
            Err(WalletSyncError::Superseded)
        );
        assert_eq!(*backend.calls.lock().unwrap(), [6]);
        assert!(runtime.state().wallet.is_none());
        assert!(runtime
            .subscribe_wallet_sync()
            .borrow()
            .authoritative
            .is_none());
    }
}

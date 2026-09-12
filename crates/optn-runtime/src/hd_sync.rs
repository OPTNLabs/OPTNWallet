//! Public-key HD discovery planning. The runtime performs provider I/O and
//! publishes only after every ordinary branch reaches a complete unused gap.

use crate::{chain_service::WalletInterest, sync_worker::WalletNetworkSnapshot};
use optn_core::{
    cashaddr::Address,
    discovery::{GapScan, ScanStop, ADDRESS_CAP, GAP_LIMIT},
    hd::AccountPath,
    network::Network,
    watch_only::{
        address_under_account, parse_account_xpub, HdAddressBook, PublicAddressPreview,
        HD_SCAN_BRANCHES as BRANCHES,
    },
};
use std::collections::BTreeSet;

pub(crate) use optn_core::watch_only::MAX_HD_ADDRESSES_PER_BRANCH as MAX_HD_BRANCH_ADDRESSES;

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
    derived: [Vec<PublicAddressPreview>; 4],
    horizon: [usize; 4],
    minimum: [usize; 4],
    last_used: [Option<u32>; 4],
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
            horizon: [gap; 4],
            minimum: [gap; 4],
            last_used: [None; 4],
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
    /// A migrated v1 checkpoint has no observed DeFi (7) scope. Its zero stays
    /// unscanned here; the next live scan is constructed with all four branches.
    pub(crate) fn restore_horizons(&mut self, counts: [u32; 4]) -> Result<(), String> {
        if counts.iter().enumerate().any(|(branch, &count)| {
            (count == 0 && BRANCHES[branch] != 7) || count > self.limits.addresses_per_branch
        }) {
            return Err("invalid stored HD branch length".into());
        }
        for (branch, count) in counts.into_iter().enumerate() {
            self.derive_through(branch, count as usize)?;
            self.horizon[branch] = count as usize;
            self.minimum[branch] = count as usize;
        }
        self.last_used = [None; 4];
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

    /// Return true only after every requested branch has an unused gap covering
    /// retained scope. Migrated unscanned DeFi remains absent until a new live
    /// scan; it is not evidence of an empty branch. Fully spent addresses are used.
    pub(crate) fn advance(&mut self, snapshot: &WalletNetworkSnapshot) -> Result<bool, String> {
        if snapshot.interests != self.interests() {
            return Err("HD response does not cover the requested script scope".into());
        }
        let used = snapshot.used_scripts().map_err(|error| error.to_string())?;
        let mut complete = true;
        for (branch, number) in BRANCHES.iter().enumerate() {
            if self.horizon[branch] == 0 {
                continue;
            }
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

    fn fixture_password(which: u8) -> String {
        (0..10)
            .map(|i| char::from(b'a' + which.wrapping_add(i).wrapping_add(3) % 26))
            .collect()
    }

    fn fixture_salt(which: u8) -> [u8; 16] {
        core::array::from_fn(|i| which.wrapping_mul(19).wrapping_add(i as u8).wrapping_add(5))
    }

    fn fixture_nonce(which: u64) -> [u8; 12] {
        core::array::from_fn(|i| {
            let lane = (which.wrapping_mul(0x9E3779B97F4A7C15) >> ((i % 8) * 8)) as u8;
            lane.wrapping_add(i as u8).wrapping_add(1)
        })
    }
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
        floors: Mutex<Vec<Option<u32>>>,
        expected_floor: Mutex<Option<u32>>,
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
                assert_eq!(
                    *from_height,
                    *self.expected_floor.lock().unwrap(),
                    "every discovery round must retain the expected floor (none by default)"
                );
                self.calls.lock().unwrap().push(interests.len());
                self.floors.lock().unwrap().push(*from_height);
                self.entered.notify_one();
                if self.hold {
                    std::future::pending::<()>().await;
                }
                Ok(BackendObservation {
                    payload: ChainPayload::WalletRefresh {
                        transactions: self
                            .transactions
                            .iter()
                            .filter(|tx| match (tx.block_height, from_height) {
                                (Some(height), Some(floor)) => height >= *floor,
                                _ => true,
                            })
                            .cloned()
                            .collect(),
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
            floors: Mutex::new(vec![]),
            expected_floor: Mutex::new(None),
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
    async fn hd_runtime_finds_spent_receive_change_and_zero_value_compatibility_tokens() {
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
        assert_eq!(*backend.calls.lock().unwrap(), [8, 14, 16]);
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
            16
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
        assert_eq!(*backend.calls.lock().unwrap(), [8, 14, 16, 16]);
    }

    #[tokio::test]
    async fn hd_scan_discovers_canonical_defi_and_compatibility_funds_together() {
        let (runtime, xpub) = account();
        let mut transactions = history(&xpub);
        let mut token = TokenData::fungible([8; 32], 99).encode_prefix().unwrap();
        token.extend_from_slice(&script(&xpub, 7, 1));
        transactions.push(transaction(
            None,
            vec![
                (500, script(&xpub, 7, 1)),
                (0, token),
                (300, script(&xpub, 2, 0)),
            ],
        ));
        let (mut service, backend) = service(transactions, false);
        runtime
            .sync_hd_wallet(
                &mut service,
                &mut ProgressiveSyncWorker::new(Default::default()),
                xpub.clone(),
                LIMITS,
            )
            .await
            .unwrap();
        assert_eq!(*backend.calls.lock().unwrap(), [8, 16, 18]);
        let state = runtime.state();
        assert_eq!(state.coins.len(), 5);
        assert_eq!(state.coins.spendable_sats(), 1600);
        for (branch, index, amount) in [(7, 1, 99), (2, 1, 42)] {
            let address = address_under_account(Network::Chipnet, &xpub, branch, index)
                .unwrap()
                .address;
            assert!(state.coins.iter().any(|coin| coin.address() == address
                && coin.token().is_some_and(|token| token.amount == amount)));
        }
        for (branch, index, amount) in [(7, 1, 500), (2, 0, 300)] {
            let address = address_under_account(Network::Chipnet, &xpub, branch, index)
                .unwrap()
                .address;
            assert!(state.coins.iter().any(|coin| coin.address() == address
                && coin.token().is_none()
                && coin.value_sats() == amount));
        }
        let status = runtime.subscribe_wallet_sync().borrow().clone();
        assert!(status.sync.utxos_fresh);
        let book = status.authoritative.unwrap().value.hd.unwrap();
        assert_eq!(book.last_used, [Some(1), Some(3), Some(1), Some(1)]);
        assert_eq!(book.allocation_last_used(), [Some(1), Some(3), Some(1)]);
        assert_eq!(book.branches[2][1].path, "m/44'/145'/1'/7/1");
        assert_eq!(book.branches[3][1].path, "m/44'/145'/1'/2/1");
    }

    #[tokio::test]
    async fn hd_restore_keeps_migrated_defi_unscanned_until_a_new_live_scan() {
        let (_, xpub) = account();
        let account = AccountPath::new(145, 1).unwrap();
        let mut restored = HdAccountScan::new(
            Network::Chipnet,
            xpub.clone(),
            account,
            LIMITS,
            Default::default(),
        )
        .unwrap();
        restored.restore_horizons([4, 6, 0, 4]).unwrap();
        let snapshot = WalletNetworkSnapshot {
            hd: None,
            interests: restored.interests(),
            transactions: history(&xpub),
            tip: Some(ChainTip {
                height: 100,
                hash: [7; 32],
            }),
        };
        assert_eq!(snapshot.interests.len(), 14);
        for _ in 0..2 {
            assert!(restored.advance(&snapshot).unwrap());
            assert_eq!(restored.interests(), snapshot.interests);
            let book = restored.address_book();
            assert!(book.branches[2].is_empty());
            assert_eq!(book.last_used, [Some(1), Some(3), None, Some(1)]);
            assert_eq!(book.branches[3][1].path, "m/44'/145'/1'/2/1");
        }
        let required = restored
            .addresses()
            .iter()
            .map(|address| Address::decode(address).unwrap().script_pubkey())
            .collect();
        let live =
            HdAccountScan::new(Network::Chipnet, xpub.clone(), account, LIMITS, required).unwrap();
        assert_eq!(live.interests().len(), 16);
        assert_eq!(live.address_book().branches[2].len(), 2);
        assert!(live
            .interests()
            .contains(&WalletInterest::script(script(&xpub, 7, 0))));
    }

    #[tokio::test]
    async fn hd_restore_rejects_zero_nonmigration_branches_and_caps_without_mutation() {
        let (_, xpub) = account();
        let mut scan = HdAccountScan::new(
            Network::Chipnet,
            xpub,
            AccountPath::new(145, 1).unwrap(),
            LIMITS,
            Default::default(),
        )
        .unwrap();
        let before = scan.address_book();
        for counts in [
            [0, 2, 2, 2],
            [2, 0, 2, 2],
            [2, 2, 2, 0],
            [2, 2, 0, 7],
            [2, 2, 7, 2],
        ] {
            assert!(scan.restore_horizons(counts).is_err());
            assert_eq!(scan.address_book(), before);
        }
    }

    #[derive(Default)]
    struct CheckpointDisk {
        files: std::collections::BTreeMap<[u8; 32], Vec<u8>>,
        writes: u64,
        fail: bool,
        revoke_on_save: Option<Arc<std::sync::atomic::AtomicU64>>,
        after_save: Option<Box<dyn FnOnce() + Send>>,
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
            // Distinct per write, derived from the counter — not a compiled-in nonce.
            // The native adapter uses fallible OS randomness.
            let nonce = fixture_nonce(disk.writes);
            let bytes = checkpoint.seal(key, &nonce)?;
            let revision = sha256d(&bytes);
            disk.files.insert(*id, bytes);
            if let Some(revocation) = disk.revoke_on_save.take() {
                revocation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            if let Some(after_save) = disk.after_save.take() {
                after_save();
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
    async fn private_hd_manual_rescan_persists_floor_across_failure_restart_and_cancellation() {
        use optn_app::{ScanCoverageView, SecretText};
        use optn_transport::WalletSecurityRequest as Request;

        let storage = crate::wallet_security::tests::Storage::default();
        let checkpoints = Checkpoints::default();
        let runtime = private_runtime(storage.clone(), checkpoints.clone());
        let opened = runtime
            .wallet_security(Request::Create {
                name: "Public manual rescan fixture".into(),
                mnemonic: SecretText::new(BIP39_TEST_VECTOR_MNEMONIC.into()),
                bip39_passphrase: SecretText::default(),
                password: SecretText::default(),
                confirmation: SecretText::default(),
                network: "chipnet".into(),
                // Separate public account for this fixture's checkpoint nonce stream.
                account_path: "m/44'/1'/4'".into(),
            })
            .await
            .unwrap();
        let handle = opened.active.unwrap();
        let xpub = runtime.state().wallet.unwrap().account_xpub.unwrap();
        let mut transactions = history(&xpub);
        let mut below_floor = transaction(None, vec![(77, script(&xpub, 0, 0))]);
        below_floor.block_height = Some(0);
        transactions.push(below_floor);
        let (mut chain, backend) = service(transactions.clone(), false);
        *backend.expected_floor.lock().unwrap() = Some(1);
        let original = checkpoints.0.lock().unwrap().files.clone();
        let before_io = backend.clone();
        checkpoints.0.lock().unwrap().after_save = Some(Box::new(move || {
            assert!(before_io.calls.lock().unwrap().is_empty());
        }));
        runtime.request_wallet_rescan(1).await.unwrap();
        assert_eq!(runtime.state().wallet_sync.rescan_requested, Some(1));
        let pending = checkpoints.0.lock().unwrap().files.clone();
        assert_ne!(
            pending, original,
            "intent must reach encrypted storage before I/O"
        );
        assert!(backend.calls.lock().unwrap().is_empty());

        // Reopening from ciphertext, before any provider call, must recover intent.
        let restarted = private_runtime(storage.clone(), checkpoints.clone());
        restarted
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::default(),
            })
            .await
            .unwrap();
        assert_eq!(restarted.state().wallet_sync.rescan_requested, Some(1));
        assert!(restarted.state().coins.is_empty());
        let mut worker = ProgressiveSyncWorker::new(Default::default());

        // A complete provider response cannot clear pending intent or publish
        // coins when its final checkpoint fails to persist.
        checkpoints.0.lock().unwrap().fail = true;
        assert!(matches!(
            restarted
                .sync_hd_wallet(&mut chain, &mut worker, xpub.clone(), LIMITS)
                .await,
            Err(WalletSyncError::Persistence(_))
        ));
        assert_eq!(*backend.calls.lock().unwrap(), [8, 14, 16]);
        assert_eq!(*backend.floors.lock().unwrap(), [Some(1); 3]);
        assert_eq!(restarted.state().wallet_sync.rescan_requested, Some(1));
        assert!(restarted.state().coins.is_empty());
        assert_eq!(restarted.state().wallet_sync.scan_coverage, None);
        assert_eq!(checkpoints.0.lock().unwrap().files, pending);
        checkpoints.0.lock().unwrap().fail = false;
        assert_eq!(
            restarted
                .sync_hd_wallet(&mut chain, &mut worker, xpub.clone(), LIMITS)
                .await
                .unwrap(),
            ReconciliationDecision::Accepted
        );
        let coverage = Some(ScanCoverageView {
            from_height: 1,
            skipped_below: Some(1),
            chosen_by_holder: true,
        });
        assert_eq!(*backend.calls.lock().unwrap(), [8, 14, 16, 8, 14, 16]);
        assert_eq!(*backend.floors.lock().unwrap(), [Some(1); 6]);
        assert_eq!(restarted.state().wallet_sync.rescan_requested, None);
        assert_eq!(restarted.state().wallet_sync.scan_coverage, coverage);
        assert_eq!(restarted.state().coins.len(), 2);
        assert_eq!(restarted.state().coins.spendable_sats(), 800);
        let committed = checkpoints.0.lock().unwrap().files.clone();
        assert_ne!(committed, pending);

        let resumed = private_runtime(storage.clone(), checkpoints.clone());
        resumed
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::default(),
            })
            .await
            .unwrap();
        assert_eq!(resumed.state().wallet_sync.rescan_requested, None);
        assert_eq!(resumed.state().wallet_sync.scan_coverage, coverage);
        assert_eq!(resumed.state().coins, restarted.state().coins);
        assert!(!resumed.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        // No explicit floor: completed coverage must seed future default syncs.
        let (mut future_chain, future_backend) = service(transactions.clone(), false);
        *future_backend.expected_floor.lock().unwrap() = Some(1);
        resumed
            .sync_hd_wallet(
                &mut future_chain,
                &mut ProgressiveSyncWorker::new(Default::default()),
                xpub.clone(),
                LIMITS,
            )
            .await
            .unwrap();
        assert_eq!(*future_backend.calls.lock().unwrap(), [16]);
        assert_eq!(*future_backend.floors.lock().unwrap(), [Some(1)]);
        assert_eq!(resumed.state().wallet_sync.scan_coverage, coverage);

        // A failed request preserves populated state and ciphertext while
        // persistence invalidates freshness fail-closed.
        let before = resumed.state();
        let committed = checkpoints.0.lock().unwrap().files.clone();
        checkpoints.0.lock().unwrap().fail = true;
        assert!(matches!(
            resumed.request_wallet_rescan(2).await,
            Err(WalletSyncError::Persistence(_))
        ));
        assert_eq!(
            resumed.state().wallet_sync.rescan_requested,
            before.wallet_sync.rescan_requested
        );
        assert_eq!(resumed.state().wallet_sync.scan_coverage, coverage);
        assert_eq!(resumed.state().coins, before.coins);
        assert_eq!(checkpoints.0.lock().unwrap().files, committed);
        assert!(!resumed.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        checkpoints.0.lock().unwrap().fail = false;

        // Start a new hanging lease after the failure. A successfully persisted
        // replacement request must cancel this older scan before it can publish.
        let (mut held, held_backend) = service(transactions, true);
        *held_backend.expected_floor.lock().unwrap() = Some(1);
        let scanning = resumed.clone();
        let task = tokio::spawn(async move {
            scanning
                .sync_hd_wallet(
                    &mut held,
                    &mut ProgressiveSyncWorker::new(Default::default()),
                    xpub,
                    LIMITS,
                )
                .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            held_backend.entered.notified(),
        )
        .await
        .unwrap();
        resumed.request_wallet_rescan(2).await.unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap(),
            Err(WalletSyncError::Superseded)
        );
        assert_eq!(*held_backend.floors.lock().unwrap(), [Some(1)]);
        assert_eq!(resumed.state().wallet_sync.rescan_requested, Some(2));
        assert_eq!(resumed.state().coins, before.coins);
        assert_ne!(checkpoints.0.lock().unwrap().files, committed);
        let final_restart = private_runtime(storage, checkpoints);
        final_restart
            .wallet_security(Request::Open {
                handle,
                password: SecretText::default(),
            })
            .await
            .unwrap();
        assert_eq!(final_restart.state().wallet_sync.rescan_requested, Some(2));
        assert_eq!(final_restart.state().wallet_sync.scan_coverage, coverage);
        assert_eq!(final_restart.state().coins, before.coins);
    }

    #[tokio::test]
    async fn cancelled_hd_commit_requires_reload_before_allocating_again() {
        use optn_app::SecretText;
        use optn_transport::WalletSecurityRequest as Request;
        use std::{
            future::{poll_fn, Future},
            task::Poll,
        };

        let storage = crate::wallet_security::tests::Storage::default();
        let checkpoints = Checkpoints::default();
        let runtime = private_runtime(storage.clone(), checkpoints.clone());
        let opened = runtime
            .wallet_security(Request::Create {
                name: "Public cancelled sync fixture".into(),
                mnemonic: SecretText::new(BIP39_TEST_VECTOR_MNEMONIC.into()),
                bip39_passphrase: SecretText::default(),
                password: SecretText::default(),
                confirmation: SecretText::default(),
                network: "chipnet".into(),
                // Distinct public account keeps this mock nonce stream on its own key.
                account_path: "m/44'/1'/2'".into(),
            })
            .await
            .unwrap();
        let handle = opened.active.unwrap();
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(0)
        );
        let original = checkpoints.0.lock().unwrap().files.clone();
        let generation = runtime.revocation.load(std::sync::atomic::Ordering::SeqCst);
        let xpub = runtime.state().wallet.unwrap().account_xpub.unwrap();
        let (mut service, _) = service(history(&xpub), false);
        let syncing = runtime.clone();
        let pending = Arc::new(Mutex::new(Some(Box::pin(async move {
            syncing
                .sync_hd_wallet(
                    &mut service,
                    &mut ProgressiveSyncWorker::new(Default::default()),
                    xpub,
                    LIMITS,
                )
                .await
        }))));
        let (committed, cancelled) = tokio::sync::oneshot::channel();
        let cancel_pending = pending.clone();
        checkpoints.0.lock().unwrap().after_save = Some(Box::new(move || {
            // Drop the actual sync future, closing its Finish reply during the
            // synchronous store. No global revocation or wallet lock is injected.
            drop(cancel_pending.lock().unwrap().take().unwrap());
            committed.send(()).unwrap();
        }));
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::select! {
                closed = cancelled => closed.unwrap(),
                outcome = poll_fn(|cx| {
                    match pending.lock().unwrap().as_mut() {
                        Some(future) => future.as_mut().poll(cx),
                        None => Poll::Pending,
                    }
                }) => panic!("sync completed before cancellation hook: {outcome:?}"),
            }
        })
        .await
        .unwrap();
        // Queue a harmless actor turn so all post-store publication checks finish.
        runtime.dispatch(AppAction::ClearNotice).await.unwrap();
        assert!(pending.lock().unwrap().is_none());
        assert_eq!(
            runtime.revocation.load(std::sync::atomic::Ordering::SeqCst),
            generation
        );
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(0)
        );
        assert!(runtime.state().coins.is_empty());
        assert!(runtime
            .subscribe_wallet_sync()
            .borrow()
            .authoritative
            .is_none());
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        let saved = checkpoints.0.lock().unwrap().files.clone();
        assert_ne!(saved, original, "the cancelled result really committed");
        assert!(
            runtime
                .wallet_security(Request::NextReceive {
                    epoch: opened.epoch,
                    acknowledge_gap: false,
                })
                .await
                .is_err(),
            "old memory must not allocate index 1 using the committed revision"
        );
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(0)
        );
        assert_eq!(checkpoints.0.lock().unwrap().files, saved);

        let restarted = private_runtime(storage, checkpoints);
        let reopened = restarted
            .wallet_security(Request::Open {
                handle,
                password: SecretText::default(),
            })
            .await
            .unwrap();
        assert_eq!(
            restarted.state().hd_addresses.unwrap().current_receive(),
            Some(2)
        );
        assert_eq!(restarted.state().coins.len(), 2);
        assert!(!restarted.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        restarted
            .wallet_security(Request::NextReceive {
                epoch: reopened.epoch,
                acknowledge_gap: false,
            })
            .await
            .unwrap();
        assert_eq!(
            restarted.state().hd_addresses.unwrap().current_receive(),
            Some(3)
        );
    }

    #[tokio::test]
    async fn hd_commit_post_store_read_failure_requires_reload() {
        use optn_app::SecretText;
        use optn_platform::WalletStorage;
        use optn_transport::WalletSecurityRequest as Request;
        let storage = crate::wallet_security::tests::Storage::default();
        let checkpoints = Checkpoints::default();
        let runtime = private_runtime(storage.clone(), checkpoints.clone());
        let opened = runtime
            .wallet_security(Request::Create {
                name: "Public post-store read fixture".into(),
                mnemonic: SecretText::new(BIP39_TEST_VECTOR_MNEMONIC.into()),
                bip39_passphrase: SecretText::default(),
                password: SecretText::default(),
                confirmation: SecretText::default(),
                network: "chipnet".into(),
                // Keep deterministic checkpoint nonces separate from other test keys.
                account_path: "m/44'/1'/3'".into(),
            })
            .await
            .unwrap();
        let handle = opened.active.unwrap();
        let original = checkpoints.0.lock().unwrap().files.clone();
        let fail_read = storage.clone();
        checkpoints.0.lock().unwrap().after_save =
            Some(Box::new(move || fail_read.fail_next_read()));
        let xpub = runtime.state().wallet.unwrap().account_xpub.unwrap();
        let (mut service, _) = service(history(&xpub), false);
        assert!(matches!(
            runtime
                .sync_hd_wallet(
                    &mut service,
                    &mut ProgressiveSyncWorker::new(Default::default()),
                    xpub,
                    LIMITS,
                )
                .await,
            Err(WalletSyncError::Persistence(_))
        ));
        let committed = checkpoints.0.lock().unwrap().files.clone();
        assert_ne!(committed, original);
        assert!(
            storage.read(&handle).is_ok(),
            "one-shot storage fault has cleared"
        );
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(0)
        );
        assert!(runtime.state().coins.is_empty());
        assert!(runtime
            .subscribe_wallet_sync()
            .borrow()
            .authoritative
            .is_none());
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        assert!(
            runtime
                .wallet_security(Request::NextReceive {
                    epoch: opened.epoch,
                    acknowledge_gap: false,
                })
                .await
                .is_err(),
            "a recovered file read must not allow stale allocation"
        );
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(0)
        );
        assert_eq!(checkpoints.0.lock().unwrap().files, committed);
        let reopened = runtime
            .wallet_security(Request::Open {
                handle,
                password: SecretText::default(),
            })
            .await
            .unwrap();
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(2)
        );
        assert_eq!(runtime.state().coins.len(), 2);
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        runtime
            .wallet_security(Request::NextReceive {
                epoch: reopened.epoch,
                acknowledge_gap: false,
            })
            .await
            .unwrap();
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(3)
        );
    }

    #[tokio::test]
    async fn private_receive_allocation_persists_before_publish_and_cancels_older_scan() {
        use optn_app::SecretText;
        use optn_transport::WalletSecurityRequest as Request;
        let storage = crate::wallet_security::tests::Storage::default();
        let checkpoints = Checkpoints::default();
        let runtime = private_runtime(storage.clone(), checkpoints.clone());
        let opened = runtime
            .wallet_security(Request::Create {
                name: "Public allocation fixture".into(),
                mnemonic: SecretText::new(BIP39_TEST_VECTOR_MNEMONIC.into()),
                bip39_passphrase: SecretText::default(),
                password: SecretText::default(),
                confirmation: SecretText::default(),
                network: "chipnet".into(),
                // Separate public fixture account keeps the checkpoint key
                // distinct from the lifecycle test's deterministic nonce stream.
                account_path: "m/44'/1'/1'".into(),
            })
            .await
            .unwrap();
        let handle = opened.active.unwrap();
        let next = || Request::NextReceive {
            epoch: opened.epoch,
            acknowledge_gap: false,
        };
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(0)
        );
        assert_eq!(checkpoints.0.lock().unwrap().writes, 1);
        assert!(runtime
            .subscribe_wallet_sync()
            .borrow()
            .authoritative
            .is_none());
        runtime.wallet_security(next()).await.unwrap();
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(1)
        );
        let before = runtime.state();
        let committed = checkpoints.0.lock().unwrap().files.clone();
        checkpoints.0.lock().unwrap().fail = true;
        assert!(runtime.wallet_security(next()).await.is_err());
        assert_eq!(runtime.state().hd_addresses, before.hd_addresses);
        assert_eq!(runtime.state().wallet, before.wallet);
        assert_eq!(checkpoints.0.lock().unwrap().files, committed);
        checkpoints.0.lock().unwrap().fail = false;
        runtime.wallet_security(next()).await.unwrap();
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(2)
        );

        let restarted = private_runtime(storage.clone(), checkpoints.clone());
        let reopened = restarted
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::default(),
            })
            .await
            .unwrap();
        assert_eq!(restarted.state().hd_addresses, runtime.state().hd_addresses);
        assert_eq!(restarted.state().wallet, runtime.state().wallet);
        let next_restarted = || Request::NextReceive {
            epoch: reopened.epoch,
            acknowledge_gap: false,
        };
        restarted.wallet_security(next_restarted()).await.unwrap();
        assert_eq!(
            restarted.state().hd_addresses.unwrap().current_receive(),
            Some(3)
        );
        let newest = checkpoints.0.lock().unwrap().files.clone();
        assert!(runtime.wallet_security(next()).await.is_err());
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(2)
        );
        assert_eq!(
            checkpoints.0.lock().unwrap().files,
            newest,
            "stale process cannot overwrite allocation"
        );

        let xpub = restarted.state().wallet.unwrap().account_xpub.unwrap();
        let (mut held, backend) = service(history(&xpub), true);
        let scanning = restarted.clone();
        let task = tokio::spawn(async move {
            scanning
                .sync_hd_wallet(
                    &mut held,
                    &mut ProgressiveSyncWorker::new(Default::default()),
                    xpub,
                    LIMITS,
                )
                .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            backend.entered.notified(),
        )
        .await
        .unwrap();
        restarted.wallet_security(next_restarted()).await.unwrap();
        assert_eq!(
            restarted.state().hd_addresses.unwrap().current_receive(),
            Some(4)
        );
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap(),
            Err(WalletSyncError::Superseded)
        );
        assert!(restarted.state().coins.is_empty());
        assert!(!restarted.subscribe_wallet_sync().borrow().sync.utxos_fresh);

        // A revocation at the real storage boundary hides the committed address,
        // but reopening must retain its consumed index instead of reusing it.
        checkpoints.0.lock().unwrap().revoke_on_save = Some(restarted.revocation.clone());
        assert!(restarted.wallet_security(next_restarted()).await.is_err());
        assert!(restarted.state().wallet.is_none());
        let after_revocation = private_runtime(storage, checkpoints);
        after_revocation
            .wallet_security(Request::Open {
                handle,
                password: SecretText::default(),
            })
            .await
            .unwrap();
        assert_eq!(
            after_revocation
                .state()
                .hd_addresses
                .unwrap()
                .current_receive(),
            Some(5)
        );
        assert!(
            !after_revocation
                .subscribe_wallet_sync()
                .borrow()
                .sync
                .utxos_fresh
        );
    }

    #[tokio::test]
    async fn managed_watch_only_checkpoint_lifecycle_preserves_history_without_signing_authority() {
        use optn_app::{AuthScope, ScanCoverageView, SecretText};
        use optn_platform::WalletStorage;
        use optn_transport::WalletSecurityRequest as Request;

        async fn refuses_operation_wallets(runtime: &AppRuntime) {
            assert_eq!(runtime.state().wallet.unwrap().kind, WalletKind::WatchOnly);
            for scope in [
                AuthScope::Spend,
                AuthScope::Reveal,
                AuthScope::Background,
                AuthScope::Chat,
            ] {
                let Err(error) = runtime.wallet_for_operation(scope).await else {
                    panic!("watch-only must not yield private material for {scope:?}");
                };
                // A stale wallet can be rejected first by the actor's freshness
                // guard. Once fresh, rejection must be the capability boundary.
                if runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh {
                    assert_eq!(error, optn_transport::TransportError::Unsupported);
                }
            }
        }

        // Only this public fixture's account xpub enters the managed runtime.
        let xpub = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
            .unwrap()
            .account_xpub_at(AccountPath::new(1, 6).unwrap())
            .unwrap();
        let password = fixture_password(6);
        let rotated = fixture_password(7);
        let storage = crate::wallet_security::tests::Storage::default();
        let checkpoints = Checkpoints::default();
        let runtime = private_runtime(storage.clone(), checkpoints.clone());
        let opened = runtime
            .wallet_security(Request::ImportWatchOnly {
                name: "Managed public account".into(),
                account_xpub: SecretText::new(xpub.clone()),
                master_fingerprint: "73c5da0a".into(),
                password: SecretText::new(password.clone()),
                confirmation: SecretText::new(password.clone()),
                network: "chipnet".into(),
                account_path: "m/44'/1'/6'".into(),
            })
            .await
            .unwrap();
        let handle = opened.active.unwrap();
        let record = storage.read(&handle).unwrap();
        assert!(!record
            .windows(xpub.len())
            .any(|window| window == xpub.as_bytes()));
        assert_eq!(
            storage.list().unwrap().as_slice(),
            std::slice::from_ref(&handle)
        );
        let initial = checkpoints.0.lock().unwrap().files.clone();
        assert_eq!(initial.len(), 1, "first allocation must already be durable");
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(0)
        );
        refuses_operation_wallets(&runtime).await;

        // Verifying the storage password must not upgrade the public account.
        runtime
            .dispatch(AppAction::RequestReveal { now_ms: 0 })
            .await
            .unwrap();
        runtime
            .wallet_security(Request::Authenticate {
                password: SecretText::new(password.clone()),
                epoch: runtime.state().lock.unlock_epoch,
            })
            .await
            .unwrap();
        assert!(runtime.state().identity_revealed);
        refuses_operation_wallets(&runtime).await;

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
        assert!(runtime.state().wallet_sync.history.is_empty());
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        assert_eq!(checkpoints.0.lock().unwrap().files, initial);
        checkpoints.0.lock().unwrap().fail = false;
        assert_eq!(
            runtime
                .sync_hd_wallet(&mut provider, &mut worker, xpub.clone(), LIMITS)
                .await
                .unwrap(),
            ReconciliationDecision::Accepted
        );
        let coins = runtime.state().coins;
        let observed_history = runtime.state().wallet_sync.history;
        assert_eq!(coins.len(), 2);
        assert_eq!(coins.spendable_sats(), 800);
        assert!(!observed_history.is_empty());
        assert!(runtime.subscribe_wallet_sync().borrow().sync.history_fresh);
        let receive = runtime
            .state()
            .hd_addresses
            .unwrap()
            .current_receive()
            .unwrap();
        runtime
            .wallet_security(Request::NextReceive {
                epoch: runtime.state().lock.unlock_epoch,
                acknowledge_gap: false,
            })
            .await
            .unwrap();
        let allocation = runtime.state().hd_addresses.unwrap();
        assert_eq!(allocation.current_receive(), Some(receive + 1));
        runtime.request_wallet_rescan(1).await.unwrap();
        let pending = checkpoints.0.lock().unwrap().files.clone();
        assert!(!pending.values().any(|bytes| bytes
            .windows(xpub.len())
            .any(|window| window == xpub.as_bytes())));
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        assert!(runtime
            .wallet_for_operation(AuthScope::Background)
            .await
            .is_err());
        drop(runtime);

        let restarted = private_runtime(storage.clone(), checkpoints.clone());
        let listed = restarted.wallet_security(Request::Status).await.unwrap();
        assert_eq!(listed.active, None);
        assert_eq!(listed.wallets.len(), 1);
        assert_eq!(listed.wallets[0].handle, handle);
        assert_eq!(listed.wallets[0].name, "Managed public account");
        assert!(restarted
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::new(fixture_password(8)),
            })
            .await
            .is_err());
        assert!(restarted.state().wallet.is_none());
        restarted
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::new(password.clone()),
            })
            .await
            .unwrap();
        let wallet = restarted.state().wallet.unwrap();
        assert_eq!(wallet.account_xpub.as_deref(), Some(xpub.as_str()));
        assert_eq!(wallet.account_path, "m/44'/1'/6'");
        assert_eq!(wallet.master_fingerprint.as_deref(), Some("73c5da0a"));
        assert_eq!(restarted.state().coins, coins);
        assert_eq!(restarted.state().wallet_sync.history, observed_history);
        assert_eq!(restarted.state().hd_addresses.unwrap(), allocation);
        assert_eq!(restarted.state().wallet_sync.rescan_requested, Some(1));
        assert!(!restarted.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        assert!(
            !restarted
                .subscribe_wallet_sync()
                .borrow()
                .sync
                .history_fresh
        );
        refuses_operation_wallets(&restarted).await;

        restarted
            .wallet_security(Request::ChangePassword {
                current: Some(SecretText::new(password.clone())),
                password: SecretText::new(rotated.clone()),
                confirmation: SecretText::new(rotated.clone()),
                epoch: restarted.state().lock.unlock_epoch,
            })
            .await
            .unwrap();
        let rotated_record = storage.read(&handle).unwrap();
        assert_ne!(rotated_record, record);
        assert!(!rotated_record
            .windows(xpub.len())
            .any(|window| window == xpub.as_bytes()));
        assert_eq!(
            checkpoints.0.lock().unwrap().files,
            pending,
            "password rotation must retain the checkpoint key and history"
        );
        refuses_operation_wallets(&restarted).await;
        restarted.dispatch(AppAction::LockWallet).await.unwrap();
        drop(restarted);

        let resumed = private_runtime(storage.clone(), checkpoints.clone());
        assert!(resumed
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::new(password),
            })
            .await
            .is_err());
        assert!(resumed.state().wallet.is_none());
        resumed
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: SecretText::new(rotated.clone()),
            })
            .await
            .unwrap();
        assert_eq!(resumed.state().coins, coins);
        assert_eq!(resumed.state().wallet_sync.history, observed_history);
        assert_eq!(resumed.state().hd_addresses.unwrap(), allocation);
        assert_eq!(resumed.state().wallet_sync.rescan_requested, Some(1));
        assert!(!resumed.subscribe_wallet_sync().borrow().sync.history_fresh);
        refuses_operation_wallets(&resumed).await;

        let (mut provider, backend) = service(history(&xpub), false);
        *backend.expected_floor.lock().unwrap() = Some(1);
        checkpoints.0.lock().unwrap().fail = true;
        assert!(matches!(
            resumed
                .sync_hd_wallet(&mut provider, &mut worker, xpub.clone(), LIMITS)
                .await,
            Err(WalletSyncError::Persistence(_))
        ));
        assert_eq!(resumed.state().coins, coins);
        assert_eq!(resumed.state().wallet_sync.history, observed_history);
        assert_eq!(resumed.state().wallet_sync.rescan_requested, Some(1));
        assert!(!resumed.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        assert_eq!(checkpoints.0.lock().unwrap().files, pending);
        checkpoints.0.lock().unwrap().fail = false;
        assert_eq!(
            resumed
                .sync_hd_wallet(&mut provider, &mut worker, xpub, LIMITS)
                .await
                .unwrap(),
            ReconciliationDecision::Accepted
        );
        assert!(!backend.floors.lock().unwrap().is_empty());
        assert!(backend
            .floors
            .lock()
            .unwrap()
            .iter()
            .all(|floor| *floor == Some(1)));
        assert_eq!(resumed.state().wallet_sync.rescan_requested, None);
        let coverage = Some(ScanCoverageView {
            from_height: 1,
            skipped_below: Some(1),
            chosen_by_holder: true,
        });
        assert_eq!(resumed.state().wallet_sync.scan_coverage, coverage);
        assert_eq!(resumed.state().coins, coins);
        assert_eq!(resumed.state().wallet_sync.history, observed_history);
        refuses_operation_wallets(&resumed).await;
        resumed.dispatch(AppAction::LockWallet).await.unwrap();
        drop(resumed);

        let final_restart = private_runtime(storage, checkpoints);
        final_restart
            .wallet_security(Request::Open {
                handle,
                password: SecretText::new(rotated),
            })
            .await
            .unwrap();
        assert_eq!(final_restart.state().coins, coins);
        assert_eq!(final_restart.state().wallet_sync.history, observed_history);
        assert_eq!(final_restart.state().wallet_sync.rescan_requested, None);
        assert_eq!(final_restart.state().wallet_sync.scan_coverage, coverage);
        assert_eq!(
            final_restart
                .state()
                .hd_addresses
                .unwrap()
                .current_receive(),
            allocation.current_receive()
        );
        assert!(
            !final_restart
                .subscribe_wallet_sync()
                .borrow()
                .sync
                .history_fresh
        );
        refuses_operation_wallets(&final_restart).await;
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
        let initial_checkpoint = checkpoints.0.lock().unwrap().files.clone();
        assert_eq!(
            initial_checkpoint.len(),
            1,
            "first receive allocation is durable before publication"
        );
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(0)
        );
        assert!(runtime
            .subscribe_wallet_sync()
            .borrow()
            .authoritative
            .is_none());
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
        assert_eq!(checkpoints.0.lock().unwrap().files, initial_checkpoint);
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
        runtime.dispatch(AppAction::RebuildWallet).await.unwrap();
        assert_eq!(
            runtime.state().coins,
            before,
            "rebuild preserves labels and holds"
        );
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
        let previous_receive = runtime
            .state()
            .hd_addresses
            .unwrap()
            .current_receive()
            .unwrap();
        runtime
            .wallet_security(Request::NextReceive {
                epoch: status.epoch,
                acknowledge_gap: false,
            })
            .await
            .unwrap();
        assert_eq!(
            runtime.state().hd_addresses.unwrap().current_receive(),
            Some(previous_receive + 1)
        );
        assert_eq!(runtime.state().coins, before);
        runtime
            .sync_hd_wallet(&mut provider, &mut worker, xpub.clone(), LIMITS)
            .await
            .unwrap();
        assert_eq!(
            runtime.state().coins,
            before,
            "resync after rebuild and allocation preserves annotations"
        );
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
        let rotated = fixture_password(3);
        runtime
            .wallet_security(Request::ChangePassword {
                current: None,
                password: SecretText::new(rotated.clone()),
                confirmation: SecretText::new(rotated.clone()),
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
                password: SecretText::new(rotated.clone()),
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
                password: SecretText::new(rotated)
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
        let observed = runtime.state().wallet_sync;
        assert_eq!(observed.total_sats(), Some(800));
        assert_eq!(observed.history.len(), 3);
        assert_eq!(
            observed
                .history
                .iter()
                .filter(|entry| entry.kind == optn_app::HistoryKind::Sent)
                .count(),
            2
        );
        assert!(observed.history_fresh && observed.utxos_fresh);
        assert_eq!(observed.evidence.as_deref(), Some("Server assertion"));
        let salt = fixture_salt(1);
        let key = derive_key_with_rounds(&fixture_password(1), &salt, 1).unwrap();
        let wrong = derive_key_with_rounds(&fixture_password(2), &salt, 1).unwrap();
        let nonce = fixture_nonce(44);
        let bytes = runtime
            .wallet_checkpoint()
            .await
            .unwrap()
            .seal(&key, &nonce)
            .unwrap();
        assert!(WalletCheckpoint::open(&wrong, &bytes).is_err());
        // Bounded mutation regression: changing any byte of this populated
        // envelope (including its nonce) must fail before restoring anything.
        for index in 0..bytes.len() {
            let mut tampered = bytes.clone();
            tampered[index] ^= 1;
            assert!(WalletCheckpoint::open(&key, &tampered).is_err());
        }
        let plaintext = optn_core::wallet_pack::open(&key, &nonce, &bytes[12..]).unwrap();
        let stored: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        for (index, (field, bad_value)) in [
            ("format", serde_json::json!("future-unknown-format")),
            ("branch_lengths", serde_json::json!([0, 4, 4, 4])),
            ("branch_lengths", serde_json::json!([10001, 4, 4, 4])),
            ("annotations", serde_json::json!([])),
        ]
        .into_iter()
        .enumerate()
        {
            let mut malformed = stored.clone();
            malformed[field] = bad_value;
            let malformed_nonce = fixture_nonce(100 + index as u64);
            let mut malformed_bytes = malformed_nonce.to_vec();
            malformed_bytes.extend(
                optn_core::wallet_pack::seal(
                    &key,
                    &malformed_nonce,
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
        let restored = restarted.state().wallet_sync;
        assert_eq!(restored.history, observed.history);
        assert_eq!(restored.total_sats(), observed.total_sats());
        assert_eq!(restored.source, observed.source);
        assert_eq!(restored.evidence, observed.evidence);
        assert!(!restored.history_fresh && !restored.utxos_fresh && !restored.refreshing);
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
            [16],
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
        assert_eq!(*backend.calls.lock().unwrap(), [8]);
        assert!(runtime.state().wallet.is_none());
        assert!(runtime
            .subscribe_wallet_sync()
            .borrow()
            .authoritative
            .is_none());
    }
}

//! Wallet-password lifecycle shared by native GUI and CLI hosts.
use crate::wallet_checkpoint::{WalletCheckpoint, WalletCheckpointStorage};
use crate::wallet_sync::WalletReconciliation;
use optn_app::{AppAction, AppState, AutoLockMinutes, Network, SecretText};
use optn_core::{hd, wallet_file::WalletFile};
use optn_platform::{WalletBiometrics, WalletStorage};
use optn_transport::{
    StoredWallet, TransportError, WalletSecurityRequest as Request, WalletSecurityStatus,
};
use zeroize::Zeroizing;

fn failure(message: impl Into<String>) -> TransportError {
    TransportError::Other(message.into())
}
fn crypto(error: optn_core::error::CliError) -> TransportError {
    failure(error.to_string())
}
fn platform(_: optn_platform::PlatformError) -> TransportError {
    failure("Wallet storage or device authentication failed. No approval was granted.")
}

struct Session {
    handle: String,
    bytes: Vec<u8>,
    file: WalletFile,
    password: SecretText,
    epoch: u64,
    xpub: String,
    network: Network,
    checkpoint: Option<CheckpointSession>,
}

struct CheckpointSession {
    id: [u8; 32],
    key: optn_core::wallet_pack::PackKey,
    revision: Option<[u8; 32]>,
    needs_reload: bool,
    restored: Option<WalletCheckpoint>,
}

pub struct WalletSecurity {
    storage: Box<dyn WalletStorage>,
    biometrics: Option<Box<dyn WalletBiometrics>>,
    session: Option<Session>,
    checkpoints: Option<Box<dyn WalletCheckpointStorage>>,
}

impl WalletSecurity {
    /// Temporary native operation wallet; never returned through renderer transport.
    pub fn wallet_for_operation(
        &self,
        state: &mut AppState,
        scope: optn_app::AuthScope,
        now_ms: u64,
    ) -> Result<hd::Wallet, TransportError> {
        let session = self.bound(state, state.lock.unlock_epoch)?;
        if scope == optn_app::AuthScope::Spend && state.surface.is_viewer_only() {
            return Err(TransportError::Unsupported);
        }
        if state.lock.idle_should_lock(now_ms) {
            return Err(failure("The wallet auto-locked. Reopen it."));
        }
        let action = match scope {
            optn_app::AuthScope::Spend => AppAction::AuthorizeSpend { now_ms },
            optn_app::AuthScope::Reveal => AppAction::RequestReveal { now_ms },
            optn_app::AuthScope::Background => AppAction::AuthorizeBackground { now_ms },
            optn_app::AuthScope::Chat => AppAction::AuthorizeChat { now_ms },
        };
        if scope == optn_app::AuthScope::Reveal && state.identity_revealed {
            state.identity_revealed = false;
        } else {
            state.reduce(action);
        }
        if state.lock.prompt.is_some() {
            return Err(TransportError::AuthenticationRequired);
        }
        session
            .file
            .unlock(session.password.expose())
            .map_err(crypto)
    }
    pub fn is_open(&self, state: &AppState) -> bool {
        self.bound(state, state.lock.unlock_epoch).is_ok()
    }
    pub fn new(
        storage: Box<dyn WalletStorage>,
        biometrics: Option<Box<dyn WalletBiometrics>>,
    ) -> Self {
        Self {
            storage,
            biometrics,
            session: None,
            checkpoints: None,
        }
    }

    pub fn with_checkpoints(mut self, storage: Box<dyn WalletCheckpointStorage>) -> Self {
        self.checkpoints = Some(storage);
        self
    }

    /// Taken only after open validated it against the newly derived account.
    pub(crate) fn take_restored_checkpoint(&mut self) -> Option<WalletCheckpoint> {
        self.session.as_mut()?.checkpoint.as_mut()?.restored.take()
    }

    pub(crate) fn persist_checkpoint(
        &mut self,
        app: &AppState,
        state: &WalletReconciliation,
    ) -> Result<(), TransportError> {
        let Some(storage) = &self.checkpoints else {
            return Ok(());
        };
        let session = self.bound(app, app.lock.unlock_epoch)?;
        let binding = session
            .checkpoint
            .as_ref()
            .ok_or_else(|| failure("Wallet checkpoint session is unavailable."))?;
        let checkpoint = WalletCheckpoint::capture(app, state).map_err(failure)?;
        let revision = storage
            .store(&binding.id, &checkpoint, &binding.key, binding.revision)
            .map_err(failure)?;
        // No other request can change this session within the actor turn.
        if let Some(binding) = self
            .session
            .as_mut()
            .and_then(|session| session.checkpoint.as_mut())
        {
            binding.revision = Some(revision);
            // Old memory must never use the new CAS revision after a failed
            // post-write check or cancelled publication. Only acceptance clears this.
            binding.needs_reload = true;
        }
        // Another process can rotate/replace the wallet during a blocking save.
        // Keep any committed checkpoint revision, but grant no fresh authority.
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| failure("Wallet session ended."))?;
        let bytes = self.storage.read(&session.handle).map_err(|_| failure(
            "Wallet state was saved, but its wallet file could not be rechecked. Reopen the wallet before continuing."
        ))?;
        if bytes != session.bytes {
            return Err(failure("Wallet changed on disk. Lock and reopen it."));
        }
        Ok(())
    }

    pub(crate) fn checkpoint_published(&mut self) {
        if let Some(binding) = self
            .session
            .as_mut()
            .and_then(|session| session.checkpoint.as_mut())
        {
            binding.needs_reload = false;
        }
    }

    pub fn restore_policy(&self, state: &mut AppState) -> Result<(), TransportError> {
        if let Some(minutes) = self.storage.auto_lock_minutes().map_err(platform)? {
            state.lock.auto_lock = AutoLockMinutes::from_minutes(minutes);
        }
        Ok(())
    }

    pub fn save_policy(&self, minutes: u32) -> Result<(), TransportError> {
        self.storage
            .save_auto_lock_minutes(AutoLockMinutes::from_minutes(minutes).as_minutes())
            .map_err(platform)
    }

    pub fn reconcile(&mut self, state: &AppState) {
        if self.session.as_ref().is_some_and(|session| {
            session.epoch != state.lock.unlock_epoch
                || session.network != state.network
                || state
                    .wallet
                    .as_ref()
                    .and_then(|wallet| wallet.account_xpub.as_ref())
                    != Some(&session.xpub)
        }) {
            self.session = None;
        }
    }

    fn bound(&self, state: &AppState, epoch: u64) -> Result<&Session, TransportError> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| failure("Unlock the wallet first."))?;
        if session
            .checkpoint
            .as_ref()
            .is_some_and(|binding| binding.needs_reload)
        {
            return Err(failure(
                "Saved wallet state was not published. Reopen the wallet before continuing.",
            ));
        }
        if epoch != state.lock.unlock_epoch
            || session.epoch != epoch
            || session.network != state.network
            || state
                .wallet
                .as_ref()
                .and_then(|wallet| wallet.account_xpub.as_ref())
                != Some(&session.xpub)
        {
            return Err(failure("The wallet session changed. Please try again."));
        }
        // Bind every password/biometric operation to the same on-disk ciphertext.
        if self.storage.read(&session.handle).map_err(platform)? != session.bytes {
            return Err(failure("Wallet changed on disk. Lock and reopen it."));
        }
        Ok(session)
    }

    pub fn status(&self, state: &AppState) -> Result<WalletSecurityStatus, TransportError> {
        if self.session.is_some() {
            self.bound(state, state.lock.unlock_epoch)?;
        }
        let mut wallets = Vec::new();
        for handle in self.storage.list().map_err(platform)? {
            // A malformed file is not an empty wallet and must never be overwritten.
            if let Ok(bytes) = self.storage.read(&handle) {
                if let Ok(file) = WalletFile::parse(&bytes) {
                    wallets.push(StoredWallet {
                        handle,
                        name: file.name,
                    });
                }
            }
        }
        let active = self.session.as_ref();
        let biometric_available = self.biometrics.as_ref().is_some_and(|bio| bio.available());
        let biometric_enabled = match (&self.biometrics, active) {
            (Some(bio), Some(session)) => bio.enrolled(&session.handle).map_err(platform)?,
            _ => false,
        };
        Ok(WalletSecurityStatus {
            available: true,
            wallets,
            active: active.map(|session| session.handle.clone()),
            has_password: active.map(|session| !session.password.expose().is_empty()),
            biometric_available,
            biometric_enabled,
            epoch: state.lock.unlock_epoch,
            warning: None,
            needs_auto_lock_confirmation: self
                .storage
                .auto_lock_minutes()
                .map_err(platform)?
                .is_none(),
        })
    }

    fn open(
        &mut self,
        state: &mut AppState,
        handle: String,
        password: SecretText,
    ) -> Result<(), TransportError> {
        let bytes = self.storage.read(&handle).map_err(platform)?;
        let file = WalletFile::parse(&bytes).map_err(crypto)?;
        if file.source_id > 0
            && self
                .storage
                .auto_lock_minutes()
                .map_err(platform)?
                .is_none()
        {
            return Err(failure("Choose the auto-lock setting you used before, then open this wallet. Your existing file is unchanged."));
        }
        if file.wallet_type != "standard" {
            return Err(failure(
                "This wallet type needs its dedicated restore flow. The file has not been changed.",
            ));
        }
        let wallet = file.unlock(password.expose()).map_err(crypto)?;
        let (network, account) = file.account(state.network).map_err(crypto)?;
        let xpub = wallet.account_xpub_at(account).map_err(crypto)?;
        let address = wallet
            .address(network, &account.address_path(false, 0))
            .map_err(crypto)?
            .encode();
        let mut checkpoint = if let Some(storage) = &self.checkpoints {
            let key = wallet.checkpoint_key(network, account).map_err(crypto)?;
            let id = optn_core::header_hash::sha256d(
                format!("{handle}\0{network}\0{account}").as_bytes(),
            );
            let loaded = storage.load(&id, &key).map_err(failure)?;
            let (restored, revision) = match loaded {
                Some((checkpoint, revision)) => (Some(checkpoint), Some(revision)),
                None => (None, None),
            };
            Some(CheckpointSession {
                id,
                key,
                revision,
                needs_reload: false,
                restored,
            })
        } else {
            None
        };
        // Verify and derive everything before replacing the previous open wallet.
        let mut candidate = state.clone();
        candidate.reduce(AppAction::LockWallet);
        candidate.reduce(AppAction::SetNetwork(network));
        candidate.reduce(AppAction::OpenImportedWallet {
            name: file.name.clone(),
            receive_address: address,
            account_path: account.path(),
        });
        let opened = candidate
            .wallet
            .as_mut()
            .ok_or_else(|| failure("Wallet could not be opened."))?;
        opened.account_xpub = Some(xpub.clone());
        if let Some(restored) = checkpoint
            .as_ref()
            .and_then(|binding| binding.restored.as_ref())
        {
            restored.validate_wallet(&candidate).map_err(failure)?;
        }
        if let (Some(binding), Some(storage)) = (checkpoint.as_mut(), self.checkpoints.as_ref()) {
            let history = binding
                .restored
                .as_ref()
                .map(|checkpoint| checkpoint.state.clone())
                .unwrap_or_default();
            if let Some(restored) = &binding.restored {
                candidate.coins = restored.coins.clone();
            }
            let previous = binding
                .restored
                .as_ref()
                .and_then(|checkpoint| checkpoint.allocation.clone());
            candidate.hd_addresses = Some(previous.clone().unwrap_or_default());
            crate::wallet_checkpoint::observe_allocation(&mut candidate, &history)
                .map_err(failure)?;
            let restored = WalletCheckpoint::capture(&candidate, &history).map_err(failure)?;
            if previous != candidate.hd_addresses {
                // Even the first offline receive address must be durable before it
                // appears. Old history-only checkpoints are upgraded atomically.
                binding.revision = Some(
                    storage
                        .store(&binding.id, &restored, &binding.key, binding.revision)
                        .map_err(failure)?,
                );
            }
            binding.restored = Some(restored);
        }
        if self.storage.read(&handle).map_err(platform)? != bytes {
            return Err(failure("Wallet changed on disk while opening. Reopen it."));
        }
        *state = candidate;
        self.session = Some(Session {
            handle,
            bytes,
            file,
            password,
            epoch: state.lock.unlock_epoch,
            xpub,
            network,
            checkpoint,
        });
        Ok(())
    }

    /// Runs on the runtime actor. A host-supplied clock is used for approval, never the renderer's.
    pub fn handle(
        &mut self,
        state: &mut AppState,
        request: Request,
        now_ms: u64,
        history: &WalletReconciliation,
    ) -> Result<WalletSecurityStatus, TransportError> {
        self.reconcile(state);
        if state.wallet.is_some() && state.lock.idle_should_lock(now_ms) {
            state.reduce(AppAction::LockWallet);
            self.reconcile(state);
        }
        match request {
            Request::Status => {}
            Request::NextReceive {
                epoch,
                acknowledge_gap,
            } => {
                self.bound(state, epoch)?;
                if self.checkpoints.is_none() {
                    return Err(failure("Durable HD address storage is unavailable."));
                }
                let mut candidate = state.clone();
                let allocation = candidate
                    .hd_addresses
                    .as_mut()
                    .ok_or_else(|| failure("Reopen the wallet to restore HD allocation."))?;
                let used = crate::wallet_checkpoint::allocation_history(history);
                allocation
                    .allocate(optn_app::HdBranch::Receive, used, acknowledge_gap)
                    .map_err(crypto)?;
                crate::wallet_checkpoint::update_receive_address(&mut candidate)
                    .map_err(failure)?;
                self.persist_checkpoint(&candidate, history)?;
                *state = candidate;
                self.checkpoint_published();
            }
            Request::Open { handle, password } => self.open(state, handle, password)?,
            Request::UnlockBiometric { handle } => {
                let bio = self
                    .biometrics
                    .as_ref()
                    .ok_or(TransportError::Unsupported)?;
                let bytes = Zeroizing::new(
                    bio.unlock(&handle)
                        .map_err(platform)?
                        .ok_or_else(|| failure("No biometric enrollment exists."))?,
                );
                let password = SecretText::new(
                    std::str::from_utf8(&bytes)
                        .map_err(|_| failure("Invalid device credential."))?
                        .to_owned(),
                );
                self.open(state, handle, password)?;
            }
            Request::Create {
                name,
                mnemonic,
                bip39_passphrase,
                password,
                confirmation,
                network,
                account_path,
            } => {
                let network: Network = network.parse().map_err(failure)?;
                let account = hd::parse_account_path(&account_path).map_err(crypto)?;
                let mut entropy = [0u8; 56];
                self.storage.entropy(&mut entropy).map_err(platform)?;
                let file = WalletFile::create(
                    &name,
                    mnemonic.expose(),
                    bip39_passphrase.expose(),
                    password.expose(),
                    confirmation.expose(),
                    network,
                    account,
                    &entropy,
                )
                .map_err(crypto)?;
                let suffix = entropy[..8]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                let handle = format!("wallet-{suffix}.optn");
                self.storage
                    .save(&handle, None, &file.encode().map_err(crypto)?)
                    .map_err(platform)?;
                self.open(state, handle, password)?;
            }
            Request::Authenticate { password, epoch } => {
                let session = self.bound(state, epoch)?;
                let _verified = session.file.unlock(password.expose()).map_err(crypto)?;
                if state.lock.prompt.is_none() {
                    return Err(failure("No authentication request is pending."));
                }
                state.reduce(AppAction::ConfirmAuth { now_ms });
            }
            Request::ChangePassword {
                current,
                password,
                confirmation,
                epoch,
            } => {
                let session = self.bound(state, epoch)?;
                let old = match current.as_ref() {
                    Some(current) => current.expose(),
                    None if session.password.expose().is_empty() => "",
                    None => return Err(failure("Enter the current wallet password.")),
                };
                if session.password.expose().is_empty() && password.expose().is_empty() {
                    return Err(failure("Choose a new password with at least 8 characters."));
                }
                let mut entropy = [0u8; 56];
                self.storage.entropy(&mut entropy).map_err(platform)?;
                let next = session
                    .file
                    .change_password(old, password.expose(), confirmation.expose(), &entropy)
                    .map_err(crypto)?;
                let bytes = next.encode().map_err(crypto)?;
                let handle = session.handle.clone();
                let enrolled = self
                    .biometrics
                    .as_ref()
                    .map(|bio| bio.enrolled(&handle))
                    .transpose()
                    .map_err(platform)?
                    .unwrap_or(false);
                self.storage
                    .save(&handle, Some(&session.bytes), &bytes)
                    .map_err(platform)?;
                // Durable ciphertext is committed before changing the session credential.
                let session = self
                    .session
                    .as_mut()
                    .ok_or_else(|| failure("Wallet session ended."))?;
                session.file = next;
                session.bytes = bytes;
                session.password = password;
                state.lock.lock();
                state.lock.mark_unlocked();
                state.lock.observe(now_ms);
                state.identity_revealed = false;
                state.spend = None;
                session.epoch = state.lock.unlock_epoch;
                if enrolled {
                    let bio = self
                        .biometrics
                        .as_ref()
                        .ok_or(TransportError::Unsupported)?;
                    if bio
                        .enroll(&handle, session.password.expose().as_bytes())
                        .is_err()
                    {
                        let _ = bio.remove(&handle);
                        let mut status = self.status(state)?;
                        status.warning = Some("Password changed. Enable biometric unlock again to refresh its saved credential.".into());
                        return Ok(status);
                    }
                }
            }
            Request::SetBiometric {
                enabled,
                password,
                epoch,
            } => {
                let session = self.bound(state, epoch)?;
                let bio = self
                    .biometrics
                    .as_ref()
                    .ok_or(TransportError::Unsupported)?;
                if enabled {
                    let password =
                        password.ok_or_else(|| failure("Confirm the wallet password."))?;
                    let _verified = session.file.unlock(password.expose()).map_err(crypto)?;
                    bio.enroll(&session.handle, password.expose().as_bytes())
                        .map_err(platform)?;
                } else {
                    bio.remove(&session.handle).map_err(platform)?;
                }
            }
        }
        if self.session.is_some() {
            state.lock.observe(now_ms);
        }
        self.status(state)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use optn_platform::{PlatformError, PlatformResult};
    use std::{
        collections::BTreeMap,
        sync::{
            atomic::{AtomicU8, Ordering},
            Arc, Mutex,
        },
    };

    #[derive(Clone, Default)]
    pub(crate) struct Storage(
        Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        Arc<AtomicU8>,
        Arc<std::sync::atomic::AtomicBool>,
    );
    impl Storage {
        pub(crate) fn fail_next_read(&self) {
            self.2.store(true, Ordering::SeqCst);
        }
    }
    impl WalletStorage for Storage {
        fn list(&self) -> PlatformResult<Vec<String>> {
            Ok(self.0.lock().unwrap().keys().cloned().collect())
        }
        fn read(&self, handle: &str) -> PlatformResult<Vec<u8>> {
            if self.2.swap(false, Ordering::SeqCst) {
                return Err(PlatformError::Unavailable);
            }
            self.0
                .lock()
                .unwrap()
                .get(handle)
                .cloned()
                .ok_or(PlatformError::Unavailable)
        }
        fn save(&self, handle: &str, old: Option<&[u8]>, bytes: &[u8]) -> PlatformResult<()> {
            let mut files = self.0.lock().unwrap();
            if files.get(handle).map(Vec::as_slice) != old {
                return Err(PlatformError::PermissionDenied);
            }
            files.insert(handle.into(), bytes.to_vec());
            Ok(())
        }
        fn entropy(&self, output: &mut [u8]) -> PlatformResult<()> {
            let value = self.1.fetch_add(1, Ordering::SeqCst);
            for (index, byte) in output.iter_mut().enumerate() {
                *byte = (index as u8).wrapping_add(value);
            }
            Ok(())
        }
        fn auto_lock_minutes(&self) -> PlatformResult<Option<u32>> {
            Ok(None)
        }
        fn save_auto_lock_minutes(&self, _: u32) -> PlatformResult<()> {
            Ok(())
        }
    }
    #[derive(Clone, Default)]
    struct Biometric(Arc<Mutex<BTreeMap<String, Vec<u8>>>>);
    impl WalletBiometrics for Biometric {
        fn available(&self) -> bool {
            true
        }
        fn enrolled(&self, handle: &str) -> PlatformResult<bool> {
            Ok(self.0.lock().unwrap().contains_key(handle))
        }
        fn unlock(&self, handle: &str) -> PlatformResult<Option<Vec<u8>>> {
            Ok(self.0.lock().unwrap().get(handle).cloned())
        }
        fn enroll(&self, handle: &str, password: &[u8]) -> PlatformResult<()> {
            self.0
                .lock()
                .unwrap()
                .insert(handle.into(), password.to_vec());
            Ok(())
        }
        fn remove(&self, handle: &str) -> PlatformResult<()> {
            self.0.lock().unwrap().remove(handle);
            Ok(())
        }
    }
    fn secret(value: &str) -> SecretText {
        SecretText::new(value.into())
    }

    #[tokio::test]
    async fn verified_password_does_not_approve_a_stale_spend() {
        use crate::AppRuntime;
        use optn_app::AuthScope;
        let mut security = WalletSecurity::new(Box::new(Storage::default()), None);
        let mut state = AppState::default();
        let status = security
            .handle(
                &mut state,
                Request::Create {
                    name: "Public freshness fixture".into(),
                    mnemonic: secret(hd::BIP39_TEST_VECTOR_MNEMONIC),
                    bip39_passphrase: secret(""),
                    password: secret(""),
                    confirmation: secret(""),
                    network: "chipnet".into(),
                    account_path: "m/44'/1'/0'".into(),
                },
                1,
                &WalletReconciliation::default(),
            )
            .unwrap();
        // Model an existing spend prompt when its chain observations go stale.
        state.lock.prompt = Some(AuthScope::Spend);
        let before = state.lock.clone();
        let (runtime, driver) = AppRuntime::new_with_security(state, security).unwrap();
        tokio::spawn(driver.run());
        assert!(matches!(
            runtime.wallet_security(Request::Authenticate {
                password: secret(""),
                epoch: status.epoch,
            }).await,
            Err(TransportError::Other(message)) if message.contains("Refresh the wallet")
        ));
        assert_eq!(runtime.state().lock, before);
        assert!(runtime.state().spend.is_none());
    }

    #[tokio::test]
    async fn abandoned_security_requests_do_not_create_files_or_open_wallets() {
        use crate::{AppRuntime, RuntimeRequest};
        let storage = Storage::default();
        let (runtime, driver) = AppRuntime::new_with_security(
            AppState::default(),
            WalletSecurity::new(Box::new(storage.clone()), None),
        )
        .unwrap();
        let (reply, abandoned) = tokio::sync::oneshot::channel();
        drop(abandoned);
        runtime
            .action_tx
            .send(RuntimeRequest::Security(
                Request::Create {
                    name: "Cancelled public fixture".into(),
                    mnemonic: secret(hd::BIP39_TEST_VECTOR_MNEMONIC),
                    bip39_passphrase: secret(""),
                    password: secret(""),
                    confirmation: secret(""),
                    network: "chipnet".into(),
                    account_path: "m/44'/1'/0'".into(),
                },
                0,
                reply,
            ))
            .await
            .unwrap();
        tokio::spawn(driver.run());
        runtime.wallet_security(Request::Status).await.unwrap();
        assert!(runtime.state().wallet.is_none());
        assert!(storage.list().unwrap().is_empty());
    }

    #[tokio::test]
    async fn real_ciphertext_first_password_biometrics_reauthentication_and_restart_share_one_runtime(
    ) {
        use crate::{AppRuntime, DirectTransport};
        use optn_transport::AppTransport;
        let storage = Storage::default();
        let biometric = Biometric::default();
        let service =
            WalletSecurity::new(Box::new(storage.clone()), Some(Box::new(biometric.clone())));
        let (runtime, driver) =
            AppRuntime::new_with_security(AppState::default(), service).unwrap();
        tokio::spawn(driver.run());
        let transport = DirectTransport::new(runtime.clone());
        let status = transport
            .wallet_security(Request::Create {
                name: "Public vector wallet".into(),
                mnemonic: secret(hd::BIP39_TEST_VECTOR_MNEMONIC),
                bip39_passphrase: secret(""),
                password: secret(""),
                confirmation: secret(""),
                network: "chipnet".into(),
                account_path: "m/44'/1'/0'".into(),
            })
            .await
            .unwrap();
        let handle = status.active.unwrap();
        assert_eq!(status.has_password, Some(false));
        // A successful password unlock is not evidence that spendable coins are fresh.
        for scope in [optn_app::AuthScope::Spend, optn_app::AuthScope::Background] {
            assert!(matches!(
                runtime.wallet_for_operation(scope).await,
                Err(TransportError::Other(message)) if message.contains("Refresh the wallet")
            ));
        }
        let (reply, abandoned) = tokio::sync::oneshot::channel();
        drop(abandoned);
        runtime
            .action_tx
            .send(crate::RuntimeRequest::WalletOperation(
                optn_app::AuthScope::Reveal,
                runtime.revocation.load(Ordering::SeqCst),
                reply,
            ))
            .await
            .unwrap();
        transport.wallet_security(Request::Status).await.unwrap();
        assert!(
            runtime.state().lock.prompt.is_none(),
            "abandoned key requests must not open prompts"
        );
        let saved = storage.read(&handle).unwrap();
        assert!(!String::from_utf8_lossy(&saved).contains(hd::BIP39_TEST_VECTOR_MNEMONIC));
        let mut changed_on_disk = saved.clone();
        changed_on_disk.push(b' ');
        storage
            .save(&handle, Some(&saved), &changed_on_disk)
            .unwrap();
        assert!(
            transport.wallet_security(Request::Status).await.is_err(),
            "a public rescan must not reuse a session whose wallet file changed"
        );
        assert!(
            transport
                .wallet_security(Request::SetBiometric {
                    enabled: true,
                    password: Some(secret("")),
                    epoch: status.epoch,
                })
                .await
                .is_err(),
            "stale ciphertext must not enroll a cached credential"
        );
        storage
            .save(&handle, Some(&changed_on_disk), &saved)
            .unwrap();

        transport
            .wallet_security(Request::SetBiometric {
                enabled: true,
                password: Some(secret("")),
                epoch: status.epoch,
            })
            .await
            .unwrap();
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        assert!(runtime.state().wallet.is_none());
        let status = transport
            .wallet_security(Request::UnlockBiometric {
                handle: handle.clone(),
            })
            .await
            .unwrap();
        assert_eq!(status.has_password, Some(false));
        runtime
            .dispatch(AppAction::RequestReveal { now_ms: u64::MAX })
            .await
            .unwrap();
        assert!(runtime
            .dispatch(AppAction::ConfirmAuth { now_ms: 1 })
            .await
            .is_err());
        assert!(!runtime.state().identity_revealed);
        assert!(transport
            .wallet_security(Request::Authenticate {
                password: secret("incorrect"),
                epoch: status.epoch
            })
            .await
            .is_err());
        assert!(!runtime.state().identity_revealed);
        transport
            .wallet_security(Request::Authenticate {
                password: secret(""),
                epoch: status.epoch,
            })
            .await
            .unwrap();
        assert!(runtime.state().identity_revealed);
        let status = transport
            .wallet_security(Request::ChangePassword {
                current: None,
                password: secret("new-password"),
                confirmation: secret("new-password"),
                epoch: status.epoch,
            })
            .await
            .unwrap();
        assert_eq!(status.has_password, Some(true));
        assert!(!runtime.state().identity_revealed);
        assert!(transport
            .wallet_security(Request::ChangePassword {
                current: None,
                password: secret("another-password"),
                confirmation: secret("another-password"),
                epoch: status.epoch,
            })
            .await
            .is_err());
        assert!(transport
            .wallet_security(Request::Open {
                handle: handle.clone(),
                password: secret("")
            })
            .await
            .is_err());
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        let status = transport
            .wallet_security(Request::UnlockBiometric {
                handle: handle.clone(),
            })
            .await
            .unwrap();
        assert_eq!(
            status.has_password,
            Some(true),
            "biometric enrollment was refreshed after password change"
        );
        let old_epoch = status.epoch;
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        assert!(transport
            .wallet_security(Request::Authenticate {
                password: secret("new-password"),
                epoch: old_epoch
            })
            .await
            .is_err());
        let service = WalletSecurity::new(Box::new(storage), Some(Box::new(biometric)));
        let (restarted, driver) =
            AppRuntime::new_with_security(AppState::default(), service).unwrap();
        tokio::spawn(driver.run());
        assert!(
            restarted.state().wallet.is_none(),
            "ciphertext must not restore unlock authority"
        );
        let status = restarted
            .wallet_security(Request::Open {
                handle,
                password: secret("new-password"),
            })
            .await
            .unwrap();
        assert_eq!(status.has_password, Some(true));
    }
}

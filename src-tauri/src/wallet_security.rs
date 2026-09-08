//! OS adapters only. Password verification and wallet state live in Rust runtime.
use optn_platform::{PlatformError, PlatformResult, WalletBiometrics};
use tauri_plugin_biometry::{BiometryExt, DataOptions, GetDataOptions, SetDataOptions};

struct NativeBiometrics(tauri::AppHandle);
const DOMAIN: &str = "com.optilabs.wallet.rust";

/// Hide OS/plugin error details behind the platform's authentication failure.
fn failure(_: impl std::fmt::Display) -> PlatformError {
    PlatformError::PermissionDenied
}

impl WalletBiometrics for NativeBiometrics {
    /// Report OS biometric availability; a failed status query is unavailable.
    fn available(&self) -> bool {
        self.0
            .biometry()
            .status()
            .map(|status| status.is_available)
            .unwrap_or(false)
    }
    /// Check for this wallet's stored credential in the OPTN biometric domain.
    /// Unavailable biometrics return false; storage failures return permission denied.
    fn enrolled(&self, handle: &str) -> PlatformResult<bool> {
        if !self.available() {
            return Ok(false);
        }
        self.0
            .biometry()
            .has_data(DataOptions {
                domain: DOMAIN.into(),
                name: handle.into(),
            })
            .map_err(failure)
    }
    /// Ask the OS to unlock an enrolled wallet credential.
    ///
    /// `None` covers unavailable biometrics or an unenrolled handle. `Some` with
    /// empty bytes is a valid empty password. Rejected prompts and plugin failures
    /// return permission denied.
    fn unlock(&self, handle: &str) -> PlatformResult<Option<Vec<u8>>> {
        if !self.enrolled(handle)? {
            return Ok(None);
        }
        let result = self
            .0
            .biometry()
            .get_data(GetDataOptions {
                domain: DOMAIN.into(),
                name: handle.into(),
                reason: "Unlock OPTN Wallet".into(),
                cancel_title: None,
            })
            .map_err(failure)?;
        Ok(Some(result.data.into_bytes()))
    }
    /// Store a UTF-8 wallet password under its opaque handle in the OS adapter.
    /// Invalid UTF-8 and plugin errors return permission denied.
    fn enroll(&self, handle: &str, password: &[u8]) -> PlatformResult<()> {
        let data = std::str::from_utf8(password).map_err(failure)?.to_owned();
        self.0
            .biometry()
            .set_data(SetDataOptions {
                domain: DOMAIN.into(),
                name: handle.into(),
                data,
            })
            .map_err(failure)
    }
    /// Remove only this handle's biometric credential, leaving the wallet file intact.
    fn remove(&self, handle: &str) -> PlatformResult<()> {
        self.0
            .biometry()
            .remove_data(DataOptions {
                domain: DOMAIN.into(),
                name: handle.into(),
            })
            .map_err(failure)
    }
}

/// Bind runtime authentication to native wallet storage, OS biometrics, and
/// checkpoints below `root/.state`. Construction does not unlock a wallet;
/// password verification and policy decisions remain in the shared runtime.
pub fn service(
    app: tauri::AppHandle,
    root: std::path::PathBuf,
) -> optn_runtime::wallet_security::WalletSecurity {
    let checkpoints =
        optn_chain_native::wallet_checkpoint::WalletCheckpointDirectory(root.join(".state"));
    optn_runtime::wallet_security::WalletSecurity::new(
        Box::new(optn_platform_native::wallet_storage::NativeWalletStorage::new(root)),
        Some(Box::new(NativeBiometrics(app))),
    )
    .with_checkpoints(Box::new(checkpoints))
}

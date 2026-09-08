//! OS adapters only. Password verification and wallet state live in Rust runtime.
use optn_platform::{PlatformError, PlatformResult, WalletBiometrics};
use tauri_plugin_biometry::{BiometryExt, DataOptions, GetDataOptions, SetDataOptions};

struct NativeBiometrics(tauri::AppHandle);
const DOMAIN: &str = "com.optilabs.wallet.rust";

fn failure(_: impl std::fmt::Display) -> PlatformError {
    PlatformError::PermissionDenied
}

impl WalletBiometrics for NativeBiometrics {
    fn available(&self) -> bool {
        self.0
            .biometry()
            .status()
            .map(|status| status.is_available)
            .unwrap_or(false)
    }
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
        // An empty returned string is a real empty wallet password, not absent data.
        Ok(Some(result.data.into_bytes()))
    }
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

pub fn service(
    app: tauri::AppHandle,
    root: std::path::PathBuf,
) -> optn_runtime::wallet_security::WalletSecurity {
    optn_runtime::wallet_security::WalletSecurity::new(
        Box::new(optn_platform_native::wallet_storage::NativeWalletStorage::new(root)),
        Some(Box::new(NativeBiometrics(app))),
    )
}

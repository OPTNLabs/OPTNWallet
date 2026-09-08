//! Tauri/native implementations of framework-neutral platform contracts.
//!
//! Keep OS and shell details here. Wallet/application crates must only know the
//! traits from `optn-platform`.

use optn_platform::{
    CapabilityProvider, Clipboard as ClipboardPort, PlatformFuture, PlatformResult,
};
use optn_platform_native::NativeClipboard;
use tauri::Manager;

#[derive(Clone)]
pub struct TauriClipboard {
    app: tauri::AppHandle,
}

impl TauriClipboard {
    /// Bind a shell whose setup must register `NativeClipboard` before use.
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    /// Read through the registered native provider, preserving its platform errors.
    pub fn read_text_sync(&self) -> PlatformResult<String> {
        self.app.state::<NativeClipboard>().read_text_sync()
    }

    /// Replace clipboard text through the registered native provider.
    pub fn write_text_sync(&self, value: &str) -> PlatformResult<()> {
        self.app.state::<NativeClipboard>().write_text_sync(value)
    }
}

impl CapabilityProvider for TauriClipboard {
    /// Advertise the registered provider's capabilities without probing OS access.
    fn descriptor(&self) -> optn_platform::ProviderDescriptor {
        self.app.state::<NativeClipboard>().descriptor()
    }
}

impl ClipboardPort for TauriClipboard {
    /// Expose the synchronous native read through the shared future contract.
    fn read_text<'a>(&'a self) -> PlatformFuture<'a, String> {
        Box::pin(async move { self.read_text_sync() })
    }

    /// Expose the synchronous native write through the shared future contract.
    fn write_text<'a>(&'a self, value: &'a str) -> PlatformFuture<'a, ()> {
        Box::pin(async move { self.write_text_sync(value) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_clipboard_port<T: ClipboardPort>() {}
    fn assert_capability_provider<T: CapabilityProvider>() {}

    #[test]
    fn tauri_clipboard_implements_platform_contract() {
        assert_clipboard_port::<TauriClipboard>();
        assert_capability_provider::<TauriClipboard>();
    }
}

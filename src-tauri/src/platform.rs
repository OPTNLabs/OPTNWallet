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
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    pub fn read_text_sync(&self) -> PlatformResult<String> {
        self.app.state::<NativeClipboard>().read_text_sync()
    }

    pub fn write_text_sync(&self, value: &str) -> PlatformResult<()> {
        self.app.state::<NativeClipboard>().write_text_sync(value)
    }
}

impl CapabilityProvider for TauriClipboard {
    fn descriptor(&self) -> optn_platform::ProviderDescriptor {
        self.app.state::<NativeClipboard>().descriptor()
    }
}

impl ClipboardPort for TauriClipboard {
    fn read_text<'a>(&'a self) -> PlatformFuture<'a, String> {
        Box::pin(async move { self.read_text_sync() })
    }

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

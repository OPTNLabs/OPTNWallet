//! Mobile Tauri capability providers.
//!
//! Mobile-specific shell plugins stay behind the same optn-platform traits
//! used by direct Rust desktop providers. Application code never imports them.

use optn_platform::{
    Capability, CapabilityProvider, Clipboard as ClipboardPort, PlatformError, PlatformFuture,
    PlatformResult, ProviderDescriptor, ProviderKind,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Clone)]
pub struct TauriMobileClipboard {
    app: tauri::AppHandle,
}

impl TauriMobileClipboard {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    pub fn read_text_sync(&self) -> PlatformResult<String> {
        self.app
            .clipboard()
            .read_text()
            .map_err(|error| PlatformError::Other(error.to_string()))
    }

    pub fn write_text_sync(&self, value: &str) -> PlatformResult<()> {
        self.app
            .clipboard()
            .write_text(value.to_owned())
            .map_err(|error| PlatformError::Other(error.to_string()))
    }
}

impl CapabilityProvider for TauriMobileClipboard {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: "tauri-clipboard-manager-mobile",
            kind: ProviderKind::Shell,
            capabilities: &[Capability::Clipboard],
        }
    }
}

impl ClipboardPort for TauriMobileClipboard {
    fn read_text<'a>(&'a self) -> PlatformFuture<'a, String> {
        Box::pin(async move { self.read_text_sync() })
    }

    fn write_text<'a>(&'a self, value: &'a str) -> PlatformFuture<'a, ()> {
        Box::pin(async move { self.write_text_sync(value) })
    }
}

#[tauri::command]
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    TauriMobileClipboard::new(app)
        .write_text_sync(&text)
        .map_err(|error| format!("{error:?}"))
}

#[tauri::command]
pub fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    TauriMobileClipboard::new(app)
        .read_text_sync()
        .map_err(|error| format!("{error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_clipboard_port<T: ClipboardPort>() {}
    fn assert_capability_provider<T: CapabilityProvider>() {}

    #[test]
    fn mobile_clipboard_implements_platform_contract() {
        assert_clipboard_port::<TauriMobileClipboard>();
        assert_capability_provider::<TauriMobileClipboard>();
    }
}

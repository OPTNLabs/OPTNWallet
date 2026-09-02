//! Tauri/native implementations of framework-neutral platform contracts.
//!
//! Keep OS and shell details here. Wallet/application crates must only know the
//! traits from `optn-platform`.

use optn_platform::{
    Capability, CapabilityProvider, Clipboard as ClipboardPort, PlatformError, PlatformFuture,
    PlatformResult, ProviderDescriptor, ProviderKind,
};

#[derive(Clone)]
pub struct TauriClipboard {
    app: tauri::AppHandle,
}

impl TauriClipboard {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    pub fn read_text_sync(&self) -> PlatformResult<String> {
        crate::clipboard::with_clipboard(&self.app, |clipboard| clipboard.get_text())
            .map_err(PlatformError::Other)
    }

    pub fn write_text_sync(&self, value: &str) -> PlatformResult<()> {
        crate::clipboard::with_clipboard(&self.app, |clipboard| {
            clipboard.set_text(value.to_owned())
        })
        .map_err(PlatformError::Other)
    }
}

impl CapabilityProvider for TauriClipboard {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: "tauri-arboard-clipboard",
            kind: ProviderKind::Shell,
            capabilities: &[Capability::Clipboard],
        }
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

    #[test]
    fn tauri_clipboard_implements_platform_contract() {
        assert_clipboard_port::<TauriClipboard>();
        let provider = TauriClipboard::new(tauri::test::mock_app().handle().clone());
        assert_eq!(provider.descriptor().id, "tauri-arboard-clipboard");
    }
}

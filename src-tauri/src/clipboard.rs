// Clipboard access lives in Rust because the WebView clipboard cannot be relied
// on. WKWebView resolves `navigator.clipboard.writeText()` and then silently
// drops the write, so a copy button reports success while the pasteboard stays
// unchanged; `readText()` is permission-gated and frequently absent outright.
// WebKitGTK, which the Linux AppImage ships, shares that lineage. WebView2 on
// Windows honours both, but routing every platform through one native path
// keeps behaviour — and error reporting — identical everywhere.

use std::sync::Mutex;
use tauri::Manager;

/// One clipboard handle kept open for the life of the app.
///
/// On X11 the clipboard is owned by the process that set it: a handle created
/// per call carries the copied text away when it drops, leaving the paste
/// target with nothing. Holding one open keeps copied text available. The Mutex
/// also serializes access, which Windows needs — concurrent opens of the Win32
/// clipboard fail intermittently.
pub struct ClipboardState(Mutex<Option<arboard::Clipboard>>);

impl ClipboardState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for ClipboardState {
    fn default() -> Self {
        Self::new()
    }
}

/// Run `operation` against the shared handle, opening it on first use.
pub(crate) fn with_clipboard<T>(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, String> {
    let state = app.state::<ClipboardState>();
    let mut stored = state
        .0
        .lock()
        .map_err(|_| "clipboard state lock poisoned".to_string())?;
    if stored.is_none() {
        *stored =
            Some(arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?);
    }
    // Not `expect`: a panic here would poison the lock and break every later
    // copy for the rest of the session.
    let Some(clipboard) = stored.as_mut() else {
        return Err("clipboard unavailable".to_string());
    };
    operation(clipboard).map_err(|e| format!("clipboard error: {e}"))
}

/// Deliberately synchronous. Tauri runs non-async commands on the main thread,
/// and AppKit requires `NSPasteboard` access from there. The official
/// tauri-plugin-clipboard-manager runs arboard on a tokio worker instead, which
/// races WebKit's main-thread pasteboard monitoring and segfaults
/// (tauri-apps/plugins-workspace#3205). A text write is microseconds, so
/// occupying the main thread costs nothing observable.
#[tauri::command]
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    crate::platform::TauriClipboard::new(app)
        .write_text_sync(&text)
        .map_err(|error| format!("{error:?}"))
}

/// Synchronous for the same reason as `clipboard_write_text`.
#[tauri::command]
pub fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    crate::platform::TauriClipboard::new(app)
        .read_text_sync()
        .map_err(|error| format!("{error:?}"))
}

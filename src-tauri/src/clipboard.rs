// Desktop clipboard commands expose the shell-independent native provider
// through the legacy Tauri command names. The provider itself lives in
// optn-platform-native and can be hosted by another shell unchanged.

#[tauri::command]
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    crate::platform::TauriClipboard::new(app)
        .write_text_sync(&text)
        .map_err(|error| format!("{error:?}"))
}

#[tauri::command]
pub fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    crate::platform::TauriClipboard::new(app)
        .read_text_sync()
        .map_err(|error| format!("{error:?}"))
}

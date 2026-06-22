// Desktop-only price fetch.
//
// The OPTN price server rejects (HTTP 500) any browser `Origin` header, and
// @tauri-apps/plugin-http force-sets Origin to the webview origin
// (`tauri.localhost`) in production, which cannot be overridden from JS. The
// mobile app avoids this by using Capacitor's native HTTP (no browser Origin).
// This command is the desktop equivalent: a server-side reqwest call (no Origin),
// hardcoded to the single trusted price host so it can never be used for SSRF.
#[tauri::command]
async fn optn_price_fetch(url: String) -> Result<String, String> {
    if !url.starts_with("https://price.optnlabs.com/") {
        return Err("host not allowed".into());
    }
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    Ok(body)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![optn_price_fetch])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

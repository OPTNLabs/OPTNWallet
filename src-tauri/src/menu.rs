// Native desktop menu bar (File / Wallet / View / Tools / Help), matching the
// shape of Electron Cash's menu bar. Menu items don't touch wallet data
// directly (that all lives in the JS-side WASM SQLite DB) — clicking one just
// emits a "menu-action" event with an id string; the frontend listens for it
// and does the actual navigation/action. See src/platform/desktop/useMenuBar.ts.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, Wry,
};

pub fn build_and_attach(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();

    let new_wallet = MenuItem::with_id(
        handle,
        "new_wallet",
        "New Wallet",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let import_wallet =
        MenuItem::with_id(handle, "import_wallet", "Import Wallet", true, None::<&str>)?;
    let open_wallet = MenuItem::with_id(
        handle,
        "open_wallet",
        "Open Wallet…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let lock_wallet = MenuItem::with_id(
        handle,
        "lock_wallet",
        "Lock Wallet",
        true,
        Some("CmdOrCtrl+L"),
    )?;
    let quit = PredefinedMenuItem::quit(handle, Some("Quit"))?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &new_wallet,
            &import_wallet,
            &open_wallet,
            &PredefinedMenuItem::separator(handle)?,
            &lock_wallet,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;

    let receive = MenuItem::with_id(handle, "receive", "Receive", true, None::<&str>)?;
    let send = MenuItem::with_id(handle, "send", "Send", true, None::<&str>)?;
    let history = MenuItem::with_id(handle, "history", "Transaction History", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "Settings", true, Some("CmdOrCtrl+,"))?;
    let wallet_menu = Submenu::with_items(
        handle,
        "Wallet",
        true,
        &[
            &receive,
            &send,
            &history,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
        ],
    )?;

    let toggle_theme = MenuItem::with_id(
        handle,
        "toggle_theme",
        "Toggle Light / Dark",
        true,
        None::<&str>,
    )?;
    let reload = MenuItem::with_id(handle, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let view_menu = Submenu::with_items(handle, "View", true, &[&toggle_theme, &reload])?;

    let console = MenuItem::with_id(handle, "console", "Console / Logs", true, None::<&str>)?;
    let tools_menu = Submenu::with_items(handle, "Tools", true, &[&console])?;

    let about = MenuItem::with_id(handle, "about", "About OPTN Wallet", true, None::<&str>)?;
    let help_menu = Submenu::with_items(handle, "Help", true, &[&about])?;

    let menu = Menu::with_items(
        handle,
        &[
            &file_menu,
            &wallet_menu,
            &view_menu,
            &tools_menu,
            &help_menu,
        ],
    )?;

    // App-wide menu applies to windows created later; the main window already
    // exists (created from tauri.conf.json before setup runs), so on Windows
    // the bar never appears unless the menu is also set on the window itself.
    app.set_menu(menu.clone())?;
    for (_, window) in app.webview_windows() {
        window.set_menu(menu.clone())?;
    }

    app.on_menu_event(move |app_handle: &tauri::AppHandle<Wry>, event| {
        let id = event.id().0.clone();
        if id == "reload" {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
            return;
        }
        let _ = app_handle.emit("menu-action", id);
    });

    Ok(())
}

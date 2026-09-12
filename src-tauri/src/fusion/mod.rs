// The CashFusion engine moved to `crates/optn-fusion`.
//
// It was 9,000 lines of Rust living in the Tauri shell, which meant nothing in
// `crates/` could reach it: the dependency direction runs
// `optn-core -> optn-app -> optn-runtime -> optn-transport -> optn-ui`, with
// this crate hanging off the end as an adapter. Anything wanting to drive a
// fusion round therefore had to come in through the shell's `#[tauri::command]`
// surface -- which is precisely why the only caller was TypeScript.
//
// Living in a crate lets `optn-runtime` call it directly, which is what the
// autonomous Auto Fusion driver needs.
//
// This module stays for two reasons: `tor_manager` is genuinely shell work, and
// re-exporting the engine keeps every existing `crate::fusion::…` path in
// `lib.rs` compiling unchanged, so the extraction moved code without moving
// behaviour.

/// Supervises an app-launched Tor child process.
///
/// Stays here on purpose. It spawns a binary, watches its stdout and resolves
/// bundled-resource paths from a `tauri::AppHandle` -- shell and platform work,
/// not protocol. The engine reaches Tor as a SOCKS5 proxy it is handed, and
/// does not care who started it.
pub mod tor_manager;

// A glob, so every `crate::fusion::…` path in `lib.rs` and `nostr_tor.rs`
// resolves exactly as it did before the move. Narrowing this to a hand-written
// list is how an extraction turns into an API change nobody asked for.
pub use optn_fusion::*;

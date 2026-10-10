---
applyTo: "src-tauri/**,src/platform/desktop/**,vite.desktop.config.ts,.github/workflows/desktop-*.yml"
---

# Desktop layer rules

These files ARE the modifiable desktop layer (the zero-touch rule protects upstream files, not these).

- Shims in `src/platform/desktop/` must mirror the Capacitor plugin API exactly, so upstream code stays platform-agnostic. Runtime platform detection picks Capacitor vs Tauri.
- `vite.desktop.config.ts` injects the desktop prelude (network bridges, storage partition) + desktop.css + logger into main.tsx via a transform plugin at build time. Extend this pattern for new injections — never import desktop modules from upstream files. Anything that must run before library or app code also goes in `DESKTOP_PRELUDE_MODULES`: the bundler runs an entry's imported chunks before the entry's own code, so import order alone does not hold in release builds.
- The webview never reaches the network itself: its CSP (`tauri.conf.json`, and the same policy from the Vite dev server) allows only the app, IPC and loopback. Before any app module runs, `http-bridge.ts` sends remote `fetch` to `optn_http_fetch` and `socket-bridge.ts` replaces `WebSocket` with `optn_ws_open`; remote images go through `RemoteImg` / `optn_remote_image`, and Electrum through `electrum_tcp_connect`. Rust (`src-tauri/src/egress.rs`) applies the holder's Tor switch to all of them. New egress goes through these, never around them, and never by widening the CSP.
- Rust commands live in `src-tauri/src/lib.rs`. Keep them minimal: fetch/proxy/OS integration only, no wallet logic in Rust.
- CI workflows must remain valid if merged upstream on main: use `npx tauri` (not a global install) and guard signing steps behind secret-existence checks.
- Desktop secrets go through the tauri keyring plugin (OS keychain), biometrics through the biometry plugin. Never fall back to localStorage for secrets.

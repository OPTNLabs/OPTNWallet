---
applyTo: "src-tauri/**,src/platform/desktop/**,vite.desktop.config.ts,.github/workflows/desktop-*.yml"
---

# Desktop layer rules

These files ARE the modifiable desktop layer (the zero-touch rule protects upstream files, not these).

- Shims in `src/platform/desktop/` must mirror the Capacitor plugin API exactly, so upstream code stays platform-agnostic. Runtime platform detection picks Capacitor vs Tauri.
- `vite.desktop.config.ts` injects desktop.css + http-bridge + logger into main.tsx via a transform plugin at build time. Extend this pattern for new injections — never import desktop modules from upstream files.
- The http-bridge patches `window.fetch` BEFORE any app module runs; requests needing CORS bypass route through the Rust `optn_price_fetch` command.
- Rust commands live in `src-tauri/src/lib.rs`. Keep them minimal: fetch/proxy/OS integration only, no wallet logic in Rust.
- CI workflows must remain valid if merged upstream on main: use `npx tauri` (not a global install) and guard signing steps behind secret-existence checks.
- Desktop secrets go through the tauri keyring plugin (OS keychain), biometrics through the biometry plugin. Never fall back to localStorage for secrets.

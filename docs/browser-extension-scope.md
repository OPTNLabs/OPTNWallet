# Browser extension (Firefox + Chrome): what shipped, and the real constraint on the rest

## Status: read-only viewer MVP

`vite.extension.config.ts` + `extension/manifest.{chrome,firefox}.json` +
`popup.html` + `src/platform/extension/*` build a real, working popup-only
extension for both browsers (`npm run build:extension:chrome` /
`build:extension:firefox` — both verified with an actual `vite build`, not
just configured and assumed). What it does:

- Own password gate (`ExtensionSecurityGate.tsx` / `ExtensionKeyManager.ts`):
  same PBKDF2(600k)/AES-GCM primitives as the desktop `OptnKeyManager`, but the
  salt/verify-token live in `localStorage` (scoped to the extension's own
  origin) instead of an OS keychain, since there is no Tauri keychain bridge
  inside a browser extension. Re-locks every time the popup is closed and
  reopened — by construction, not as a fallback, since nothing survives
  between popup opens anyway.
- Reuses the real upstream `AppShell`/`RootHandler`/onboarding in explicit
  viewer mode. First open walks through the normal create/import-wallet flow
  because the extension's storage (IndexedDB, localStorage) is a separate
  origin from the desktop app or any website tab.
- **Deliberately has no background service worker.** The MV3
  service-worker-eviction problem below (the one genuinely hard part) does
  not apply to this MVP: the popup owns its own Electrum connection only for
  as long as it stays open, same as a normal browser tab. There is nothing to
  evict because nothing runs when the popup is closed.
- **Sending is unavailable in this artifact.** Viewer mode registers only
  Home, Assets, Receive, and Activity routes, disables signing-session
  lifecycles, and swaps `TransactionService` for a fail-closed broadcaster.
  A dedicated popup-lifecycle signing design and test must land before any
  browser release exposes Send.
- Icons reused from `src-tauri/icons/` (32/64/128), copied into
  `public/extension-icons/` — no new artwork.

## What's still not done (same constraint as before, now narrower)

## Constraints confirmed in this codebase

- Extension build tooling and MV3 manifests now exist, but there is still no
  background service worker or browser-extension API dependency. The current
  release artifact remains a popup-lifecycle wallet viewer.
- The app already depends on **long-lived background work** that matters a
  lot for this decision: `src/workers/UTXOWorkerService.ts` +
  `TransactionWorkerService.ts` (real Web Workers) and
  `src/apis/ElectrumServer/*.ts` — an Electrum WebSocket client with its own
  reconnect/backoff logic and a subscription registry that resubscribes on
  reconnect. This reconnect logic exists precisely because Electrum
  connections drop and need to come back — that's about to become the
  central problem for an extension build (see below), not an incidental
  detail.

## The real constraint: MV3 contexts are not persistent

This is the finding that actually determines the architecture, more than any
manifest boilerplate:

- **MV3 service workers are killed after ~30s of inactivity** (Chrome) and
  can be evicted at any time. A wallet's Electrum WebSocket connection living
  in a service worker gets killed and reconnected constantly — not a rare
  edge case, the NORMAL steady state. Every reconnect re-triggers this app's
  existing resubscribe logic, which is good (it's designed for exactly this),
  but the CADENCE under MV3 is much higher than on desktop/mobile, where the
  process just stays up.
- **The extension popup is even less persistent than the service worker** —
  it's destroyed the instant the user clicks away. Any wallet state
  (unlocked key, in-progress transaction) held only in a popup's JS memory is
  gone the moment it closes. This app's existing per-wallet key-in-RAM model
  (built earlier this session) assumes a long-lived process — a popup
  fundamentally cannot provide that.
- **Chrome's side panel API** (`chrome.sidePanel`, Chrome 114+) stays open
  across tab switches within the same window and is the closest MV3
  equivalent to "the wallet window stays open while you browse" — but it is
  Chrome-only; Firefox has its own (different) sidebar API
  (`sidebar_action`), and there is no unified cross-browser side-panel
  standard. A cross-browser popup-only build is the safe common denominator
  but inherits the persistence problem above.

**Practical implication**: an MV3 wallet extension either (a) accepts that
the unlocked-key/live-Electrum-connection state resets frequently and design
around it (re-prompt for password more often, treat every popup open as a
fresh boot — which is actually consistent with this app's OWN "no wallet is
open until its key is re-derived" invariant built earlier this session), or
(b) uses the side-panel API on Chrome specifically and accepts a lesser
experience on Firefox. This is a product decision, not just an engineering
one — flagging it rather than picking silently.

## Confirmed-fine parts (checked)

- **sql.js WASM under extension CSP**: confirmed by an actual build, not just
  read about — the extension config does NOT need desktop's `sql-js-shim.ts`
  swap at all. The base `vite.config.ts`'s existing `manualChunks` (isolates
  sql.js into its own chunk) and `legacy.inconsistentCjsInterop` fixes
  (already added project-wide for the Vite 8/rolldown migration) were enough
  on their own; `npm run build:extension:chrome`/`:firefox` both produce a
  working `sql-wasm.wasm` + loader in the output with no extra plugin. The
  desktop shim exists for a Tauri-WebView2-specific quirk, not a general
  rolldown/browser problem — good to know before reflexively copying it
  again for some future build target.
- Declared `'wasm-unsafe-eval'` explicitly in `content_security_policy.
  extension_pages` for both manifests rather than relying on any implicit
  default — this is what `tiny-secp256k1` (RpaService) needs to instantiate
  its WASM module inside the popup.
- **IndexedDB** is available in extension pages (popup, options page, side
  panel) and in MV3 service workers — this app's existing DB persistence
  layer doesn't need to change.
- Manifest differences between Chrome and Firefox MV3 are small and
  well-trodden: Firefox needs `browser_specific_settings.gecko.id`; both
  otherwise use the same `manifest_version: 3` shape.
  `webextension-polyfill` smooths over the remaining `chrome.*` vs
  `browser.*` API naming difference — standard, low-risk dependency to add
  when this is actually built.

## What's left (the genuinely hard part, still not built)

The MVP above sidesteps MV3 ephemerality entirely by having no background
component. The remaining work is exactly the part flagged as hard before:

1. A background service worker owning a persistent Electrum connection
   across popup opens/closes (so balance/history don't need a full resync
   every time), re-establishing on every wake and leaning on the EXISTING
   reconnect/resubscribe logic in `ElectrumServer`/`UTXOWorkerService`
   rather than new logic.
2. Designing and verifying Send within a popup-lifetime session, including
   key lifetime, review, broadcast, ambiguous submission, and popup closure.
3. The product decision from above (re-prompt-every-open vs. Chrome-only
   side-panel persistence vs. accept a shorter session) — still open, still
   not picked silently.
4. `webextension-polyfill` was not added — this MVP doesn't call any
   `chrome.*`/`browser.*` extension API at all (no `chrome.storage`, no
   messaging), so there was nothing to polyfill. Add it when 1–2 above
   introduce actual extension-API usage.

## Recommendation

The popup-only viewer (unlock, balance, receive address) is real and shipped
in this PR. Persistent background sync + a verified Send path is still a
multi-day item with the one genuinely hard, non-obvious design problem (MV3
context ephemerality vs. this app's long-lived-key model) — worth its own
focused follow-up rather than being rushed in alongside everything else in
this PR.

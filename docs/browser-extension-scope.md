# Browser extension (Firefox + Chrome): scope and the real constraint

## Confirmed state of this codebase (checked, not assumed)

- No extension tooling exists yet: no `manifest.json`, no
  `webextension-polyfill` dependency, no MV3-anything.
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

- **sql.js WASM under extension CSP**: MV3's default CSP
  (`script-src 'self'; object-src 'self'`) permits WebAssembly instantiation
  from bundled extension resources without a special
  `'wasm-unsafe-eval'` directive in Chrome's current implementation for
  same-origin bundled `.wasm` (this differs from a REMOTE-hosted CSP
  scenario) — the existing `sql-js-shim.ts` approach (serve the UMD build as
  a bundled static asset, no network fetch) should port with no changes to
  that shim itself.
- **IndexedDB** is available in extension pages (popup, options page, side
  panel) and in MV3 service workers — this app's existing DB persistence
  layer doesn't need to change.
- Manifest differences between Chrome and Firefox MV3 are small and
  well-trodden: Firefox needs `browser_specific_settings.gecko.id`; both
  otherwise use the same `manifest_version: 3` shape.
  `webextension-polyfill` smooths over the remaining `chrome.*` vs
  `browser.*` API naming difference — standard, low-risk dependency to add
  when this is actually built.

## Recommended architecture (design only, not built this pass)

1. New `vite.extension.config.ts`, parallel to `vite.desktop.config.ts`,
   reusing the SAME module-swap-plugin pattern already proven there (swap in
   extension-specific shims instead of desktop ones) — this is the one part
   of the existing desktop work that generalizes directly.
2. Manifest: popup (or Chrome side panel, Firefox sidebar) as the wallet UI;
   background service worker owns the Electrum connection and re-establishes
   it on every wake, leaning on the EXISTING reconnect/resubscribe logic
   rather than building new logic for this.
3. Explicitly re-verify the per-wallet key-in-RAM model's assumptions against
   MV3's kill-on-inactivity behavior before reusing it as-is — this is the
   one piece of this session's earlier desktop work that does NOT port
   for free.
4. Build order: get the popup rendering + IndexedDB/sql.js working first
   (low risk, proves the build pipeline), THEN tackle the
   persistent-connection/key-lifetime redesign (the actual hard part) as its
   own follow-up, rather than both at once.

## Recommendation

This is a real, multi-day feature with one genuinely hard, non-obvious
design problem (MV3 context ephemerality vs. this app's long-lived-key
model) that deserves its own focused session rather than being bolted on
alongside everything else already shipped today.

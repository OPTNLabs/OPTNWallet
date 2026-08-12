# Desktop E2E testing (WebdriverIO + tauri-driver)

## Status: real harness, one verified smoke test

`npm run test:e2e` runs a genuine WebdriverIO E2E test against the actual
built Tauri binary — confirmed passing (not simulated, not assumed) by
launching the real app and asserting the landing screen's `<h1>OPTN
Wallet</h1>` is visible via a live WebDriver session.

This is the officially-recommended Tauri E2E path per
[v2.tauri.app/develop/tests/webdriver](https://v2.tauri.app/develop/tests/webdriver/)
and [webdriver.io/docs/desktop-testing/tauri](https://webdriver.io/docs/desktop-testing/tauri).
Two setups exist:
- **`@wdio/tauri-service`** (embedded driver) — needs a new Rust dependency
  (`tauri-plugin-wdio-webdriver`) added to `src-tauri/Cargo.toml` and
  registered in `src-tauri/src/lib.rs`. Not used here — adding a new Rust
  plugin dependency deserves its own review, not a drive-by addition inside
  a test-infra pass.
- **Manual `tauri-driver`** (this repo's choice) — `tauri-driver` bridges
  WebDriver to the platform's native driver (`msedgedriver` on Windows,
  `WebKitWebDriver` on Linux) with zero changes to `src-tauri/`. Simpler,
  no Rust changes, works today.

## One-time machine setup (Windows)

1. **Install tauri-driver**: `cargo install tauri-driver`
2. **Download the matching msedgedriver** — it MUST match your installed
   WebView2 Runtime version exactly, or the session fails to start:
   ```powershell
   # Find your installed WebView2 Runtime version:
   Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' | Select-Object -ExpandProperty pv
   ```
   Then download `https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`
   and unzip it somewhere. (Note: the older `msedgedriver.azureedge.net`
   host referenced in some older guides no longer resolves — use
   `msedgedriver.microsoft.com`.)

## Running it

```sh
# 1. Build the debug binary (no installer bundle needed for E2E):
npx tauri build --debug --no-bundle

# 2. Point the harness at your binary + drivers:
export TAURI_E2E_APP_BINARY="/path/to/target/debug/optn-wallet-desktop.exe"
export TAURI_E2E_DRIVER_PATH="$HOME/.cargo/bin/tauri-driver"     # or D:\Qubes\cargo\bin\tauri-driver.exe if CARGO_HOME is overridden
export TAURI_E2E_NATIVE_DRIVER_PATH="/path/to/msedgedriver.exe"  # Windows only

# 3. Run:
npm run test:e2e
```

On Linux, `TAURI_E2E_NATIVE_DRIVER_PATH` isn't needed — `tauri-driver`
launches `WebKitWebDriver` itself if it's on `PATH`.

## What's covered vs. what's next

- **Covered**: the harness itself — app launch, WebDriver session,
  DOM query against the real rendered app. This is the hard, one-time
  infrastructure problem; it's solved and proven.
- **Not yet covered**: the actual create-wallet → lock → reopen flow. That's
  a multi-step wizard (generate a seed phrase, read it back off the DOM,
  type specific words back to confirm, then set a password) — real
  automation, but a bigger single piece of work than "prove the harness
  works." Natural next spec now that the pipeline is real and verified:
  1. `e2e/specs/create-wallet.spec.ts` — walk the seed reveal/confirm/name
     steps in `DesktopCreateWalletPage.tsx`, landing on the wallet home.
  2. `e2e/specs/lock-reopen.spec.ts` — trigger a lock (idle timeout or a
     menu action), return to `DesktopLandingPage.tsx`'s picker, unlock with
     the same password.
  3. Biometric unlock is out of scope for WebDriver automation — it's a
     native OS dialog outside the webview and generally can't be driven by
     WebDriver at all; that one stays a manual test regardless of how much
     E2E infrastructure exists.

## CI

Not wired into GitHub Actions in this pass — running a Tauri app inside a
WebDriver session in CI needs a display server (`Xvfb` on Linux runners) and
the exact matching `msedgedriver`/`WebKitWebDriver` version pinned to
whatever WebView2/WebKitGTK version the CI image ships, which is worth
setting up deliberately rather than bolting on here. Tracked as a follow-up.

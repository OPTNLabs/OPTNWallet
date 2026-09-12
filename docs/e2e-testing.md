# Desktop E2E testing (WebdriverIO + tauri-driver)

## Status: real harness, launch smoke verified; Linux CI job enabled

`npm run test:e2e` runs a genuine WebdriverIO E2E test against the actual
built Tauri binary. The command sanitizes inherited Snap GTK/WebKit variables,
which prevents a developer-tool runtime from overriding the system libraries.
The harness was confirmed passing (not simulated, not assumed) by
launching the real app and asserting the landing screen's `<h1>OPTN
Wallet</h1>` is visible via a live WebDriver session. The suite now also
includes coverage for the watch-only onboarding preview, its empty xPub
validation, return navigation to the wallet picker, create-wallet seed
confirmation rejection/back-out, and import-wallet phrase/setup validation.

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

- **Verified**: app launch, WebDriver session, and DOM queries against the
  real rendered app.
- **Added**: watch-only preview navigation, client-side validation, return
  navigation to the wallet picker; create-wallet seed confirmation rejection
  and back-out; import-wallet word-count, missing-word, invalid-mnemonic,
  wallet-name, and password-mismatch validation; and the opt-in create → lock
  → reopen lifecycle with wrong-password coverage.
- **CI**: the Linux desktop-preview workflow builds the unbundled Tauri binary,
  runs `tauri-driver` under `xvfb`, and executes the non-mutating E2E suite on
  every desktop-preview push or pull request. Android Preview runs packaged
  instrumented tests on an emulator, including Watch Only landing visibility,
  Chipnet xPub preview, create, and relaunch. A missing Watch Only action on
  the Android landing fails that job.
- Biometric unlock is out of scope for WebDriver automation — it's a native OS
  dialog outside the webview and generally can't be driven by WebDriver; that
  one stays a manual test.

## CI

The non-mutating suite runs in `.github/workflows/desktop-preview.yml` on
Ubuntu 22.04. The job installs the matching WebKitGTK WebDriver package,
builds the debug binary with `--no-bundle`, installs `tauri-driver`, and runs
the suite under `xvfb`. The create → lock → reopen scenario remains opt-in via
`TAURI_E2E_ALLOW_MUTATION=1` and is intentionally not enabled in CI because it
creates and deletes wallet data inside the desktop profile.

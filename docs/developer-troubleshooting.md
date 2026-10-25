# Developer troubleshooting

Use this page for the shortest path from a local failure to useful evidence.

## Start with the prerequisite check

```bash
npm run doctor
```

This checks Node/npm, Rust/Tauri, WebKitGTK and WebDriver, Java, and `adb`.
An installed Android toolchain is enough to build an APK; an Android device or
emulator must also appear under `adb devices` before install or smoke testing.

## Standard verification

```bash
npm run verify
npm run security:test
```

`verify` runs maintained-file formatting, core linting, strict core typechecking,
core unit tests, UI tests, and the production web build. The core Vitest timeout is 15
seconds because persistence and cryptographic integration tests can legitimately
take longer than the default timeout on a busy development machine.

## Desktop checks

Build the debug binary used by the real WebDriver harness:

```bash
npx tauri build --debug --no-bundle
npm run test:e2e:lifecycle
```

The lifecycle test creates a temporary profile, verifies create → lock → reopen,
checks a wrong password, and removes the profile when it finishes. It does not
use a real wallet or network funds.

## Android checks

Build the local debug APK:

```bash
npm run android:apk:dev
```

The artifact is written to
`android/app/build/outputs/apk/debug/app-debug.apk`. If a device or emulator is
available, install it with:

```bash
npm run android:apk:dev:install
```

The normal debug APK keeps the private-key view disabled. If a controlled local
test explicitly needs that WIP-only view, use
`npm run android:apk:dev:private-key-view`; never use that command for a
release or shared preview artifact. Run the native JVM tests with
`npm run android:test`, and run the device/emulator smoke test with
`npm run android:test:instrumented` when `adb devices` shows a target.

If `adb devices` is empty, record that as an environment limitation and rely on
the web build, Capacitor sync, Gradle build, and UI tests until a device is
available.

## Common failure handling

- Preserve the command and first meaningful error before changing code.
- Run the smallest affected test first, then `npm run verify` after it passes.
- Never put recovery phrases, private keys, wallet files, or `.env` contents in
  logs, screenshots, fixtures, or issue reports.
- Build artifacts, keystores, wallet exports, and local profiles are not source
  files and must not be committed.

## Switching branches with dependency changes

Branches may pin different CashScript or other dependency versions. Always run
`npm ci` after switching to a branch whose `package.json` or `package-lock.json`
changed. `npm run dev` checks the installed packages against the active lockfile
and starts Vite with forced dependency re-optimization. This avoids serving
stale optimized modules after a branch switch or dependency reinstall. The
default Vite optimizer cache is also fingerprinted from those dependency
files, so different branch dependency graphs do not reuse one another's
optimized bundle.

If an older dev server is already running, stop it and start `npm run dev`
again; then hard-refresh the browser.

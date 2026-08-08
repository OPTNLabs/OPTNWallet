# Build and Release Scripts

This project uses `package.json` scripts (instead of root `.sh` files) for local and CI build flows.
Legacy root scripts (`build.sh`, `releaseBuild.sh`) are deprecated and should not be used for new workflows.

## Prerequisites

- Node.js + npm (`npm ci` or `npm install` completed)
- `.env` file present (for web build variables)
- For Android builds:
  - Java 21
  - Android SDK
  - Gradle wrapper (`android/gradlew`, already in repo)
- For installing debug APK to a device:
  - `adb` installed and device/emulator connected
- For desktop builds:

  - Rust stable and the Tauri system dependencies for the target platform
  - Windows: Visual Studio Build Tools with the Desktop development with C++ workload
  - macOS: Xcode Command Line Tools
  - Linux: WebKitGTK, GTK, AppIndicator, librsvg, OpenSSL, patchelf, and FUSE/AppImage dependencies
  - Linux also needs native USB development metadata because hardware-wallet
    support is compiled into the desktop process. On Debian/Ubuntu:

    ```bash
    sudo apt-get install libudev-dev libusb-1.0-0-dev pkg-config
    ```

## Core Build Scripts

- `npm run android:prepare`

  - Builds web assets with Vite and syncs the Capacitor Android project.
  - This release path does not run the full TypeScript compiler, so it stays usable even when unrelated typecheck errors exist elsewhere in the repo.

- `npm run android:apk:dev`

  - Produces a debug APK.
  - Output: `android/app/build/outputs/apk/debug/app-debug.apk`

- `npm run android:apk:dev:install`

  - Builds debug APK and installs it with `adb install -r`.

- `npm run android:apk:prod`

  - Produces a release APK.
  - Output: `android/app/build/outputs/apk/release/`

- `npm run android:aab:prod`

  - Produces a release AAB (Play Store upload format).
  - Output: `android/app/build/outputs/bundle/release/`

- `npm run build:aab`

  - Alias for `npm run android:aab:prod`.

- `npm run build:web`
  - Produces the production web bundle only, without running the repo-wide TypeScript compile.

## Desktop Build Scripts

- `npm run tauri:dev`

  - Starts the Tauri desktop development shell.

- `npm run tauri:build`
  - Produces platform-native desktop bundles through Tauri.
  - Output: `src-tauri/target/release/bundle/`

Tagged GitHub releases publish:

- Windows x64 (`.exe` and `.msi`)
- macOS Apple Silicon and Intel (`.dmg`)
- **Linux portable `.AppImage` for every distro** — both **x64** and **ARM64**
  (aarch64). AppImage is the supported cross-distro desktop Linux install path
  (Ubuntu, Debian, Fedora, Arch, etc.); users download one file and run it.
- Linux x64 also gets convenience `.deb` / `.rpm` packages
- Chrome and Firefox extension bundles (`.zip`)
- Android signed `.apk` / `.aab` when production keystore secrets are configured

macOS release jobs always produce native Apple Silicon and Intel DMGs. An Apple
account is optional:

- With none of the Apple secrets configured, Tauri uses the `-` ad-hoc signing
  identity. The workflow verifies the app signature, DMG integrity, application
  architecture, bundled Tor architecture, checksums, and build provenance. The
  released filename ends in `-adhoc-not-notarized.dmg` so users are not misled
  about its Gatekeeper status.
- With all Apple secrets configured, the same build is Developer ID signed,
  notarized, stapled, and assessed by Gatekeeper before publication.
- A partial Apple secret set fails the build because it indicates a broken or
  ambiguous release configuration.

The optional signing and notarization secrets are:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

An ad-hoc-signed build does not require an Apple ID or paid developer account,
but Apple has not notarized it. A quarantined internet download can therefore be
blocked by Gatekeeper until the user explicitly approves it. Do not describe
this as file corruption, and do not describe an ad-hoc artifact as notarized.

The Tor version, each supported desktop archive's SHA-256, and the Linux ARM
Tor source SHA-256 are pinned in `scripts/fetch-tor.mjs`. Downloads use Tor
Project releases, so updating Tor requires a reviewed source change and
release builds never select a new upstream version automatically.
Linux preview and release jobs also extract the final AppImage and execute its
bundled Tor binary with an architecture check.

## Browser Extension Build Scripts

- `npm run build:extension:chrome`

  - Produces an unpacked Chrome/Chromium MV3 bundle in
    `dist-extension-chrome/`.

- `npm run build:extension:firefox`

  - Produces an unpacked Firefox MV3 bundle in `dist-extension-firefox/`.

The tagged release workflow archives both directories with `manifest.json` at
the archive root, verifies that each manifest version matches the release tag,
and includes both archives in checksums and provenance attestations. These are
GitHub release bundles; publishing through browser stores and Firefox AMO
signing remain separate store workflows.

## iOS Prep Scripts

These scripts prepare the iOS Capacitor project, but creating signed iOS binaries still requires macOS + Xcode.

- `npm run capacitor:add:ios`
- `npm run capacitor:sync:ios`
- `npm run capacitor:open:ios`

## Recommended Local Flows

Development APK:

```bash
npm run android:apk:dev:install
```

Production Android artifacts:

```bash
npm run android:apk:prod
npm run android:aab:prod
```

Desktop development and production bundles:

```bash
npm run tauri:dev
npm run tauri:build
```

The published Android release includes a directly installable signed APK and an
AAB for Play distribution. iOS preparation remains documented above, but iOS is
not part of the v1.7.0 release because that build environment is not currently
available.

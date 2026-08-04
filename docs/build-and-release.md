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

## Core Build Scripts

- `npm run android:prepare`

  - Runs the strict maintained TypeScript check, builds web assets with Vite,
    and syncs the Capacitor Android project.

- `npm run android:apk:dev`

  - Produces a debug APK.
  - Keeps the private-key view disabled by default.
  - Output: `android/app/build/outputs/apk/debug/app-debug.apk`
  - This local path has been verified on the development environment.

- `npm run android:apk:dev:private-key-view`

  - Explicitly opts into the controlled development-only private-key view.
  - Never use this path for release or shared preview artifacts.

- `npm run android:test`

  - Runs Android JVM unit tests.

- `npm run android:test:instrumented`

  - Runs Android emulator/device smoke tests through `adb`.

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

The GitHub release publishes Windows x64 (`.exe`), macOS Apple Silicon and
Intel (`.dmg`), and Linux x64 (`.AppImage`, `.deb`, and `.rpm`).
Those release builds are unsigned unless the corresponding signing credentials
are configured in GitHub Actions.

## Google Play release

The Android release job produces a signed AAB when the production environment
contains the permanent Android signing secrets. To upload it to Google Play:

1. Create or select the `optn.wallet.app` application in Google Play Console.
2. Create a Play Developer API service account, grant it release access in Play
   Console, and store the JSON key as the protected GitHub environment secret
   `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
3. Manually dispatch `Publish Release` for the release tag, enable
   `publish_to_google_play`, and choose the track. The default track is
   `internal`; use `production` only after Play review requirements are met.

The upload is intentionally opt-in. A normal tag release still builds and
publishes the AAB as a GitHub release artifact without automatically publishing
to users.

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

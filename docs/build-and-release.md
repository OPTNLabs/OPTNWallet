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

## Core Build Scripts

- `npm run android:prepare`
  - Builds web assets and syncs Capacitor Android project.

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

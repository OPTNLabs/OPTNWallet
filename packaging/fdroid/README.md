# Shipping OPTN Wallet on F-Droid

F-Droid builds every app itself, from source, and distributes only free
software — [including its dependencies][policy], not just the application. This
directory holds the build recipe and the decisions behind it.

## What was in the way, and what was done

**Google Play In-App Updates.** The single APK linked
`com.google.android.play:app-update`, which F-Droid cannot build against. A
`store` flavour dimension now produces two APKs: `play` keeps in-app updates so
existing Play users are unaffected, `fdroid` does not link it at all, and
`PlayUpdatePlugin` lives in a per-flavour source set so the F-Droid build never
compiles a class that references a Play API.

**ML Kit.** Removing app-update was not enough. Capacitor's barcode plugin
declares two scanning backends, and the ML Kit one brought in
`play-services-mlkit-barcode-scanning`, a `libbarhopper_v3.so` of roughly 5 MB
per ABI, and bundled TensorFlow Lite models — about 20 MB of proprietary
binaries, with 3,931 GMS references in the dex. Every scan now goes through
ZXing, which the plugin supports natively and which covers every format ML Kit
does, and ML Kit is excluded from the Gradle graph rather than shipped unused.

Both are enforced rather than trusted:

- `scripts/verify-android-fdroid-classpath.mts` resolves the F-Droid runtime
  classpath and fails on any Maven group that is not on a reviewed allowlist,
  which is F-Droid's actual bar — the whole graph, including transitive
  dependencies nobody chose.
- `scripts/assert-no-proprietary-scanner.sh` inspects the built APKs for the
  native library, the model assets, the Play Services marker and dex
  references. It runs on both flavours in preview and on the signed APKs at
  release.

## Reproducibility

Not required by F-Droid — it is [best practice, not policy][policy] — but it is
what would let them verify a published APK matches this source.

What is true today:

- **Nothing prebuilt is vendored.** The Android APK contains no committed
  binaries. Its only native libraries after the ML Kit removal are
  `libandroidx.graphics.path.so` and `libimage_processing_util_jni.so`, both
  from AndroidX. Unlike the desktop builds, the Android app bundles no Tor
  daemon.
- **The dependency set is pinned.** `npm ci` builds from the committed
  lockfile, and Gradle resolves fixed versions.

What is not yet established: nobody has built the same tag twice and compared
the APKs byte for byte. Until that experiment is run, reproducibility is
plausible rather than demonstrated, and this project should not claim it.
The likely obstacles are archive timestamps and any ordering that Vite or the
Capacitor sync step does not fix. **Decision: do not claim reproducible builds
in the F-Droid submission.** It can be added later; withdrawing the claim after
a mismatch is worse than not making it.

## Anti-Features

An explicit pass, rather than waiting for a reviewer to find one.

| Anti-Feature | Applies | Why |
| --- | --- | --- |
| `Ads` | No | None, of any kind. |
| `Tracking` | No | No analytics, no Firebase, no Crashlytics. The `google-services` plugin is skipped for F-Droid-only Gradle invocations, and no analytics SDK is in the source at all. |
| `NonFreeAdd` | No | The build promotes no proprietary add-ons. |
| `NonFreeDep` | No — after this work | Was true while ML Kit was linked. The classpath allowlist is what keeps it false. |
| `NonFreeNet` | **Needs a decision** | See below. |
| `UpstreamNonFree` | No | GPL-3.0-or-later, whole source published. |
| `NoSourceSince` | No | — |

**`NonFreeNet` is the open question.** The wallet's core function — deriving
keys, building transactions, sending and receiving — depends only on Bitcoin
Cash and Electrum servers, which run free software and which the user can point
anywhere. That is not a non-free network service.

But several features call OPTN Labs-hosted endpoints: `bcmr.optnlabs.com` for
token metadata, `tokenindex.optnlabs.com`, `ipfs.optnlabs.com` and
`ipfs-api.optnlabs.com`, and `upload.optnlabs.com`. Whether those count turns on
whether their server software is published. **This needs an answer from the
maintainers before submission**, and it is a question about our own
infrastructure, not something that can be settled by reading the app:

- If that server software is free and published, `NonFreeNet` does not apply
  and the submission should say so.
- If it is not, either publish it, or declare `NonFreeNet` honestly.

Declaring it is not a failure — plenty of accepted apps carry it. Omitting one
that applies is what causes a submission to be rejected or amended later.

## Submitting

1. Settle the `NonFreeNet` question above and add `AntiFeatures:` to
   `com.optilabs.wallet.yml` if it applies.
2. Confirm `versionName`, `versionCode` and `commit` in the recipe match the
   tag being submitted. They are checked against `android/app/build.gradle` by
   `scripts/__tests__/fdroidRecipe.test.mts`, so a drifted recipe fails CI.
3. Fork [fdroiddata][fdroiddata], copy the recipe to
   `metadata/com.optilabs.wallet.yml`, and open a merge request.
4. Expect the build to be run in F-Droid's own image. The recipe installs
   Node 20 through `sudo:` because this is a Capacitor app and the web bundle
   has to be built before Gradle runs; that step is the most likely thing a
   reviewer will question.

[policy]: https://f-droid.org/en/docs/Inclusion_Policy/
[fdroiddata]: https://gitlab.com/fdroid/fdroiddata

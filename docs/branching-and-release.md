# Branching and release policy

## Branch roles

| Branch    | Purpose                                                  | Release authority                       |
| --------- | -------------------------------------------------------- | --------------------------------------- |
| `dev`     | General integration for completed feature branches       | None                                    |
| `staging` | Release-candidate integration and pre-release validation | Builds previews and candidate artifacts |
| `main`    | Production source                                        | Production release tags only            |

Feature work uses short-lived branches from `dev`. Pull requests are required
for all shared branches. Protect `dev`, `staging`, and `main` in the repository
settings with required CI checks and at least one reviewer; protect `main` with
the strongest review and signed-release requirements.

## Promotion flow

```text
feature/*, fix/*, security/*
              ↓ pull request
             dev
              ↓ promotion PR + full checks
          staging
              ↓ release-candidate review
             main → vX.Y.Z tag → release artifacts
```

Hotfixes branch from `main`, are released as a patch version, and are merged
back into `staging` and `dev` immediately after release.

## Release targets

- Android: signed APK for direct distribution and signed AAB for Google Play.
- Windows: signed installer suitable for the supported WebView2 runtime.
- macOS: signed and notarized DMG/PKG for supported architectures.
- Linux: AppImage plus native `.deb`/`.rpm` packages where the runner supports
  them.

Signing credentials remain in GitHub environment secrets. They must never be
stored in the repository or passed through `.env` committed to source.

The release workflow verifies that the release tag is reachable from `main`,
runs the quality gate, builds Android and desktop artifacts, creates SHA256
checksums, and publishes the GitHub release. A manually dispatched release can
also opt into Google Play upload by selecting a track and supplying the
production environment secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`. Keep this
option disabled until the signed release has passed the release-candidate
review; the default is `internal` for the first upload.

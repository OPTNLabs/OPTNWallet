# Desktop update signing

Desktop updates are only installed if their signature verifies against a public
key compiled into the application. This document is how that key comes to
exist. Until it does, the wallet still checks for updates and links to the
release page — it just will not install anything, which is the correct
behaviour for a build that cannot verify what it would be running.

## Why it is set up this way

Installing an update means executing code fetched from the network. The only
thing that makes that safe is a signature the application can verify against a
key it already had. Every other arrangement — TLS alone, a checksum published
beside the file, trusting the release host — fails to the same attacker: whoever
can serve the download can serve the checksum.

So the design has exactly two states and no third:

- **A public key is configured.** Every update artifact is verified before it is
  run, and `Install update` appears.
- **No public key is configured.** There is no installer at all. The wallet
  reports what is available and opens the release page, and the holder installs
  deliberately.

There is deliberately no "install without verifying" path, not even behind a
flag. A flag like that is the one that turns up set in a release.

## Generating the key pair

Run this once, on a machine you trust, and keep the output out of the
repository:

```bash
npm exec -- tauri signer generate -w ~/.tauri/optnwallet-updater.key
```

It writes two things:

- `~/.tauri/optnwallet-updater.key` — the **private** key. It never leaves that
  machine and never enters git. Anyone holding it can ship an update that every
  OPTN Wallet desktop install will accept and run.
- `~/.tauri/optnwallet-updater.key.pub` — the **public** key, safe to publish.

You are prompted for a password. Choose one; an unencrypted private key on a
build machine is a private key in whatever backs that disk up.

## Repository secrets

In GitHub → Settings → Secrets and variables → Actions:

| Name                                 | Kind                       | Value                                |
| ------------------------------------ | -------------------------- | ------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | secret                     | the full contents of the `.key` file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret                     | the password you chose               |
| `TAURI_SIGNING_PUBLIC_KEY`           | **variable**, not a secret | the contents of the `.key.pub` file  |

The public key is a repository _variable_ on purpose. It has to appear verbatim
in a committed-looking config at build time, and masking it as a secret would
only make the logs harder to read without protecting anything — it is public by
construction.

## What the release workflow does with them

With the secrets present, the desktop job:

1. Builds with `--config src-tauri/tauri.updater.conf.json`, whose `pubkey`
   placeholder is replaced by `TAURI_SIGNING_PUBLIC_KEY`. A build that failed to
   substitute it fails the run rather than shipping the placeholder, because the
   placeholder's private half is known to everyone reading this file.
2. Signs each updater-capable artifact with the private key, producing a
   detached `.sig` beside it.
3. Generates `latest.json` — the manifest the installed application polls — and
   publishes it as a release asset.

With the secrets absent, none of that happens and the release is exactly what it
is today. That is why adding the key later needs no code change.

## Which artifacts can update

Tauri's updater does not update every bundle format:

| Platform | Updates from  | Also published, not updatable |
| -------- | ------------- | ----------------------------- |
| Windows  | `.exe` (NSIS) | `.msi`                        |
| macOS    | `.app.tar.gz` | `.dmg`, `.app.zip`            |
| Linux    | `.AppImage`   | `.deb`, `.rpm`, `.flatpak`    |

The `.app.tar.gz` is produced specifically for updating; the `.dmg` remains the
thing a person downloads by hand. A holder who installed from `.deb` or `.rpm`
is told an update exists and pointed at their package, because replacing a
distribution-managed install from inside the app would fight the package
manager.

## Rotating or revoking the key

There is no revocation list. If the private key leaks, the only safe move is to
publish a new key in a new release and tell holders to reinstall by hand —
installs carrying the old key will accept anything signed with it. Treat it
accordingly: it is the most dangerous secret this project has, more so than any
signing certificate, because it is trusted to run code rather than merely to
attest an identity.

## Checking it actually works

`scripts/build-update-manifest.mjs` is what produces `latest.json`, and it
refuses rather than degrades: an artifact with no `.sig` is an error, not an
entry with an empty signature, and a platform that produced nothing is an error
too — a manifest missing a platform silently strands every holder on it.

`scripts/__tests__/updateManifest.test.mts` drives those refusals. It runs with
`npm run test:tooling`.

`scripts/verify-release-completeness.sh` covers the other half: it builds a
synthetic release from `packaging/release-assets.json` and removes one asset at
a time, so a signature or the manifest going missing fails before publication
rather than after.

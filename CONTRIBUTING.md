# Contributing to OPTN Wallet

Thanks for contributing. OPTN Wallet is a self-custodial Bitcoin Cash wallet.
Contributions must preserve wallet safety, deterministic transaction behavior,
and the separation between the shared Capacitor mobile app and the Tauri
desktop layer.

This guide covers the normal local workflow and the optional Docker contributor
lab.

## Branches

- `main` is production-only and receives release tags.
- `staging` is the pre-release integration branch.
- `dev` is the general development integration branch.
- Work belongs on a short-lived branch such as `feature/<name>`,
  `fix/<name>`, `security/<name>`, or `chore/<name>`.

Open pull requests into `dev` for normal work. Promote tested changes from
`dev` to `staging`, then promote a release candidate from `staging` to `main`.
Hotfixes start from `main` and must be merged back into all active integration
branches.

## Filing an issue

**Never open a public issue for a security problem.** If a defect could expose
funds, recovery phrases, private keys, signing credentials, or release secrets,
follow [SECURITY.md](./SECURITY.md) and report it privately. Public disclosure
of a wallet vulnerability puts funds at risk before a fix can ship.

Search open and closed issues first. If you find a matching one, add your
details there rather than opening a second.

A bug report needs enough for someone else to reproduce it without asking:

- the version (`Help > About`, or the release tag) and how it was installed —
  AppImage, deb, rpm, msi, exe, dmg, apk, or built from source;
- platform and architecture, since several defects are specific to one
  (`macOS arm64` and `macOS x64` are different builds, as are the two Linux
  architectures);
- what you did, what you expected, and what happened instead;
- anything from the logs. Desktop logs are written by the app's log plugin;
  the Troubleshooting section below covers where to look.

A proposal needs the problem before the solution. Describe what you cannot do
today and why it matters; a specific implementation is welcome but should not
be the whole issue. Proposals that only describe a solution are hard to
evaluate, because the reader cannot tell which parts are essential.

State what you verified yourself and what you are inferring. "The RPM is
missing from the release" and "I think the RPM bundler is broken" call for
different responses, and conflating them costs a maintainer time.

## Prerequisites

- Git
- Node.js 20+ and npm for the native local workflow
- Docker Engine with Docker Compose v2 for the contributor lab

The Docker image is for tests and tooling. It is not the consumer wallet and
must not be used with mainnet keys or production wallet data.

Use Chipnet for wallet and transaction testing. Never use a real recovery phrase
or private key in source, logs, fixtures, screenshots, or issue reports.

Wallet creation currently generates a 12-word BIP39 phrase by default. Wallet
import accepts checksum-valid 12-, 15-, 18-, 21-, and 24-word phrases in the
supported English, Spanish, and Simplified Chinese wordlists.

## Choose a development path

### Local source workflow

```bash
git clone https://github.com/OPTNLabs/OPTNWallet.git
cd OPTNWallet
npm ci
cp .env.sample .env
npm run doctor
npm run dev
```

Copy any extra development environment values from `.env.example` into `.env`
when a build needs them. Run the repository checks listed below before opening
a pull request.

### Prebuilt Docker workflow

Use a published versioned image when you want a consistent Linux environment:

```bash
export OPTN_DOCKER_TAG=v1.7.3   # required; the image publishes version tags only
npm --prefix packages/docker-dev run pull:release
npm --prefix packages/docker-dev run up:release
docker compose -f packages/docker-dev/docker-compose.release.yml exec --user 1000:1000 dev bash
```

After the pilot publish, the GHCR contributor image will be public, so pulling
a versioned image will not require credentials. Set `OPTN_DOCKER_IMAGE` when
using a fork’s registry.

`OPTN_DOCKER_TAG` has no default. The image publishes `vX.Y.Z` and `X.Y.Z`
only, so compose stops with an explanatory error rather than resolving to a
mutable tag whose contents change between pulls.

### Local Docker build workflow

Use this path when changing the Docker image or when you need the current
source tree inside the container:

```bash
npm --prefix packages/docker-dev run up
npm --prefix packages/docker-dev run shell
# inside the container:
npm ci
npm run test:core
```

The `fusion-lab` profile is an advanced lab profile and is not required for
normal contributor work.

## Required checks

For normal application changes, run the relevant repository checks:

```bash
npm run doctor                 # inspect local prerequisites
npm run verify                 # formatting, lint, typecheck, tests, and build
npm run typecheck
npm run test
npm run addons:validate
npm run build
npm run security:ci            # npm dependency audit and security-focused tests
cargo audit --manifest-path src-tauri/Cargo.toml  # Rust advisories (CI runs this too)
npm run test:e2e:lifecycle     # real desktop create/lock/reopen test
npm run android:apk:dev        # debug Android APK
npm run tauri:build            # desktop bundles for the current OS
```

Desktop E2E requires a built debug binary, `tauri-driver`, and the platform
native WebDriver. See [docs/e2e-testing.md](docs/e2e-testing.md).

For pull requests that change `packages/docker-dev` or its workflows, GitHub
Actions also runs the read-only Docker build, non-root smoke checks, and
`npm ci && npm run test:core` inside the image.

## Pull-request expectations

Include:

- a concise description of the behavior changed;
- tests added or updated;
- platforms verified (mobile, desktop, or both);
- security and migration considerations;
- any follow-up work that remains.

Also:

- Keep changes focused and explain the validation performed.
- Do not commit secrets, wallet recovery phrases, or production wallet data.
- Do not commit generated release artifacts, keystores, `.env` files, wallet
  files, or real user data.
- Do not add credentials or GHCR write permissions to pull-request workflows.
- Docker PR validation runs untrusted code with read-only repository access; it
  must not use `pull_request_target` or publish artifacts.
- The Docker contributor image is not an end-user wallet distribution.

### Commit messages

Use the conventional prefixes already in the history: `feat`, `fix`, `docs`,
`ci`, `chore`, `test`, `refactor`, with an optional scope —
`fix(desktop): restore the macOS Edit menu`.

Write the body for someone reading it in a year with no memory of the
discussion. State what was broken and why the change is the fix, not a summary
of the diff; the diff is already in the commit. If a decision has a
non-obvious reason — a workaround for an upstream bug, a convention that
cannot be changed — record it there, because that is where the next person
will look.

Keep a commit to one concern. A change that touches release naming and adds a
new CI job is two commits, so either can be reverted alone.

### Labels

- `bug`, `enhancement`, `documentation` — what kind of change it is.
- `dependencies`, `javascript`, `rust` — what it touches.
- `Suggestion`, `Nice to have` — proposals, and proposals that are not
  priorities.
- `UI Improvement` — user-interface defects and improvements.
- `In Progress` — actively being worked on.
- `good first issue`, `help wanted` — applied by maintainers, not by the
  author of the issue.

### Versions and releases

Release channels come from the tag, not from a branch name or a manifest:
`v1.7.3-alpha.4` from `dev`, `v1.7.3-beta.1` from `staging`, `v1.7.3` from
`main`.

`package.json` and `src-tauri/tauri.conf.json` stay numeric on every channel —
`1.7.3`, never `1.7.3-alpha.4`. The Windows MSI bundler rejects pre-release
identifiers, so a pre-release manifest fails the build outright. The release
quality gate compares the tag's numeric core against both manifests and fails
if they disagree.

Do not bump versions in a feature pull request. Version changes belong to the
release preparation commit.

## Troubleshooting

- Bind-mount permission errors: use the documented UID 1000 container commands.
- GHCR pull errors: confirm the versioned tag and registry image name.
- Need a different fork image: set `OPTN_DOCKER_IMAGE` before running the
  release compose commands.
- For Docker or fusion-lab issues, start with
  [`docs/docker-dev.md`](./docs/docker-dev.md) and
  [`packages/docker-dev/README.md`](./packages/docker-dev/README.md).

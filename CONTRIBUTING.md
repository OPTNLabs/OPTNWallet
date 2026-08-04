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
export OPTN_DOCKER_TAG=sha-abcdef1  # or a release tag such as v1.7.0
npm --prefix packages/docker-dev run pull:release
npm --prefix packages/docker-dev run up:release
docker compose -f packages/docker-dev/docker-compose.release.yml exec --user 1000:1000 dev bash
```

After the pilot publish, the GHCR contributor image will be public, so pulling
a versioned image will not require credentials. Set `OPTN_DOCKER_IMAGE` when
using a fork’s registry.

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
npm run security:ci            # dependency audit and security-focused tests
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

## Troubleshooting

- Bind-mount permission errors: use the documented UID 1000 container commands.
- GHCR pull errors: confirm the versioned tag and registry image name.
- Need a different fork image: set `OPTN_DOCKER_IMAGE` before running the
  release compose commands.
- For Docker or fusion-lab issues, start with
  [`docs/docker-dev.md`](./docs/docker-dev.md) and
  [`packages/docker-dev/README.md`](./packages/docker-dev/README.md).

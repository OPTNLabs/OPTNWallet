# Contributing to OPTN Wallet

Thanks for contributing. This guide covers the normal local workflow and the
optional Docker contributor lab.

## Prerequisites

- Git
- Node.js and npm for the native local workflow
- Docker Engine with Docker Compose v2 for the contributor lab

The Docker image is for tests and tooling. It is not the consumer wallet and
must not be used with mainnet keys or production wallet data.

## Choose a development path

### Local source workflow

```bash
git clone https://github.com/OPTNLabs/OPTNWallet.git
cd OPTNWallet
npm install
cp .env.sample .env
npm run dev
```

Run the repository checks listed below before opening a pull request.

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
npm run typecheck
npm run test
npm run addons:validate
npm run build
```

For pull requests that change `packages/docker-dev` or its workflows, GitHub
Actions also runs the read-only Docker build, non-root smoke checks, and
`npm ci && npm run test:core` inside the image.

## Pull-request expectations

- Keep changes focused and explain the validation performed.
- Do not commit secrets, wallet recovery phrases, or production wallet data.
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

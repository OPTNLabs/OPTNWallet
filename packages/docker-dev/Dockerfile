# OPTN Wallet — contributor dev lab (NOT a production wallet image)
#
# Direction of truth: built FROM git tags in CI (see docs/docker-release-model.md).
#
# Pin the base image by digest when publishing long-lived GHCR tags:
#   docker buildx imagetools inspect node:22-bookworm-slim
#   FROM node:22-bookworm-slim@sha256:...
#
# v1 goals:
#   - reproducible Linux shell for npm ci + vitest/core tests
#   - optional compose Tor sidecar for lab (not baked into this image)
#   - no Tauri GUI / Android SDK / USB HW

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="optn-docker-dev" \
      org.opencontainers.image.description="OPTN Wallet contributor lab (tests/tooling)" \
      org.opencontainers.image.source="https://github.com/OPTNLabs/OPTNWallet" \
      org.opencontainers.image.licenses="SEE monorepo LICENSE"

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_fund=false \
    npm_config_audit=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    make \
    g++ \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /optn

# Default: interactive shell. Compose mounts the repo over /optn.
CMD ["bash"]

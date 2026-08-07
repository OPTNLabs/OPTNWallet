# OPTN Wallet — contributor dev lab (NOT a production wallet image)
#
# Pin the base image by digest when publishing to a registry.
# Example (refresh periodically):
#   docker buildx imagetools inspect node:22-bookworm-slim
#
# v1 goals:
#   - reproducible Linux shell for npm ci + vitest/core tests
#   - small surface; no Tauri GUI / Android SDK / USB HW
#
# Docs: packages/docker-dev/README.md

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="optn-docker-dev" \
      org.opencontainers.image.description="OPTN Wallet contributor lab (tests/tooling)" \
      org.opencontainers.image.source="https://github.com/OPTNLabs/OPTNWallet"

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

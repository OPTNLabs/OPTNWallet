# OPTN Wallet — production-grade *contributor/lab* image (NOT a consumer wallet).
#
# Direction of truth: built FROM git tags in CI (docs/docker-release-model.md).
# Native installers remain the product ship path for end users.
#
# Base pinned by multi-arch index digest (node:22-bookworm-slim, refreshed 2026-08).
# Re-pin: docker buildx imagetools inspect node:22-bookworm-slim

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

LABEL org.opencontainers.image.title="optn-docker-dev" \
      org.opencontainers.image.description="OPTN Wallet contributor/lab image (tests & tooling)" \
      org.opencontainers.image.source="https://github.com/OPTNLabs/OPTNWallet" \
      org.opencontainers.image.vendor="OPTNLabs" \
      org.opencontainers.image.licenses="SEE monorepo LICENSE"

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_fund=false \
    npm_config_audit=false \
    # Non-interactive npm in CI-like runs
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Build tooling for native npm modules; ca-certificates for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    make \
    g++ \
    curl \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 optn \
  && useradd --uid 1000 --gid optn --shell /bin/bash --create-home optn \
  && mkdir -p /optn \
  && chown -R optn:optn /optn /home/optn

WORKDIR /optn

# Drop root for default interactive / CI smoke runs.
# Compose bind-mounts may still need: docker compose exec --user 1000:1000
USER optn

# tini as PID 1 for clean signals when used as long-running lab
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]

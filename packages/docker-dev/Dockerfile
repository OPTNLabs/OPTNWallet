# OPTN Wallet — production-grade *contributor/lab* image (NOT a consumer wallet).
#
# Covers both halves of the repository on purpose: Node for the TypeScript
# surfaces, and the pinned Rust toolchain for the crates, the CLI and the
# committed-WASM gate. An image with only one half lets a contributor see a
# green test run while the other half rots, which has already happened here.
#
# Direction of truth: built FROM git tags in CI (docs/docker-release-model.md).
# Native installers remain the product ship path for end users.
#
# Base pinned by multi-arch index digest (node:22-bookworm-slim, refreshed 2026-08).
# Re-pin: docker buildx imagetools inspect node:22-bookworm-slim

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

LABEL org.opencontainers.image.title="optn-docker-dev" \
      org.opencontainers.image.description="OPTN Wallet contributor/lab image (Rust + TypeScript tests & tooling)" \
      org.opencontainers.image.source="https://github.com/OPTNLabs/OPTNWallet" \
      org.opencontainers.image.vendor="OPTNLabs" \
      org.opencontainers.image.licenses="SEE monorepo LICENSE"

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_fund=false \
    npm_config_audit=false \
    # Non-interactive npm in CI-like runs
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Build tooling for native npm modules; ca-certificates for HTTPS.
# pkg-config/libssl/libgmp are what this repository's Rust crates need beyond
# a compiler: the SHV/MMR reference work pulls in GMP.
# Official node image already has user `node` (uid/gid 1000). Do not re-create 1000.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    make \
    g++ \
    curl \
    tini \
    pkg-config \
    libssl-dev \
    libgmp-dev \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /optn \
  && chown -R node:node /optn

# Rust, pinned to the same toolchain `rust-toolchain.toml` and CI name.
#
# Without this the image runs only the TypeScript half, and a contributor sees
# a green `npx vitest` while the crates and the committed WASM go unchecked.
# That is not hypothetical: commits on this branch shipped stale generated
# WASM because the gate that catches it needs cargo, and the container had
# none.
#
# `--profile minimal` plus exactly the components the repo's own toolchain file
# names, and the wasm target the connector gate builds for.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    RUST_TOOLCHAIN=1.98.1
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
  && sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal \
       --default-toolchain "${RUST_TOOLCHAIN}" \
       --component clippy \
       --component rustfmt \
       --target wasm32-unknown-unknown \
  && rm /tmp/rustup-init.sh \
  # The binding generator the WASM freshness gate shells out to, at the version
  # .github/workflows/rust-connect.yml installs. A mismatch regenerates
  # bindings that differ from CI's, and the gate then fails for a reason that
  # has nothing to do with the change under test.
  && cargo install wasm-bindgen-cli --version 0.2.127 --locked \
  # A login shell rebuilds PATH from /etc/profile and drops what ENV set, and
  # the compose service's entrypoint is `bash -lc`. Without this, cargo is on
  # PATH for `docker build` and `docker run` and missing for exactly the
  # command a contributor actually types.
  && printf '%s\n' 'export PATH=/usr/local/cargo/bin:$PATH' \
       > /etc/profile.d/10-rust.sh \
  && chmod 0644 /etc/profile.d/10-rust.sh \
  # Writable by uid 1000 so cargo works after `USER node` without handing the
  # build cache to root.
  && chmod -R a+w "${CARGO_HOME}" "${RUSTUP_HOME}"

WORKDIR /optn

# Drop root for default interactive / CI smoke runs.
USER node

# Fail the build rather than ship an image that cannot run half the gates.
#
# Checked through a login shell as well, because that is what the compose
# service runs and it is the case that silently loses PATH.
RUN cargo --version \
  && rustc --version \
  && rustfmt --version \
  && cargo clippy --version \
  && rustup target list --installed | grep -qx wasm32-unknown-unknown \
  && wasm-bindgen --version \
  && bash -lc 'cargo --version && wasm-bindgen --version' >/dev/null

# tini as PID 1 for clean signals when used as long-running lab
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]

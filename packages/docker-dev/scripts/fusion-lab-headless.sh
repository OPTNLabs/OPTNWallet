#!/usr/bin/env bash
# fusion-lab headless runner: 24/7 Auto Fusion for one saved wallet.
#
# Runs the Rust CLI's `optn fusion --auto`, the same native fusion host the
# desktop and the CLI use, so a lab container fuses exactly as they do.
# Point OPTN_HEADLESS_CMD at this script; the supervisor starts it once Tor
# answers and restarts the container if it exits.
#
# Required:
#   OPTN_WALLET            saved wallet file name in the wallet directory
#   OPTN_FUSION_SERVER     CashFusion server, host[:port][:s|:t]
# Optional:
#   OPTN_WALLET_PASSWORD_FILE  file holding the wallet password (one line);
#                              absent means a wallet without a password
#   OPTN_FUSION_DEPTH      rounds per coin before Auto leaves it (default 3)
#   OPTN_FUSION_TIER       pin one tier in satoshis, so lab wallets meet
#   OPTN_CLI_BIN           a prebuilt `optn`; otherwise built from /optn
#   OPTN_WALLET_DIRECTORY  default $OPTN_DATA_DIR/wallets
#   OPTN_NETWORK_CONFIG_DIR default $OPTN_DATA_DIR/network
#
# Tor must be on this container's loopback (compose: network_mode service:tor):
# fusion trusts a proxy by its local port, never by a remote address.
set -euo pipefail

: "${OPTN_WALLET:?set OPTN_WALLET to the saved wallet file name}"
: "${OPTN_FUSION_SERVER:?set OPTN_FUSION_SERVER to a CashFusion server, host:port}"

ROOT="${OPTN_ROOT:-/optn}"
NETWORK="${OPTN_NETWORK:-chipnet}"
DATA="${OPTN_DATA_DIR:-/optn-data}"
WALLETS="${OPTN_WALLET_DIRECTORY:-${DATA}/wallets}"
CONFIG="${OPTN_NETWORK_CONFIG_DIR:-${DATA}/network}"
DEPTH="${OPTN_FUSION_DEPTH:-3}"

if [[ "${OPTN_FUSION_MODE:-server}" != "server" ]]; then
  echo "[fusion-lab] OPTN_FUSION_MODE=${OPTN_FUSION_MODE}: the headless runner fuses through a CashFusion server only. P2P fusion is coordinated over Nostr and has no Rust driver yet. Set OPTN_FUSION_MODE=server." >&2
  exit 2
fi

SOCKS="${OPTN_TOR_SOCKS:-127.0.0.1:9050}"
SOCKS_HOST="${SOCKS%:*}"
SOCKS_PORT="${SOCKS##*:}"
if [[ "${SOCKS_HOST}" != "127.0.0.1" && "${SOCKS_HOST}" != "localhost" ]]; then
  echo "[fusion-lab] Tor must be on this container's loopback (network_mode: service:tor); OPTN_TOR_SOCKS=${SOCKS}" >&2
  exit 2
fi

CLI="${OPTN_CLI_BIN:-}"
if [[ -z "${CLI}" ]]; then
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${DATA}/target}"
  echo "[fusion-lab] building the optn CLI (first start takes a while)" >&2
  cargo build --locked --release --manifest-path "${ROOT}/crates/optn-cli/Cargo.toml" >&2
  CLI="${CARGO_TARGET_DIR}/release/optn"
fi

mkdir -p "${WALLETS}" "${CONFIG}"
common=(--network "${NETWORK}" --wallet-directory "${WALLETS}" --network-config-dir "${CONFIG}" --json)

# Fusion runs only with Tor on, through a proxy the holder declared. In this
# container the declaration is the compose file's own Tor.
"${CLI}" "${common[@]}" network tor on >/dev/null
"${CLI}" "${common[@]}" network tor-trust "${SOCKS_PORT}" >/dev/null

fusion=(fusion --server "${OPTN_FUSION_SERVER}" --auto --fuse-depth "${DEPTH}" --yes)
if [[ -n "${OPTN_FUSION_TIER:-}" ]]; then
  fusion+=(--tier "${OPTN_FUSION_TIER}")
fi

if [[ -n "${OPTN_WALLET_PASSWORD_FILE:-}" ]]; then
  exec "${CLI}" "${common[@]}" --wallet "${OPTN_WALLET}" --password-stdin "${fusion[@]}" \
    <"${OPTN_WALLET_PASSWORD_FILE}"
fi
exec "${CLI}" "${common[@]}" --wallet "${OPTN_WALLET}" --password-stdin "${fusion[@]}" \
  <<<""

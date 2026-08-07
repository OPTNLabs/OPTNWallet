#!/usr/bin/env bash
# fusion-lab entrypoint — Tor is mandatory (CashFusion P2P fail-closed).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# In the container, compose mounts the monorepo at /optn
ROOT="${OPTN_ROOT:-/optn}"
SUPERVISOR="${ROOT}/packages/docker-dev/scripts/fusion-lab-supervisor.mjs"

export OPTN_TOR_REQUIRED="${OPTN_TOR_REQUIRED:-1}"
export OPTN_TOR_SOCKS="${OPTN_TOR_SOCKS:-tor:9050}"
export OPTN_NETWORK="${OPTN_NETWORK:-chipnet}"
export OPTN_DATA_DIR="${OPTN_DATA_DIR:-/optn-data}"

if [[ "${OPTN_TOR_REQUIRED}" == "0" ]]; then
  echo "[fusion-lab] refused: OPTN_TOR_REQUIRED=0 (Tor is mandatory for fusion)" >&2
  exit 2
fi

mkdir -p "${OPTN_DATA_DIR}" 2>/dev/null || true

if [[ ! -f "${SUPERVISOR}" ]]; then
  echo "[fusion-lab] missing supervisor at ${SUPERVISOR}" >&2
  exit 1
fi

exec node "${SUPERVISOR}"

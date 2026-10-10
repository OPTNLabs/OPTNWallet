# VPS / always-on fusion lab (no desktop GUI)

For operators who want **24/7 CashFusion-style presence without the desktop app**.

## Rules (same as desktop)

| Rule | Value |
|------|--------|
| **Default fusion mode** | **`p2p`** — set `OPTN_FUSION_MODE=server` for classic server client |
| **Tor** | **Mandatory** — fail closed if SOCKS is down |
| Default network | **chipnet** |
| Mainnet | `OPTN_NETWORK=mainnet` only if you accept VPS hot-wallet risk |
| Secrets | Volume `optn-fusion-data` only |
| GUI | Not required |

## Start

```bash
export OPTN_NETWORK=chipnet
export OPTN_FUSION_MODE=p2p   # default; omit for same effect
docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab up -d --build
docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab logs -f fusion-lab
```

Or: `npm --prefix packages/docker-dev run up:fusion-lab`

## What runs today

| Service | Role |
|---------|------|
| `tor` | SOCKS on `127.0.0.1:9050` inside the shared network namespace (host: `127.0.0.1:9050`) |
| `fusion-lab` | Supervisor: Tor probe, mode/network validation, health file, restart; optionally the headless Auto Fusion runner |

`fusion-lab` shares the `tor` container's network (`network_mode: service:tor`), so
Tor is on its loopback. Fusion trusts a proxy by its local port, the same rule as
the desktop and the CLI, never by a remote address.

Health file (in volume): `/optn-data/fusion-lab.health.json`

## Choosing P2P vs server

```bash
# Default — P2P (recommended)
OPTN_FUSION_MODE=p2p

# Classic fusion server path (when headless runner supports it)
OPTN_FUSION_MODE=server
```

## Full Auto rounds (server mode)

`scripts/fusion-lab-headless.sh` runs `optn fusion --auto`, the Rust CLI's Auto
Fusion. It uses the same native fusion host as the desktop and the CLI
(`crates/optn-fusion-native`): coin choice, the depth record, keys and fresh
change outputs from the wallet runtime, the Electron Cash protocol. It builds the
CLI from the mounted repository on first start (cached in the data volume) unless
`OPTN_CLI_BIN` names a prebuilt binary, turns Tor on, trusts the container's own
Tor port, and fuses until stopped.

| Step | Status |
|------|--------|
| Tor-bound VPS process | ✅ supervisor |
| Mode / network env | ✅ |
| Headless server-mode Auto Fusion | ✅ `scripts/fusion-lab-headless.sh` |
| Headless P2P (Nostr) Auto Fusion | ⬜ no Rust driver yet; the script refuses `p2p` |

1. Put a saved wallet in the volume: run the wallet console once,
   `docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab run --rm --entrypoint bash fusion-lab`,
   build the CLI, and create or import the wallet with
   `optn --network chipnet --wallet-directory /optn-data/wallets wallet`.
2. Start the runner:

```bash
export OPTN_FUSION_MODE=server
export OPTN_HEADLESS_CMD=/optn/packages/docker-dev/scripts/fusion-lab-headless.sh
export OPTN_WALLET='lab-wallet.optnwallet'
export OPTN_FUSION_SERVER='fusion.example:8789'
# export OPTN_WALLET_PASSWORD_FILE=/optn-data/wallet-password   # omit for no password
docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab up -d
```

The supervisor starts the runner only after Tor answers and passes
`OPTN_FUSION_MODE`, `OPTN_NETWORK`, `OPTN_TOR_SOCKS` and `OPTN_DATA_DIR`. Progress
lines (JSON) go to the container log.

## Env reference

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPTN_FUSION_MODE` | **`p2p`** | `p2p` \| `server` |
| `OPTN_TOR_REQUIRED` | `1` | Must stay `1` |
| `OPTN_TOR_SOCKS` | `127.0.0.1:9050` | SOCKS, on the shared loopback |
| `OPTN_NETWORK` | `chipnet` | `chipnet` \| `mainnet` |
| `OPTN_DATA_DIR` | `/optn-data` | Volume |
| `OPTN_HEADLESS_CMD` | _(empty)_ | Runner started after Tor is ready; `scripts/fusion-lab-headless.sh` for Auto Fusion |
| `OPTN_WALLET` | _(empty)_ | Runner: saved wallet file name in `/optn-data/wallets` |
| `OPTN_FUSION_SERVER` | _(empty)_ | Runner: CashFusion server, `host[:port][:s\|:t]` |
| `OPTN_WALLET_PASSWORD_FILE` | _(empty)_ | Runner: file with the wallet password; empty means no password |
| `OPTN_FUSION_DEPTH` | `3` | Runner: rounds per coin before Auto leaves it |
| `OPTN_FUSION_TIER` | _(empty)_ | Runner: pin one tier (sats) so lab wallets meet |
| `OPTN_CLI_BIN` | _(empty)_ | Runner: prebuilt `optn`; otherwise built from the repo |
| `OPTN_TOR_PROBE_MS` | `5000` | Probe timeout |
| `OPTN_TOR_RECHECK_MS` | `30000` | Health recheck |

## Not for

- Replacing installers for normal users  
- Hardware wallets  
- Clearnet fusion  

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
| `tor` | SOCKS (compose: `tor:9050`, host: `127.0.0.1:9050`) |
| `fusion-lab` | Supervisor: Tor probe, mode/network validation, health file, restart |

Health file (in volume): `/optn-data/fusion-lab.health.json`

## Choosing P2P vs server

```bash
# Default — P2P (recommended)
OPTN_FUSION_MODE=p2p

# Classic fusion server path (when headless runner supports it)
OPTN_FUSION_MODE=server
```

## Full Auto rounds (next app milestone)

Live CoinJoin Auto needs the **desktop wallet stack** (signing, Electrum, and for
P2P the **Tauri Tor↔WebSocket bridge**). That is **not** inside the slim Node lab image.

| Step | Status |
|------|--------|
| Tor-bound VPS process | ✅ supervisor |
| Mode / network env | ✅ |
| Headless unlock + `FusionRunnerService` loop | ⬜ ship as `OPTN_HEADLESS_CMD` or future CLI |

When you have a headless binary/script:

```bash
export OPTN_HEADLESS_CMD='/path/to/headless-fusion-runner'
docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab up -d
```

The supervisor only starts that command **after** Tor is up, and injects
`OPTN_FUSION_MODE`, `OPTN_NETWORK`, `OPTN_TOR_SOCKS`, `OPTN_DATA_DIR`.

Until then, desktop Auto fusion remains the working way to fuse; this profile is
the correct **ops envelope** for VPS (Tor, chipnet default, p2p default).

## Env reference

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPTN_FUSION_MODE` | **`p2p`** | `p2p` \| `server` |
| `OPTN_TOR_REQUIRED` | `1` | Must stay `1` |
| `OPTN_TOR_SOCKS` | `tor:9050` | SOCKS |
| `OPTN_NETWORK` | `chipnet` | `chipnet` \| `mainnet` |
| `OPTN_DATA_DIR` | `/optn-data` | Volume |
| `OPTN_HEADLESS_CMD` | _(empty)_ | Optional full runner after Tor ready |
| `OPTN_TOR_PROBE_MS` | `5000` | Probe timeout |
| `OPTN_TOR_RECHECK_MS` | `30000` | Health recheck |

## Not for

- Replacing installers for normal users  
- Hardware wallets  
- Clearnet fusion  

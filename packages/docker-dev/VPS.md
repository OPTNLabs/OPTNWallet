# VPS / always-on fusion lab (no desktop GUI)

For operators who want **24/7 CashFusion-style presence without the desktop app**.

## Rules (same as desktop P2P)

| Rule | Value |
|------|--------|
| **Tor** | **Mandatory** — fail closed if SOCKS is down |
| **Default fusion mode** | **`p2p`** (same as desktop). Set `OPTN_FUSION_MODE=server` for classic server path |
| Default network | **chipnet** |
| Mainnet | Only if you set `OPTN_NETWORK=mainnet` (hot wallet on VPS = high risk) |
| Secrets | Volume only (`optn-fusion-data`), never in the image |
| GUI | Not required for this profile |

## Start

```bash
# repo root (or after mounting the monorepo)
export OPTN_NETWORK=chipnet   # or mainnet if you accept the risk
docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab up -d --build

# logs (JSON lines from supervisor)
docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab logs -f fusion-lab
```

Or: `npm --prefix packages/docker-dev run up:fusion-lab`

## What runs today

1. **`tor`** — SOCKS on `tor:9050` (host: `127.0.0.1:9050` by default)  
2. **`fusion-lab`** — entrypoint → `fusion-lab-supervisor.mjs`  
   - Probes Tor; **exits non-zero** if Tor is missing (compose restart can recover)  
   - Re-checks Tor every 30s  
   - Holds the env for a future **headless Auto** loop  

## What is not wired yet

| Piece | Status |
|--------|--------|
| Wallet unlock without UI | TBD |
| `FusionRunnerService` Auto loop in process | TBD |
| Server-mode fusion from this container | TBD |

Until then, this profile is the **correct ops contract** (Tor-bound, chipnet default, volume data).  
Desktop Auto fusion remains the working path for real rounds.

## Env reference

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPTN_FUSION_MODE` | **`p2p`** | `p2p` \| `server` (desktop default is p2p) |
| `OPTN_TOR_REQUIRED` | `1` | Must stay `1` for fusion-lab |
| `OPTN_TOR_SOCKS` | `tor:9050` | Tor SOCKS host:port |
| `OPTN_NETWORK` | `chipnet` | `chipnet` \| `mainnet` |
| `OPTN_DATA_DIR` | `/optn-data` | Persistent volume path |
| `OPTN_TOR_PROBE_MS` | `5000` | TCP probe timeout |
| `OPTN_TOR_RECHECK_MS` | `30000` | Health recheck interval |

## Not for

- Replacing AppImage/DMG/MSI for normal users  
- Hardware wallets  
- Clearnet fusion (will not run without Tor)

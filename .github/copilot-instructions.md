# OPTN Wallet — Copilot Instructions

You are working on OPTN Wallet: a self-custodial Bitcoin Cash (BCH) wallet. Upstream is a Capacitor mobile app (React 18 + TypeScript); this repo adds a zero-touch Tauri v2 desktop wrapper.

## RULE 0 — ZERO-TOUCH UPSTREAM (never break this)

NEVER modify upstream source files. Desktop work goes ONLY in these locations:
- `src/platform/desktop/**` (Capacitor→Tauri shims, http-bridge, logger, desktop.css)
- `vite.desktop.config.ts` (wraps vite.config.ts — never edit vite.config.ts or main.tsx)
- `src-tauri/**` (Rust side)
- `.github/workflows/desktop-*.yml`
- `package.json` additions (scripts/deps only)

If a fix seems to require editing an upstream file, STOP and tell the user instead.

## Work discipline (follow mechanically)

1. VERIFY, don't assume: never state a path, version, or status without checking it first.
2. READ before editing: open the file and its callers before changing anything.
3. Smallest correct change: fix root cause, no drive-by refactors, one change at a time.
4. Evidence before claims: never say "fixed/done/works" without running the command and showing output.
5. Debug systematically: read the full error → one hypothesis → cheapest test → then edit. If a fix fails, REVERT it before trying the next idea.

## Security rules (crypto wallet — non-negotiable)

- NEVER log, print, or persist mnemonics or private keys. Keys live in memory only.
- Secrets storage: OS keychain via tauri keyring plugin (desktop), SecureStorage (mobile).
- Tests NEVER touch mainnet — Chipnet/testnet only. Live-network tests are opt-in via env flag.
- Do not bump pinned `-next` versions (libauth 3.1.0-next.8, cashscript 0.13.0-next.3) without being asked.

## Commands (Windows host; use Git Bash for android:* scripts, not PowerShell)

- Dev: `npm run dev` (web) / `npm run tauri:dev` (desktop)
- Tests: `npm run test` · Typecheck: `npm run typecheck:core` · Lint: `npm run lint:core` (0 warnings allowed)
- Full check: `npm run ci:core`
- Desktop build: `npm run tauri:build`

## Definition of done

A task is complete only after: `npm run ci:core` passes AND `git diff --stat` shows no upstream files modified. If key/storage/walletconnect code changed, also run `npm run security:ci`.

## Gotchas already solved (do not regress)

- Vite 8/rolldown blank screen: requires `legacy.inconsistentCjsInterop: true` + `manualChunks` function in vite.desktop.config.ts.
- Price API CORS: server 500s when Origin header present — desktop uses Rust `optn_price_fetch` command in src-tauri, bridged via window.fetch patch in src/platform/desktop/http-bridge.ts.
- Dependency bugs: check `patches/` (patch-package) before fighting node_modules.

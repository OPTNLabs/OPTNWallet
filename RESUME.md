# Resume point — 2026-08-02

Written so work continues without the user present. Branch
`agent/fusion-release-reliability` (PR #12), everything below is pushed.

## Do this first

1. `git log --oneline -12` — the last commits are `f571447` (Codex's server
   privacy boundary, committed on his behalf) and `3cb245d` (chipnet default).
2. Read the tail of `CODEX-HANDOFF.md`. Two reviews, both PASS, and the
   decisions already taken.
3. `npx vitest run` and `cd src-tauri && cargo test --lib` before changing
   anything, so a pre-existing red is not mistaken for your own.

## Known traps, all paid for once already

- **The JS suite is flaky under parallel load.** Different tests fail per run,
  all pass in isolation, CI is green. Re-run a file alone before believing it.
  Cause is detached fire-and-forget work crossing test boundaries; two cases are
  hardened, the residual is NOT diagnosed.
- **libauth byte order.** `outpointTransactionHash` takes the txid in DISPLAY
  order; `encodeTransaction` reverses internally. Reversing again produces
  "Missing inputs" on a broadcast where every signature verifies individually.
  This cost days once.
- **`dist.torproject.org` is unreachable from this machine**, so
  `scripts/fetch-tor.mjs` fails locally. Tor binaries are hand-staged in
  `src-tauri/resources/tor/` and must not be committed.
- **`src-tauri/tauri.conf.json` is locally modified to port 5173** and must not
  be committed until the 5174 question is decided: a different port is a
  different origin, so IndexedDB is a different partition and the user's wallets
  appear to be gone.

## Issue #8 (watch-only) — transport done, UI remains

Built and tested, nothing here needs redoing:

- `src/services/psbt/psbtBch.ts` — BIP174 for BCH. Requests
  `SIGHASH_ALL|FORKID|ANYONECANPAY` (0xC1), refuses a sighash without FORKID at
  encode time, and `verifySignatureSighashTypes` rejects a 0x41 signature when
  0xC1 was requested rather than finalizing a transaction the network will
  refuse. Tests assert the wire bytes SeedCash's parser reads, not a round trip
  through our own encoder.
- `src/services/psbt/urPsbt.ts` — UR `crypto-psbt` in both directions, proven
  byte-identical through animated frames. Serves SeedCash AND Keystone.
- `src/services/psbt/urFramePlayer.ts` — which frame is on screen, kept out of
  React so timing is testable.

The whole spine is therefore: `encodeUnsignedPsbt` -> `encodePsbtToUrFrames` ->
`UrPsbtScanner` -> `verifySignatureSighashTypes` -> broadcast.

**Next, in dependency order:**

1. **Watch-only persistence.** `onboarding/watchOnlyAccountPreview.ts` already
   derives addresses from an xpub; it stops there. Needs a wallets row with the
   xpub, `walletType: 'watch-only'`, no mnemonic, and an entry alongside the
   mnemonic options on the landing page. Everything downstream assumes the
   wallet exists.
2. **Send screen.** Coin control over the wallet's UTXOs, the PSBT shown with an
   Export and an Import button, a raw-transaction view, the animated QR, the
   camera scan back, then broadcast. All of it sits on the tested spine above.
3. Mixed CashToken outputs (NFT + FT + BCH) are explicitly in scope per the
   user; Paytaca is the reference implementation to match.

Upstream: `SeedCashOrg/seedcash#2` makes the device honour the requested
sighash. Our side does not depend on it landing.

## Hardware wallets — diagnosis done, fix not started

Not four device bugs, one platform mismatch: Ledger uses WebHID, Trezor and
OneKey use a hosted connect iframe, and **WebView2 implements none of the
browser device APIs**. Proof: the whole app log contains zero
ledger/trezor/onekey/hid lines — the attempts never reached logging code.

`src/services/hardware/hardwareTransportSupport.ts` now says so honestly instead
of failing like a bad cable. The real fix is native, exactly as this project
already concluded for CashFusion: `hidapi` for USB and `btleplug` for Bluetooth
in Rust, behind a Tauri command. Keystone is the exception — air-gapped, needs
only a camera, and is unblocked by the PSBT/UR work above.

## Server CashFusion — one step from end to end

Everything green is against a mock, plus a handshake against a real server. **No
full round has ever completed.** That is the same position P2P was in before
nine consecutive root-cause fixes, every one only findable by running it.

A real Electron Cash server is the way to close it:

    python D:\reference\electron-cash\run_fusion_server.py 8787

Two non-obvious requirements, both already solved there:
- `libsecp256k1-0.dll` must be in `electroncash/`. Fusion hard-requires
  `secp256k1_schnorr_sign`, a BCH-specific symbol that stock libsecp256k1 and
  coincurve do not export, and the pure-python Schnorr fallback does not satisfy
  `compatibility.check()`. It was taken from the EC 4.4.5 Windows installer,
  SHA256 verified against the published checksum.
- The server is constructed directly, because `electron-cash daemon start` calls
  `os.fork()` and cannot run on Windows.

Its test params (`min_clients=2`, `ip_max_simul_fuse=20`, `start_time_min=10`)
exist so one machine can reach a round. They **weaken privacy** and make this a
wire-protocol check, never a privacy result: a two-player fusion is trivially
de-anonymisable.

`fusion_execution_ready()` is still `false`. The user has cleared Codex to open
it. My review passed the code; my only ask was that the first real round not
also be the first time the path runs end to end. Not a blocker.

## P2P hardening — planned, not started

Server-side has the cryptography (blind Schnorr in `fusion/schnorr.rs`, Pedersen
in `fusion/pedersen.rs`, covert connections with per-circuit Tor isolation).
P2P has none of it and groups a participant's outputs by message boundary, which
is the leak — not the key.

Order, cheapest and most concrete first:
1. Coordinator election. "Lowest ephemeral pubkey wins" is grindable today.
   P2P-only; the server path has no election.
2. Broadcast liveness. The coordinator is the sole broadcaster, so its death
   after signature collection strands a fully signed transaction.
3. Port credentials/commitments to P2P — reuse, not new cryptography.
4. Privacy analyzer, which measures both transports and is the only honest way
   to compare them.

# CashFusion: implementation status and plan

## Phase 1 — DONE (real protocol client)

The wallet now speaks the actual CashFusion wire protocol. Not a probe, not a
mock: `src-tauri/src/fusion/` connects over TCP+TLS, sends a real `ClientHello`,
and decodes the server's `ServerHello`.

**Verified live** against the public default server from Electron Cash's own
`conf.py` (`fusion.servo.cash:8789`, SSL) — run it with
`cargo test --test fusion_live -- --ignored --nocapture`:

```
tiers: [ ...16 real pool tiers... ], num_components: 23,
component_feerate: 1000, min_excess_fee: 10, max_excess_fee: 300000,
donation_address: Some("bitcoincash:qpfkr2qsyz9qpfth4efvpqkha7u4mu3ft5a6khx8r0")
```

Settings → CashFusion's "Query Server" button surfaces exactly this. That test
is `#[ignore]`d by default so CI never depends on a third-party host being up.

### Why the client is in Rust
CashFusion is raw TCP with TLS and protobuf framing. A WebView can only open
HTTP/WebSocket connections, so the frontend **cannot** speak this protocol at
any level — the previous `wss://` "probe" could only detect that *something*
was listening on the port. On mobile/web, `src/services/fusion/FusionStatusService.ts`
therefore throws a clear platform-limit error rather than pretending; the desktop
build swaps in the Rust-backed version via `vite.desktop.config.ts`.

### What Phase 1 deliberately does NOT do
It joins no pool, submits no coins, and signs nothing — so it cannot move funds.
`experimentalSlice.cashFusionEnabled` still defaults to `false`.

### Wire details (all read from the reference implementation, not guessed)
Every constant traces to Electron Cash (`electroncash_plugins/fusion/`):
- Frame: `<8-byte magic 765be8b4e4396dcf><4-byte big-endian length><protobuf>` — `connection.py`
- `MAX_MSG_LENGTH = 200 KiB`, enforced before allocating — `connection.py`
- Protocol version `alpha13` — `protocol.py`
- Message schema — `protobuf/fusion.proto`, vendored verbatim to
  `src-tauri/proto/fusion.proto` (MIT, © 2020 Mark B. Lundeberg)

`build.rs` compiles the schema with **protox** (pure-Rust) rather than
prost-build's default path, which shells out to a `protoc` binary that is not
installed on this machine or on the CI runners.

## Phase 2 — NOT STARTED: joining a pool and fusing coins

This is the hard, privacy-critical half. It is deliberately left for a
dedicated, carefully-reviewed pass rather than rushed, because a subtle bug
here can **deanonymize the very user it is meant to protect** — and unlike a
crash, that failure is silent.

Required pieces, each mapping to a reference file:
1. **Pool join + tier selection** — `JoinPools` / `TierStatusUpdate`
   (`fusion.py`). Mechanical now that Phase 1 exists.
2. **Commitments and blind signatures** — `PlayerCommit` / `BlindSigResponses`.
   Needs Pedersen commitments (`pedersen.py`) and blind Schnorr signing, so that
   nobody — including the server — learns the input→output mapping.
3. **Covert connections** — `covert.py`. Each participant opens *separate*,
   independently-timed connections to submit components and signatures,
   specifically so the server cannot correlate a submitter's inputs with its
   outputs. Getting the timing/connection discipline wrong destroys the privacy
   guarantee while the feature still appears to work.
4. **Round state machine + blame** — `protocol.py`, `validation.py`. Handles
   restarts and identifying misbehaving players.
5. **Coin selection and fees** — must respect the tiers and feerates Phase 1
   already reads from the server.

## Phase 3 — Tor

Electron Cash routes covert connections over Tor. Without it, a network-level
observer can correlate connections no matter how correct the cryptography is.

## Testing rule

Fusion work must never touch mainnet funds. Phase 1's live test performs only
the read-only hello handshake (no wallet, no keys, no coins involved). Phase 2
must run against a locally-run Electron Cash `server.py`, or Chipnet.

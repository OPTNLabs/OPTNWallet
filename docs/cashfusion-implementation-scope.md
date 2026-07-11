# CashFusion: what "actually working" requires

## Current state (honest)

`src/features/settings/CashFusionSettings.tsx` is a UI-only stub: it opens a
`wss://` WebSocket to the configured host:port and reports whether the TCP
handshake succeeds. Its own on-screen text already says this plainly: *"this
probe tests TCP reachability, not the CashFusion protocol handshake."* There
is no fusion round participation, no coin shuffling, no protocol client at
all. `experimentalSlice.cashFusionEnabled` defaults to `false`.

## Why this can't be "finished" quickly

1. **CashFusion's real protocol is raw TCP + TLS with protobuf message
   framing** (see Electron Cash's `electroncash_plugins/fusion/`, the
   reference implementation — Python, `.proto` schema in
   `fusion_pb2.py`/`fusion.proto`). Browsers and Tauri's WebView **cannot
   open a raw TCP socket** — only WebSocket/HTTP/fetch. A `wss://` probe
   (what we have) can only ever test whether *something* is listening on
   that port, never speak the actual protocol.
2. **No existing JS/WASM CashFusion client exists.** Checked npm directly
   (`npm search cashfusion`, `npm view cashfusion`, `npm view
   @cashfusion/client`) — zero results. Checked Selene Wallet
   (`D:\Selene Wallet`) per the user's suggestion to look there first — no
   CashFusion references anywhere in its source or `package.json` either.
   This is a real gap in the BCH JS ecosystem, not something we're missing.
3. **The protocol itself is non-trivial cryptography**, not just "connect and
   send a message": clients submit blinded commitments to inputs/outputs,
   the server coordinates a covert multi-round shuffle so no single party
   (including the server) can link a client's inputs to its outputs, and
   there's a whole state machine for round timing, covert connections
   (each client makes a SEPARATE anonymous connection for the output-reveal
   phase, specifically so the server can't correlate input-submitter to
   output-submitter), and Schnorr blind signatures. Getting this wrong
   doesn't just break the feature — a subtly wrong implementation could
   deanonymize the user it's supposed to protect, or worse, be exploited to
   misdirect funds during a round. This is exactly the kind of code that
   needs a dedicated, unhurried implementation + review pass, not something
   to build under time pressure in an already-long session.

## What a real implementation needs (scope, not a task list to rush)

1. **A Rust-side TCP+TLS client** (Tauri command, same pattern as the
   existing `optn_price_fetch` CORS-bypass command in `src-tauri/src/lib.rs`)
   that speaks CashFusion's protobuf wire protocol. This is the biggest
   single piece of new code — essentially porting Electron Cash's
   `fusion.proto` + the client-side state machine
   (`electroncash_plugins/fusion/protocol.py`,
   `electroncash_plugins/fusion/fusion.py`) from Python to Rust, or finding
   an existing Rust crate that already implements the wire protocol (worth
   checking `crates.io` in a future session before writing this by hand —
   not checked yet this pass).
2. **An IPC bridge** exposing that Rust client to the frontend (start round,
   report progress, report result) — small, mechanical, once (1) exists.
3. **Coin selection + blinded-commitment logic** on the crypto side —
   `@bitauth/libauth`'s Schnorr primitives are already a dependency here, so
   the blind-signature math is plausible to build in TypeScript IF the
   Rust side just handles the wire protocol and the JS side handles the
   crypto commitments passed across the bridge — worth designing carefully
   rather than assuming everything belongs in Rust.
4. **UI**: round status, participating-coins selection, fee display — this
   part is straightforward once (1)-(3) exist; not the hard part.

## Recommendation

Do this as its own dedicated session with a clear go/no-go checkpoint after
step 1 (the protobuf/TCP client) — if a usable Rust crate for CashFusion's
wire protocol exists, this becomes a multi-day feature; if it has to be
hand-ported from Electron Cash's Python, it's realistically a multi-week one.
Do not enable `cashFusionEnabled` by default, and do not remove the current
honest "reachability only" framing until a real client exists behind it.

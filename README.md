# OPTN Wallet

OPTN Wallet is a Bitcoin Cash wallet focused on secure transaction flows, CashTokens support, and extensibility for external apps.

This `README` is the high-level entrypoint. Technical implementation and integration details live in [`docs/`](./docs/README.md).

## Documentation Map

- [Developer Docs Index](./docs/README.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Build and Release Scripts](./docs/build-and-release.md)
- [Wallet Architecture](./docs/wallet-architecture.md)
- [Integration Guide](./docs/integration-guide.md)
- [Addon Development Guide](./docs/addon-development-guide.md)
- [Addon SDK Reference](./docs/addons-sdk.md)

## For Third-Party Developers

There are two primary ways to integrate with OPTN Wallet:

- Wallet-to-dApp via WalletConnect.
- In-wallet addon apps using the Addon manifest + Addon SDK model.

Start with [Integration Guide](./docs/integration-guide.md), then go deeper into addon docs if you are building embedded wallet apps.

## Quickstart (Local Development)

1. Clone and install:

```bash
git clone https://github.com/OPTNLabs/OPTNWallet.git
cd OPTNWallet
npm install
```

2. Configure environment:

```bash
cp .env.sample .env
```

Set at least:

- `VITE_WC_PROJECT_ID` for WalletConnect
- Any API keys you need for your local flows

3. Run:

```bash
npm run dev
```

### Optional: Docker contributor lab

For a clean Linux shell (tests / tooling — **not** the production wallet image):

```bash
docker compose -f packages/docker-dev/docker-compose.yml up -d --build
docker compose -f packages/docker-dev/docker-compose.yml exec dev bash
# inside: npm ci && npm run test:core
```

Contributor process: [`CONTRIBUTING.md`](./CONTRIBUTING.md). Details:
[`packages/docker-dev/README.md`](./packages/docker-dev/README.md) and
[`docs/docker-dev.md`](./docs/docker-dev.md).

## Quality Checks

- `npm run typecheck`
- `npm run test`
- `npm run addons:validate`
- `npm run build`

## Build Scripts

See [Build and Release Scripts](./docs/build-and-release.md) for Android APK/AAB commands and iOS preparation commands.

## High-Level Repository Layout

- `src/pages/` UI routes and host screens
- `src/services/` runtime services (wallet, tx, addons, policy)
- `src/types/` shared domain models (including addon manifest/capabilities)
- `src/addons/builtin/` curated built-in addon manifests
- `schemas/` JSON schemas (including addon manifest schema)
- `docs/` technical documentation

## Project Links

- Website: https://www.optnwallet.com/
- Source: https://github.com/OPTNLabs/OPTNWallet

## P2P CashFusion Architecture

OPTN's P2P CashFusion transport is a serverless CoinJoin protocol inspired by
the rolling-pool design used by
[00-Wallet](https://github.com/00-Protocol/00-Wallet/blob/893a2006fe9ec2a4e4162ea46de56af438e4fa20/landing/views/fusion.js#L99).
Peers discover one another through Nostr relays over Tor, agree on a temporary
coordinator, independently verify the complete transaction, and sign only their
own inputs. The coordinator orders messages and broadcasts the completed
transaction; it never receives a private key and cannot make another wallet
sign away funds.

**Full protocol reference (wire format, phases, Auto, depth, timings):**
[docs/p2p-cashfusion-protocol.md](./docs/p2p-cashfusion-protocol.md).  
**Privacy layer naming (Tor vs gift-wrap vs onion vs blind Schnorr):**
[docs/p2p-cashfusion-privacy-layers.md](./docs/p2p-cashfusion-privacy-layers.md).

Server-based CashFusion and P2P CashFusion share the wallet's outer controls
(manual/automatic start, live-coin refresh, fuse depth, cooldown, and
cross-window exclusion), but they are different network protocols. The server
path follows Electron Cash's pool, blind-signature, covert-submission, and blame
timing. The P2P path replaces that server choreography with the Nostr round
described below.

### Identities, discovery, and privacy

- Every attempt creates a fresh secp256k1 round key. It is never the wallet's
  BCH key or persistent Nostr/chat identity.
- A signed, replaceable Nostr event of kind `12230` announces the network,
  supported tiers, input count, and expiry. The rolling announcement is scoped
  to mainnet or chipnet, refreshed while waiting, and replaced with an expired
  event when the wallet leaves.
- Incoming announcements are admitted only after their event signature,
  protocol version, network tags, timestamp, expiry, tiers, size, and component
  counts pass bounded validation.
- Private round messages use the standard
  [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift-wrap
  kind `1059`, produced by `nostr-tools`' NIP-17 wrapper. The encrypted seal and
  rumor use [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md).
  On a relay, round traffic therefore has the same outer event kind as an
  ordinary private message rather than a custom “fusion message” fingerprint.
- Input registration and the later signature channel use the temporary round
  identity and are therefore attributable within that round. Outputs take a
  different path: each canonical output carries a blindly issued, one-use
  credential bound to the network, session, tier, value, script, and random
  serial; the shuffled onion is revealed through a throwaway NIP-59 author and
  a separate Tor relay pool. The coordinator verifies exact quotas and consumes
  serial nullifiers without learning which participant redeemed each output.
- Chat and fusion do not share identities: chat gift-wraps target the user's
  persistent Nostr identity, while fusion gift-wraps target per-round public
  keys. Recipient tags keep the subscriptions separate even though both use
  kind `1059`.

These layers reduce linkage by relay-visible identity and connection. They do
not claim to defeat a global observer correlating timing across every relay and
Tor connection.

### Round sequence

```text
1. Announce and find peers
   replaceable kind 12230 -> validate -> select a compatible tier/group

2. Agree on a round
   lowest temporary pubkey proposes -> live peers acknowledge -> round starts
   (a silent/stale coordinator is removed and election repeats)

3. Register and verify
   attributable inputs + authorized anonymous outputs -> deterministic assembly
   every peer checks its exact inputs/outputs, total value, and fee bounds

4. Sign
   each wallet crosses the native Rust boundary and signs only its own inputs
   using Electron Cash's modified-RFC6979 BCH Schnorr
   SIGHASH_ALL | FORKID (0x41) commits to the shared transaction outputs

5. Finalize and broadcast
   coordinator requires one signature for every registered input -> finalizes
   -> broadcasts through native Tor-only relay/observation -> checks exact txid
   participants match the final serialized transaction before accepting it
```

Pool selection prefers the compatible tier with the largest anonymity set.
Participant ordering and coordinator election are deterministic. A coordinator
that disappears before proposing is dropped; a coordinator that sends an
invalid or incomplete transaction is rejected before any honest participant
signs.

Before each round the wallet reconciles live, non-token UTXOs, excludes coins
reserved by another round, and persists fresh output keys before sharing their
locking scripts. Automatic and manual starts use the same wallet-scoped runner.
Automatic starts additionally enforce the configured fuse depth and a durable
fee cooldown. Wallet, network, master-Fusion, or transport-mode changes abort
the active round and release its reservations when the session unwinds. Auto,
Tor, relay, and server-preference edits apply to the next round without
cancelling an in-flight financial action. Cancellation
cannot reverse a transaction once a network broadcast has already begun.

The implementation is split across:

- `src/platform/desktop/nostr/fusion.ts` — rolling pool announcements and group
  selection
- `src/platform/desktop/nostr/fusionRendezvous.ts` — coordinator election,
  acknowledgements, and stale-coordinator failover
- `src/platform/desktop/nostr/fusionTransport.ts` — NIP-44/NIP-59 gift-wrapped
  relay transport and anonymous output registration
- `src/platform/desktop/nostr/fusionRound.ts` — deterministic assembly and the
  pre-signing value/fee safety gate
- `src-tauri/src/fusion/p2p_sign.rs` — bounded native P2P template validation
  and Electron Cash-compatible BCH signing
- `src/platform/desktop/nostr/fusionBlindSchnorr.ts` — one-use blind input and
  output credentials with v3 domain separation
- `src/platform/desktop/nostr/fusionCredentialNullifiers.ts` — active-round
  output credential replay protection
- `src/platform/desktop/nostr/fusionSession.ts` — registration, verification,
  signing, finalization, and broadcast choreography
- `src/platform/desktop/FusionP2pService.ts` — wallet/Tor integration, fresh
  outputs, reservations, completion tracking, and cleanup

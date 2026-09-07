# WizardConnect Integration Notes

## Verified integration notes — 2026-09-08

The design notes below are historical. The adapter, connection manager, per-pairing
relay identity storage, and approval UI now exist. Review the installed
`@wizardconnect/wallet` 0.1.5 API alongside the current Riften documentation:
the installed adapter returns `signedTransaction`, while the current wallet-page
example calls that property `signedTransactionHex`. OPTN's manager consumes the
installed API; do not rename that property solely to match the newer example.

- `RelayConnectionState.status` reports relay transport state. The installed
  manager keeps handshake discovery private; a reachable relay alone does not
  prove that the dApp is available. Connection panels and signing approval must
  use the same status mapping.
- Sign requests use `WcSignTransactionRequest`; its transaction may be raw hex
  or a structured transaction. Approval must decode the same representation the
  signer accepts, show the selected network's addresses, and disable signing
  when the transaction/source-output preview is unavailable.
- Riften's [relay serialization](https://docs.riftenlabs.com/wizardconnect/serialization/)
  encodes bytes as plain hex or extended `Uint8Array` strings and amounts as
  extended `bigint` strings. The pinned SDK does not expose the newer decoding
  helpers. `decodeWizardConnectTransaction` validates and converts both formats
  for the approval UI and adapter, including token data and covenant scripts.
  Missing source outputs, malformed fields, and invalid totals fail closed.
- The [protocol's signature requirement](https://docs.riftenlabs.com/wizardconnect/protocol/#sighash-requirement-security-critical)
  is `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS` (`0x61`). The software signer
  supplies every source output to the shared Rust signing core, including preset
  covenant inputs. A regression test verifies both signature flags and rejection after
  a source-output substitution.
  Native, serialized, and partially signed transaction fixtures are checked
  using libauth's BCH virtual machine. Hardware signing remains unverified for
  this signature requirement; successful software tests do not certify it.
- [Named xpub paths](https://docs.riftenlabs.com/wizardconnect/pubkey-derivation/)
  describe protocol roles, not a mandatory internal account path. OPTN derives
  them from the wallet's saved account path. The historical coin-type-145 note
  below is a recommendation, not a protocol restriction.
- Live Chipnet checks against Cauldron verified pairing with both WizardConnect
  and WalletConnect, WizardConnect approval cancellation and disconnect, and
  small swaps through both protocols. The original WizardConnect swap exposed
  the raw-hex preview bug; the next attempt exposed missing relay decoding.
  Both failed attempts were cancelled before broadcast. After the fixes, the
  WizardConnect swap succeeded; its retrieved transaction and source outputs
  passed the BCH VM and its wallet signature uses `0x61`.
  These are browser integration checks, not native-platform or hardware-wallet
  certification. Public Chipnet transaction IDs:
  - WalletConnect: `e7fc235f350d8c1de4a8989993a30d820487e65e28a53c8c2e935fc12a724f93`
  - WizardConnect: `704dcb0d6ddc62a87cb5bb2ff4dd02062d9d21bd17efc0ac1c4247a33c93d17a`
  - After moving signing into Rust: WizardConnect transaction
    `334822643fbc18e19c8e789efbe1e736d99daa9959c904cce907a0a770b9debf`
    exchanged 2,000 test sats with a 1,221-sat fee. The rebuilt Rust CLI retrieved
    it and its parent; all six inputs passed the BCH VM and the wallet signature
    uses `0x61`. This was a local production web build, not an emulator test.

### Shared signing boundary in PR #80

`crates/optn-core::connect` owns BCH/CashTokens signing serialization, supported
sighash modes, source-output/key checks, Schnorr signatures and P2PKH lock/unlock
scripts. It reuses the Schnorr implementation published in PR #63 at
`d9deb7b348a7af03204b82b57cf0d892b9ec6227`. WalletConnect, WizardConnect and
CashConnect's wallet-owned P2PKH directives call that core through
`src/services/connect/ConnectSigningCore.ts` and generated WASM. The native CLI
calls the same signing serialization directly; its existing ECDSA signer and
`0x41` mode are preserved. Connector software signatures use `0x61`.

This is a signing boundary, not a complete port of the protocol engines. SDK
session management, transport, HD derivation, approval policy, arbitrary template
execution and hardware adapters remain in their existing integrations. The core
accepts an approved transaction; it does not independently authorize sessions or
prove covenant and token conservation. The approval and BCH VM checks still
matter.

Desktop, mobile and browser builds use the same WASM through their existing web
shell. Chrome and Firefox remain popup-only viewers: their route restrictions
and broadcast-denial adapter are retained. Shared code does not enable extension
spending or solve popup/background-session lifetime. CLI use does not depend on
a GUI or Tauri. Full architecture migration remains with PR #63.

Rebuild bindings after Rust changes with
`npx --no-install tsx scripts/build-optn-core-wasm.mts`. The shared Rust CI job
checks source/artifact freshness, native Rust tests, committed WASM against
libauth and the BCH VM, and a fresh Rust-to-WASM rebuild. CLI native matrix jobs
also test the core, and the Rust dependency audit includes its lockfile without
advisory exceptions. These checks complement the existing platform previews;
repository administrators must separately configure required status checks.

## Historical design proposal

Date: 2026-03-20

## Summary

WizardConnect is a BCH-focused wallet pairing protocol, not a drop-in replacement for WalletConnect.

It differs from our current WalletConnect integration in three important ways:

1. The wallet does not expose a generic JSON-RPC surface. It participates in a purpose-built protocol.
2. The wallet sends named BIP32 xpubs during handshake so the dapp can derive addresses locally.
3. The main request/response loop in the current docs is transaction signing, not arbitrary RPC and not generic message signing.

This means WizardConnect should be added alongside WalletConnect as a separate connector service, not folded into the existing `walletconnect` Redux slice.

## What The Protocol Does

Relevant docs:

- https://docs.riftenlabs.com/wizardconnect/
- https://docs.riftenlabs.com/wizardconnect/connection-uri/
- https://docs.riftenlabs.com/wizardconnect/protocol/
- https://docs.riftenlabs.com/wizardconnect/pubkey-derivation/
- https://docs.riftenlabs.com/wizardconnect/transport/
- https://docs.riftenlabs.com/wizardconnect/dapp/
- https://docs.riftenlabs.com/wizardconnect/wallet/
- https://docs.riftenlabs.com/wizardconnect/react/

High-level flow:

1. The dapp generates a `wiz://` URI containing its Nostr pubkey and a short shared secret.
2. The wallet scans that URI and connects to the relay from the URI.
3. The wallet sends `wallet_ready`, which includes:
   - the wallet Nostr pubkey
   - the shared secret echoed back for MITM protection
   - protocol support info
   - session data for `hdwalletv1`
4. In `hdwalletv1`, the wallet sends named xpubs for `receive`, `change`, and `defi`.
5. The dapp derives child pubkeys locally from those xpubs and only comes back to the wallet when it needs a transaction signature.

Transport details:

- Relay transport uses Nostr gift-wrap events (`kind: 1059`) over WebSocket.
- Messages are end-to-end encrypted.
- Both sides are designed to reconnect independently.
- Default relay in the docs is `wss://relay.cauldron.quest:443`.

Signing details:

- The documented app protocol action is `sign_transaction_request`.
- The wallet returns `sign_transaction_response`.
- `sign_cancel` and `disconnect` are also part of the protocol.
- Wallets are expected to sign with `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS`.

## What This Means For OPTN Wallet

## Good fit

- We already have BCH signing code and BCH key derivation primitives.
- We already have barcode scanning UI patterns from WalletConnect.
- We already initialize connection infrastructure globally in app lifecycle, so a second connector is feasible.

## Important mismatch with current architecture

Our current WalletConnect implementation is session-RPC oriented:

- bootstrap in `src/redux/walletconnectSlice.ts`
- app lifecycle init in `src/app/useAppLifecycle.ts`
- connect UI in `src/components/WcConnectionManager.tsx`
- request handling in `src/redux/walletconnect/thunks.ts`

WizardConnect expects a wallet adapter abstraction instead:

- provide wallet metadata
- provide a relay identity private key
- provide xpubs for named derivation paths
- receive a transaction sign request
- let the host app approve or reject it

So the clean integration is:

- keep WalletConnect exactly as-is
- add a new `wizardconnect` module with its own state and manager
- share lower-level BCH key derivation and signing helpers where possible

## Current Codebase Readiness

Current strengths:

- `src/apis/WalletManager/KeyGeneration.ts` already derives BCH keys from mnemonic using libauth.
- `src/apis/WalletManager/KeyManager.ts` already has access to encrypted mnemonic/passphrase material through the wallet database.
- `src/redux/walletconnect/signing.ts` already contains substantial BCH transaction signing logic that can likely be adapted for WizardConnect transaction requests.

Current gaps:

1. We do not currently expose xpub derivation as an app service.
2. We do not currently have a dedicated persisted relay identity key for a WizardConnect session.
3. We do not currently have a WizardConnect session store, connection list, or approval UI.
4. We do not currently have an adapter that maps OPTN wallet internals to the `WalletAdapter` interface described by the docs.

## Recommended Implementation Shape

## 1. Add a wallet-side integration layer

Create a new module, separate from WalletConnect:

- `src/redux/wizardconnectSlice.ts`
- `src/redux/wizardconnect/`

Suggested responsibilities:

- initialize and own the WizardConnect wallet manager
- track active WizardConnect connections
- track pending sign requests
- handle disconnects and reconnect state

## 2. Add an OPTN wallet adapter

Create a wallet adapter wrapper around our existing key and signing services.

Suggested files:

- `src/services/wizardconnect/OptnWizardWalletAdapter.ts`
- `src/services/wizardconnect/derivation.ts`
- `src/services/wizardconnect/signing.ts`

Adapter responsibilities:

- `getWalletMetadata()`
- `getRelayIdentityPrivateKey()`
- `getXpub(path)`
- `signTransaction(request)`

## 3. Add xpub derivation support

We should derive xpubs from the wallet mnemonic on demand using libauth.

Recommended path mapping from the docs:

- `receive` -> `m/44'/145'/0'/0`
- `change` -> `m/44'/145'/0'/1`
- `defi` -> `m/44'/145'/0'/7`

These BCH paths use coin type `145` on both mainnet and chipnet. The selected
network changes extended-key and CashAddr encoding, not the BIP44 BCH coin type.

## 4. Reuse existing signing logic carefully

`src/redux/walletconnect/signing.ts` is a strong starting point, but it is not plug-and-play:

- WalletConnect request shapes are different.
- WizardConnect uses `inputPaths` tuples to identify which wallet path/index signs each input.
- WizardConnect’s security model explicitly depends on the wallet enforcing the required sighash flags.

Best path:

- extract BCH transaction signing into a protocol-neutral helper
- keep thin protocol adapters for WalletConnect and WizardConnect

## 5. Add UI as a second connector, not part of onboarding

Recommended initial UI location:

- Settings or Connections page, beside existing WalletConnect controls

Why:

- WizardConnect is for pairing with external dapps, not for wallet creation/import
- onboarding should stay focused on seed creation/import and network selection

The active file `src/pages/onboarding/CreateWalletPage.tsx` does not look like the right first integration point.

## 6. Persist session-safe state only

Relay identity keys are CSPRNG per pairing, encrypted with
`SecretCryptoService`, and restored on adapter create. See
[Nostr identity isolation](./nostr-identity-isolation.md).

We persist:

- encrypted relay identity key per wallet + pairing (hash of the URI, never the raw URI)
- connection metadata the library already keeps in memory for the live session

We should not persist:

- plaintext relay private keys
- the pairing URI (it contains the short shared secret)
- duplicated xpub caches if they can be reconstructed safely
- chat NIP-06 keys or CashFusion round keys in this store

## Risks And Open Questions

1. Package availability and licensing need confirmation before shipping. The docs say WizardConnect is LGPL-3.0-or-later.
2. The docs are clearly dapp-heavy and wallet integration examples are minimal, so we should verify package maturity before committing to a full production rollout.
3. Message signing support is not documented the same way transaction signing is. We should assume transaction signing only unless the library or source confirms otherwise.
4. The relay default is external infrastructure. We should decide whether OPTN is comfortable depending on that relay or wants a configurable/self-hosted path.
5. Relay identity key lifecycle (decided): CSPRNG per dapp pairing, encrypted
   persist, restore on app restart. Not URI-derived. Not HD-derived from the
   seed. Seed-only reinstall requires scanning the pairing URI again.

## Recommended Build Order

1. Add the dependency and verify it builds in our Vite/Capacitor environment.
2. Build a small internal `OptnWizardWalletAdapter` prototype that can derive xpubs and parse a scanned `wiz://` URI.
3. Add pending-request plumbing and a minimal sign approval modal.
4. Reuse or extract signing logic from WalletConnect into a shared BCH transaction signer.
5. Add a simple "Scan WizardConnect QR" entry next to WalletConnect in settings.
6. Test reconnect behavior on Android, especially backgrounding, process death, and camera scan handoff.

## Recommendation

WizardConnect looks technically compatible with OPTN Wallet and worth integrating, but it should be implemented as a separate BCH-native connection stack, not as an extension of the existing WalletConnect slice.

The fastest safe path is to treat this as:

- shared signing core
- separate protocol adapter
- separate UI and session state

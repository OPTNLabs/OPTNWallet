# WizardConnect Integration Notes

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

For chipnet/testnet we should preserve our existing coin type behavior and confirm what the consuming dapps expect.

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

We should persist:

- connection metadata
- relay identity key if reconnection is required across app restarts
- peer pubkey and session identifiers if the library expects them

We should not persist:

- unnecessary plaintext secrets
- duplicated xpub caches if they can be reconstructed safely

## Risks And Open Questions

1. Package availability and licensing need confirmation before shipping. The docs say WizardConnect is LGPL-3.0-or-later.
2. The docs are clearly dapp-heavy and wallet integration examples are minimal, so we should verify package maturity before committing to a full production rollout.
3. Message signing support is not documented the same way transaction signing is. We should assume transaction signing only unless the library or source confirms otherwise.
4. The relay default is external infrastructure. We should decide whether OPTN is comfortable depending on that relay or wants a configurable/self-hosted path.
5. Relay identity key lifecycle needs a deliberate decision:
   - per connection
   - per wallet
   - per installed app session

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

# Nostr identities in OPTN Wallet

OPTN uses Nostr for more than one job. Those jobs do not share keys. Mixing
them would let a dapp, a mix peer, or a relay correlate traffic that is
supposed to stay separate.

Official WizardConnect adapter docs:
[Wallet integration](https://docs.riftenlabs.com/wizardconnect/wallet/).
The adapter may use an ephemeral CSPRNG key or a stable key. Stability across
restarts is not required, because `wallet_ready` re-exchanges the wallet
pubkey. OPTN still persists a per-pairing CSPRNG key so mobile process death
does not silently mint a new relay identity for an active pairing.

## Identity table

| Job | Key | Lifetime | Why |
| --- | --- | --- | --- |
| Chat | NIP-06 from seed (`m/44'/1237'/0'/0/0`) | Long-lived, re-derived from the mnemonic | Contacts must find the same `npub` after restore |
| P2P CashFusion | Fresh throwaway secp256k1 key every round | Dies with the round | Unlinkability. Discovery never uses the wallet or chat identity |
| WizardConnect | CSPRNG per dapp pairing, encrypted at rest | Survives app restart and process death. Does **not** come back from seed-only reinstall | The dapp must recognize *this pairing*, not the chat persona and not a mix round |

Do not reuse:

- BIP44/145 BCH spending keys as Nostr transport keys
- the NIP-06 chat identity as a WizardConnect relay key
- a CashFusion round key as a WizardConnect relay key
- the pairing `wiz://` URI as material for the relay private key

The pairing URI is created by the dapp and shown as a QR code. Hashing
`walletId + uri` into the relay key would let anyone who saw the URI compute
the wallet's Nostr identity for that session.

## WizardConnect relay key rules

- Generate with `crypto.getRandomValues` (`src/services/wizardconnect/relayKeyStore.ts`).
- Persist ciphertext through `SecretCryptoService`. Storage keys are
  `walletId` plus a hash of the canonical URI, never the raw URI.
- Hydrate the in-memory map when the WizardConnect adapter is created.
- After a seed-only restore on a new device, the user scans again. That is
  allowed by the protocol and keeps relay identities out of the HD tree.
- Leave RPA / BIP352 handshake extensions alone; they are a separate protocol
  discussion.

Related:

- [WizardConnect integration notes](./wizardconnect-integration-notes.md)
- [P2P CashFusion protocol](./p2p-cashfusion-protocol.md)

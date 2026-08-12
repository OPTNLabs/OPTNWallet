---
applyTo: "src/**"
---

# Wallet code security rules

- Mnemonics and private keys: in-memory only. Never in logs, console, Redux devtools payloads, error messages, test fixtures, or comments.
- Key derivation: BIP39/BIP44 via libauth; never roll custom crypto; never change derivation paths on existing wallets (funds become invisible).
- Transaction signing: SIGHASH_ALL|FORKID; validate every output address and amount before signing; dust limit 546 sats.
- Amounts: integers in satoshis end-to-end; use decimal.js only at display boundaries; never float arithmetic on money.
- Addresses: CashAddr format; validate with libauth before use; never guess or autocorrect a user-entered address.
- Tests: Chipnet only, never mainnet; mock Electrum for unit tests; live tests behind env flags.
- Any change touching keys, storage, signing, or WalletConnect requires running `npm run security:ci` before completion.

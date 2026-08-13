# CashConnect

BCH contract-system connector over Nostr. Separate from WalletConnect and
WizardConnect.

- Package: `@cashconnect-js/nostr` (`Wallet`) `1.0.0-alpha.31`
- Invite scheme: `bch-cc-v1:` — validated with `Wallet.parseInviteUrl`
- Identity key: HD purpose **5001** (`derivationPathToCashConnectPath`), not
  the spend path and not chat Nostr. The temporary identity bytes are zeroed
  after `Wallet` construction.
- Sessions: in-memory `MemoryStore` only. The SDK default is localStorage
  (includes session private keys). Encrypted per-wallet persistence is the
  next step (Selene `cashconnect_sessions`).
- Spends: alpha.31 builds and signs before `onExecuteAction`. The wallet
  still shows an approve sheet; Reject withholds the signed tx from the
  dApp. Pairing a template that includes transaction actions is allowed.
- Lifecycle: start on wallet open, stop on wallet close / lock / logout.
  UTXO refresh notifies paired dApps via `notifyBalancesChanged`.
- UI: Settings home + Actions → CashConnect. Home **Scan QR** opens a
  connect popup (paste or scan `bch-cc-v1:` / `wc:` / payment address).
  Session-approve overlays are app-wide on Home.
- Mobile: Android and iOS register the `bch-cc-v1` URL scheme. A tapped
  invite opens the wallet and pairs once a wallet is unlocked. Same Home
  approve overlay as desktop.

Reference: Cashonize `cashconnectStore.ts`, and Selene
[MR 281](https://git.xulu.tech/selene.cash/selene-wallet/-/merge_requests/281).

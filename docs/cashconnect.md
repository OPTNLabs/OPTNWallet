# CashConnect

BCH contract-system connector over Nostr. Separate from WalletConnect and
WizardConnect.

- Package: `@cashconnect-js/nostr` (`Wallet`)
- Invite scheme: `bch-cc-v1:`
- Identity key: HD purpose **5001** (`derivationPathToCashConnectPath`), not
  the spend path and not chat Nostr
- UI: Settings home + Actions → CashConnect. Home **Scan QR** opens a
  connect popup (paste or scan `bch-cc-v1:` / `wc:` / payment address).
  Approve and sign popups are app-wide overlays on Home, like Paytaca.

Reference: Cashonize `cashconnectStore.ts` and
`src/components/cashconnect/`.

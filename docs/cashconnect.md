# CashConnect

BCH contract-system connector over Nostr. Separate from WalletConnect and
WizardConnect.

- Package: `@cashconnect-js/nostr` (`Wallet`)
- Invite scheme: `bch-cc-v1:`
- Identity key: HD purpose **5001** (`derivationPathToCashConnectPath`), not
  the spend path and not chat Nostr
- UI: Settings home + Actions → CashConnect. Approve popups are app-wide
  (Home too), not only on the settings panel.

Reference: Cashonize `cashconnectStore.ts` and
`src/components/cashconnect/`.

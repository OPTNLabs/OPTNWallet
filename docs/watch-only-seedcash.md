# Watch-only wallets and SeedCash

OPTN is the online watch-only wallet, transaction builder, verifier, and
broadcaster. SeedCash (or another air-gapped signer) holds the mnemonic and
signs offline. This is the [Issue #8](https://github.com/OPTNLabs/OPTNWallet/issues/8)
flow. It is **implemented**, not a plan.

## Product flow

1. Create or restore the mnemonic only in SeedCash on the offline device.
2. SeedCash exports the BCH account xPub as a static QR. No mnemonic, xPriv,
   or child private key enters OPTN.
3. OPTN **Create Watch-Only Wallet** scans the xPub, checks network/origin,
   and restores the BIP44 public tree. The default account path is
   `m/44'/145'/account'` on mainnet and `m/44'/1'/account'` on chipnet; both
   receive (`/0/i`) and change (`/1/i`) branches are restored. Existing wallets
   retain their stored derivation path.
4. Gap-limit discovery, receive, balance, history, UTXOs, and coin control
   work with no signing path.
5. Send builds a binary Paytaca-compatible PSBT (global version `145`,
   default sighash `ALL | FORKID` = `0x41`). Advanced sighash choices are
   behind **Advanced**. QR density +/− is desktop-only; mobile fills more of
   the screen with the animated QR.
6. Export is multipart `ur:crypto-psbt` (PSBT bytes, not JSON).
7. SeedCash reviews and signs offline, then returns `ur:crypto-psbt`.
8. Import binds the signed PSBT to the approved unsigned transaction,
   verifies signatures, and only then offers broadcast. SeedCash never
   broadcasts.

Master fingerprint is **optional**. SeedCash signs from the PSBT BIP32 path.
Fingerprint is review metadata (Export Xpub shows 8 hex). A Mac that stored
an xPub before the `master_fingerprint` column existed can still sign.

Password for **reveal wallet information** uses the same Confirm-password
card as Send (`xpub_reveal` scope). Copy must say wallet information, not
backup phrase.

Chipnet receive addresses are `bchtest:`. A mainnet xPub must not send to a
chipnet address (and the reverse).

## Code map

| Concern                                      | Where                                                         |
| -------------------------------------------- | ------------------------------------------------------------- |
| Watch-only type + xPub                       | `watchOnlyWallet.ts`, desktop wallet schema                   |
| Optional fingerprint                         | `master_fingerprint` column; `saveWatchOnlyMasterFingerprint` |
| PSBTv145                                     | `psbtBch.ts`                                                  |
| Multisig (Paytaca `OP_m … OP_CHECKMULTISIG`) | `psbtMultisig.ts`                                             |
| UR export/import                             | `urPsbt.ts`                                                   |
| Send workspace                               | `WatchOnlySend.tsx` via `SendRoute`                           |
| NFT parse (Cashonize-style)                  | `nftParsing.ts`, BCMR fallback                                |

Do not mix wallets. A compromised test-phrase wallet is not the same as a
watch-only xPub that actually holds funds.

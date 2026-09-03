# Feature inventory — nothing here may be dropped in the Rust port

Working list of behaviour the React wallet has (or has planned) that the Rust
UI must carry. Recorded so a port does not quietly ship a smaller wallet.
Tick items only with evidence — a passing test or a screenshot of the real app.

Companion to `README.md` (the layouts) and the tracking issue #71.

## Settings — Network

- [ ] **Reload and resync current wallet**
- [ ] **Change and resync** when switching network
- [ ] **Use network default** (reset a custom endpoint)
- [ ] `testnet3`, `testnet4`, `regtest` listed but **greyed out — "coming soon"**.
      Present-and-disabled, not absent, so the roadmap is visible.

## Watch Only — the air-gap options, in order

Watch Only is one card that produces one kind of wallet from several sources.
Below the single-sig and multisig inputs come the air-gap options, in this
order:

1. **SeedCash** — exports a **bare base58 xPub** and nothing else
   (`wallet_views.py` → `SeedCashQRView(address=self.wallet._xpub)`), so the
   master fingerprint is read off the device by hand and the account path is
   assumed.
2. **Keystone** — below SeedCash. Emits **BC-UR** carrying the key *and* its
   origin, so `CryptoHDKey.getOrigin()` yields the master fingerprint and the
   full derivation path. Nothing is typed and nothing is assumed.

They are separate options precisely because of that difference, not because
of branding. `src/services/psbt/keystoneAccount.ts` says so directly.

- [x] **The master fingerprint is optional** everywhere it appears — SeedCash,
      and watch-only generally, which accepts an account xPub from any wallet.
      `optn_core::watch_only::normalize_master_fingerprint("")` returns
      `Ok(None)`, and `multisig_preview` accepts cosigners without one.
- [ ] SeedCash air-gap option (bare xPub, hand-typed fingerprint)
- [ ] Keystone air-gap option — blocked on a Rust BC-UR decoder

## Settings — Servers: bring your own node and explorer

A section for pointing the wallet at infrastructure the user runs, by address
(IP/host + port), rather than only the bundled defaults.

- [ ] **Custom node** — a **BIP37** peer (bloom-filter SPV), entered by
      IP/host and port
- [ ] **Custom Electrum server** — **Fulcrum**, the same
- [ ] **Custom block explorer** — used for "view this transaction" links
- [ ] Per-network: a chipnet endpoint must not be reachable from mainnet
      settings, and switching network must not silently keep the old host
- [ ] Connection test / status before the endpoint is adopted
- [ ] **Use network default** to fall back (see above)

Today `SettingsRowId::Servers` renders `Network::default_host()` read-only,
and `NodeSection` in `crates/optn-ui/src/settings.rs` says so explicitly:
"This wallet uses the network's default Electrum endpoint. Choosing your own
server is not wired up yet." Replacing that text is the deliverable.

Note the two are different protocols and want different fields and different
failure messages: a BIP37 peer speaks the p2p protocol, Fulcrum speaks
Electrum over TCP/TLS. Modelling them as one "server" string would make the
error messages useless.

## Settings — "Not seeing your coins?"

Account-path discovery, with this exact reassurance:

> A wallet restored from another app may hold its coins on a different account
> path. This checks the standard paths for transaction history. It only reads —
> nothing is moved or changed until you choose.

- [ ] **Find where my coins are…** action
- Foundation already landed: `optn_core::hd::account_choices` /
      `scan_coin_types` enumerate exactly the paths this must scan, and
      `AccountPath` is what a result would select.

## Settings — Wallet info

Name, type and network are **always visible**. Only the xPub and related
identity fields sit behind the **eye lock** (password or biometric).

- [ ] Wallet name, shown as `wallet 8 (internal id: 1)` — display name plus
      internal id
- [ ] **Rename**
- [ ] Type (`Standard`) with **Copy**
- [ ] Network (`chipnet`) with **Copy**
- [ ] **Wallet file path** with Copy, e.g.
      `C:\Users\<user>\AppData\Roaming\com.optilabs.wallet\wallets\wallet5_id1.optn`
- [ ] **Key identity** fields behind the eye lock
- [ ] Biometric unlock
- [x] **App lock** logic — Never default, 15/30/60/120/240 timers, spend
      re-auth + 10 min cache only on Never, CashFusion/auto-fusion/chat
      exempt (`optn_app::lock`). Ciphertext at rest. Timer modes do not
      re-prompt because idle lock already covers walking away.
- [ ] **Wallet pack export**

## Desktop shell

- [ ] Native **top menu bar** (File/Edit/… as a normal desktop window), desktop
      only — not a web-style header

## Portfolio / RPA

- [ ] **RPA CashCode** splits into **stealth** and **BCH** balances
- [ ] Portfolio shows the **total** across both
- [ ] Stealth labelling carried through the UI

## CashFusion

- [ ] Fusion state labels — a fused coin reads **"fused"**
- [ ] Stealth/fusion labelling consistent with portfolio

## Coin control

- [ ] Freeze / reserve / label / spend a specific coin (partly present under
      Assets; the full control surface is not)

## Connectors

- [ ] **WalletConnect**
- [ ] **CashConnect**
- [ ] **WizardConnect**
- [ ] **Signing popup** — a request surfaces a modal to review and approve

## Chat

- [ ] Chat section (`/chat`, `/chat/:conversationId` in the React routes)

## Experimental features

- [ ] An **Experimental** section gating in-progress features

## Add-ons

- [ ] Add-on registry, intended to become an **app store** in the style of
      Start9 OS
- [ ] **Sideloading** an add-on by several routes

## Already ported (with evidence)

- [x] BIP44 account selection at onboarding — `optn_core::hd::AccountPath`,
      offered set generated from the discovery scan set
- [x] Multisig cosigners, m-of-n, BIP-67 key ordering —
      `optn_core::multisig`, order-independence asserted
- [x] Hardware vendors incl. **Keystone**, reachability per transport —
      `optn_platform::{HardwareVendor, TransportSupport}`
- [x] Watch-only account validation and preview — `optn_core::watch_only`
- [x] Theme modes and skins selectable in Settings
- [x] Bottom nav: five destinations, extension popup variant

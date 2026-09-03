# What the merged PRs settled, and whether this branch still holds it

PR #63 rewrites the wallet's UI layer in Rust. A rewrite is the easiest place in
a project to lose a fix, because every invariant that was learned from a bug
lives in code that is being replaced, and nothing fails when it goes missing —
the symptom returns later, in production, looking new.

So this is a pass over the merged history, PR by PR, asking one question of each:
**the thing that PR established — is it still true here?**

## Method

Every merged pull request was listed and the body of each one carrying wallet
logic, security behaviour or a CI guard was read in full. Dependency bumps
(#64, #52, #51, #41, #40, #44, #45) and branch promotions (#43, #42, #39, #38,
#37, #36, #23, #22, #11, #10, #2, #1) carry none and were not read past their
titles. Closed-but-substantive PRs (#12, #15, #18, #24) were read too: their
findings were merged through their replacements, and #15's scan bounds in
particular exist nowhere else.

Where a claim below says something is upheld, it was checked by reading the code
or running the test, not by assuming the port was faithful. Where something was
missing, it was fixed in this pass and the fix is named.

---

## Fixed in this pass

Five gaps, each traceable to a specific merged PR.

### A locked wallet still reported a balance — PR #6

PR #6 replaced an app-wide gate with per-wallet keys and made one invariant the
whole model rests on: *"No wallet is 'open' unless its key is cached — enforced
as an invariant so a stale persisted wallet id can never silently drive UI or
background work without its key."*

A balance is what makes a closed wallet look open. `lock_wallet` cleared the
coins, the spend plan and the pledges, but not the RPA stealth pool — which is
exactly the half of the portfolio total that is deliberately *not* a UTXO. A
locked wallet kept showing a total. It also kept the account xPub last exported
from a hardware device, so one wallet's identity would follow the user into the
next one.

Fixed in `crates/optn-app/src/lib.rs`. Mutation-verified: with the line removed
the test fails on the 50,000 stealth sats that survive the lock.

### The extension viewer only *looked* unable to spend — PR #12

PR #12 made the browser build an explicit read-only viewer: *"spending/signing
routes and lifecycle services are not mounted, and transaction submission fails
closed"*, because a secure key lifecycle for a popup had not been designed.

What this branch had was a popup navigation with no Actions tab. That is
presentation, and this branch contains a whole third renderer whose purpose is
to demonstrate that a screen holds no wallet decision — so a renderer cannot be
trusted with the boundary. `PrepareSend` and `AuthorizeSpend` now refuse on a
viewer-only surface. The signing half is gated too: a viewer that can authorise
a spend is a viewer that spends as soon as anything downstream forgets to check.

Mutation-verified, with a destination the wallet itself produced so a refusal
cannot be mistaken for "that address is malformed".

### macOS could not paste — PR #50

PR #50 (closing #47) found that copy and paste were dead in the WalletConnect,
WizardConnect and CashConnect URI fields, because the hand-built menu that
replaced Tauri's default omitted the Edit submenu. AppKit routes Cmd+X/C/V/A
into the WebView only when the app menu carries those items; Cmd+M and Cmd+W
reach the window the same way through Window.

The ported menu model had File, Wallet, View, Tools and Help — the sections this
application owns — and neither of the OS's. Both are now sections of the model,
macOS-only for the reason the shipped implementation gives (WebView2 and
WebKitGTK handle those chords themselves, and the GTK backend has no Undo or
Redo at all), carrying `NativeRole`s rather than `MenuCommand`s. A section with
roles carries no commands, because an application item that merely *claims* the
chord is the bug rather than the fix.

`NATIVE_EDIT_KEYS` is a guard, not a note: a test refuses any accelerator this
application defines that uses one, so adding Cmd+A for "select all wallets"
later cannot silently kill pasting again.

### An ordinary send could spend a fusing coin — PR #12

PR #12's server-fusion safety boundary *"prevents ordinary sends from reusing
in-flight Fusion inputs"*. The freeze policy here already said a reserved coin is
unavailable to send, Fusion selection and new pledges — but the reasons were
`User`, `FlipstarterPledge` and `Authhead`, with no way to say a coin was
committed to a running round. Spending one would double-spend the round's own
inputs: the fusion dies and the attempt appears on chain as a conflict.

`FreezeReason::FusionInFlight` is its own reason, following the rule the module
already stated — a hold with a lifecycle behind it must stay distinguishable, so
releasing one never releases another. `is_user_reversible` makes that explicit:
only a user freeze is the user's to lift.

### Discovery had the decision but not the bounds — PR #15

PR #15 stated the scan rule as: *"Stop after a valid 20-address unused gap, and
fail closed if the 200-address safety cap is reached first."*

`discovery.rs` had the decision — coins beat history, a complete scan is required
before adopting, a failed probe is absent rather than zero — but not the bounds.
Both halves are policy rather than I/O, so `GapScan` now owns them next to the
decision they feed. Hitting the cap yields **no probe at all** rather than a
partial count, which is what keeps a scan limit from masquerading as a confirmed
answer.

---

## Upheld, checked rather than assumed

### RPA — PR #61, PR #29, PR #6

| What #61 settled | Where it is now |
|---|---|
| Emit `cashcode:` / `cashcodetest:` | `rpa::encode`, asserted by `emits_cashcode_and_never_paycode` |
| Still accept `paycode:` / `paycodetest:`, flagged `legacy` | `rpa::decode`, `Cashcode::legacy` |
| Hash the **compressed** CKD_pub child | `rpa::payment_address`, with the Electron Cash bug named in the module docs |
| Refuse offline-only codes (versions 2 and 6) | `rpa::send_block_reason` |
| Refuse `prefix_size` 0 | `rpa::send_block_reason` |
| Refuse multisig versions (3/4/7/8) | Rejected at `decode`, earlier than the TypeScript rejects them |
| Detect needs `scanPrivkey` + `spendPubkey` only (REQ-5) | `scan_transaction(raw, scan_privkey, spend_pubkey, network)` — the type system enforces what TypeScript had to assert at runtime |
| Scan `…/3/0`, spend `…/3/1` (PR #6) | `rpa::scan_path` / `rpa::spend_path` |
| Wire-vs-display outpoint order | `parse_transaction` reverses and says why, pointing at `RpaDetect.ts`, which does not |

`RpaKeys` has no `Debug` implementation because it holds private keys — the same
discipline the newly added `PaperWalletKey` follows.

### Chipnet coin type — PR #9

`Network::default_coin_type()` returns 145 on mainnet and 1 on chipnet. A wallet
that hardcoded mainnet would derive the wrong addresses on chipnet, which is one
of the bugs #9 fixed.

### Cross-network sends — PR #18, PR #24

*"Chipnet → mainnet destination still blocked"*, and #24's *"Mainnet paycode is
rejected on a Chipnet wallet and the reverse"*. Both hold: `rpa::decode`
cross-checks the prefix against the version byte, and the new
`scan::classify_scanned_payload` refuses the other chain's address — as
`WrongNetwork`, carrying the message the send screen already used, rather than
as "not a supported address".

### The xPub eye lock — PR #18

*"Wallet info xPub unlock uses the same Confirm-password card as Send"* — not a
browser prompt. `AuthScope::Reveal` goes through the same authorisation path as
`AuthScope::Spend`, and a reveal never outlives the unlocked session.

### Wallet-scoped menu items — PR #6

*"Menu items grey out correctly when no wallet is open."* `MenuCommand::requires_wallet`
plus `menu_bar`, asserted for every command in both states.

---

## Ported in this pass

### The air-gap signing rules — PR #34, PR #60

These had no home in the Rust core at all. `crates/optn-core/src/psbt.rs` now
carries them:

- **Every input must declare `PSBT_IN_SIGHASH_TYPE = 0xc1`.** An absent field is
  refused exactly as firmly as a wrong one, because SeedCash falls back to
  `0x41` when it is missing and a signature over the wrong sighash is only
  rejected at broadcast — long after the device has been put away.
- **Mainnet is refused by the encoder, not by convention.**
- **The UR carries a raw PSBT**, because stock SeedCash calls `parse_psbt` on the
  CBOR field directly and never unwraps a byte string; a BCR-2020-006 wrapper
  reaches it as `59019070736274ff…` and raises `invalid PSBT magic`. A wrapped
  return is still accepted, since Keystone is not wrong, only different.
- **The master fingerprint stays optional.** SeedCash reads only the BIP32 path
  from key `0x06` and discards the fingerprint, so a wallet without one stamps
  zeros and keeps its path.
- The QR density from #60 — 50 / 8 / 640 / ECC L — is pinned here, because the
  failure it fixed is a camera that will not scan, with nothing on this side to
  notice.

### What a scanned payload is — PR #28, PR #29

`classifyScannedQrPayload` and `parseBip21Uri` are now
`crates/optn-core/src/scan.rs`, keeping the three things that were load-bearing:
the order of the checks (a CashConnect invite ends in a base58 blob after a
colon, which is exactly the paper-wallet rule), the wrong-chain refusal, and a
BIP21 amount that stays the text it arrived as rather than a round trip through
`f64`.

Two things there are new rather than ported. A scanned WIF is the only value in
the crate that is both secret and attacker-supplied, so `PaperWalletKey` has a
redacting `Debug` — a derived one would put a spendable key into every log line
and panic message that formats a `ScannedPayload` — no `Display`, and zeroize on
drop. And it reports the chain its version byte names, so a mainnet key swept by
a chipnet wallet can be explained instead of looking like an empty paper wallet.

---

## CI guarding

PR #53's thesis is the standard this section is held to: *"Four checks were
reporting success without checking anything, and one release shipped the wrong
binaries because of it."*

### The dependency audit covered one crate out of five

`cargo audit` runs in `src-tauri` alone. The desktop shell is checked; the
workspace, the CLI and the protocol core — the crates the wallet's logic
actually lives in — are not. That is the same shape of hole #53 was written to
close.

`cargo run -p xtask -- audit` now covers all five lock files. It **discovers**
them rather than listing them, so a new crate is covered the day it appears
instead of the day someone remembers, and a missing `cargo-audit` fails rather
than skips.

### The four baselined advisories are stale

#53 baselined four advisories and said to drop each one as its fix lands. They
have landed, which was checked rather than assumed:

| Advisory | Crate | State now |
|---|---|---|
| RUSTSEC-2026-0194 / 0195 | quick-xml <0.41 | every lock file resolves **0.41.0** |
| RUSTSEC-2026-0185 | quinn-proto 0.11.14 | now **0.11.17** everywhere |
| RUSTSEC-2026-0235 | rkyv 0.7.46 | **rkyv appears in no lock file at all** |

`cargo audit` with no ignores exits clean across all five. `xtask audit`
therefore carries an empty baseline. Until
`.github/workflows/security-analysis.yml` drops its four `--ignore` flags, those
advisories are muted there for no remaining reason — and a mute that outlives its
reason silently accepts the vulnerability's return.

### Two renderers are not in CI's package lists

`optn-ui-text` and `optn-ui-egui` exist to prove the renderer seam is a seam.
Neither is in the workflow's explicit `-p` lists, so their tests do not gate
anything. `optn-ui-egui` needs its own step, since `-p` cannot reach a crate
excluded from the workspace:

```
cargo test --manifest-path crates/optn-ui-egui/Cargo.toml
```

### `optn-ui` fails host clippy

`mounted_page` and `derivation_for_network` are used only under `wasm32` while
`mod onboarding` is not gated, so a host non-test build sees them as dead. CI's
clippy scope excludes `optn-ui`, so it is not red today — but it will be the
moment that scope widens.

**None of the four are changed here**, because `.github/workflows/` is on the
prohibited path list. They are recorded in `GROK-HANDOFF.md` for whoever owns
the workflows.

---

## The renderer swap, as a measured claim

"Swappable" is a claim with a number in it. `optn_transport::run::<_, Ui<_>>`
is a host that never names a renderer; `TextRenderer` and `EguiRenderer` both
implement `optn_transport::Renderer`; and each crate carries the same 46-line
host block — same script, same assertions — differing only in

```rust
type Ui<T> = TextRenderer<T>;   // or EguiRenderer<T>
```

`xtask architecture` extracts both blocks and fails if they differ on more than
that one line, or if the line that differs is not the alias. Checked by drifting
an assertion in one crate and watching the guard name it. A Dioxus renderer
joins by implementing the same three methods — `attach`, `dispatch`, `painted` —
and nothing in the host changes.

## Hardware fields

The device fields are complete against `hardwareWalletSlice.ts`: `type`
(including Keystone), `connected`, `xpub`, `deviceLabel`, `ledgerTransport`,
and `derivationPath`. The last was the one genuinely missing, and it arrived
without the sentinel: React encoded "not chosen" as the mainnet literal
`m/44'/145'/0'`, which every reader had to compare against exactly.
`Option<AccountPath>` says it with nothing to compare, `effective_path` resolves
the fallback once, and an account this network never scans is reported rather
than corrected. All three renderers show it.

## Still open

Honest list; none of these are claimed as done.

| From | What is missing | Why |
|---|---|---|
| #26, #18, #12 | CashFusion's Nostr layer — NIP-17/NIP-44 gift wraps, kind `12230` announcements, rendezvous, blame | Needs a Nostr crate; a dependency decision |
| #12 | Tor-only enforcement for remote fusion, and the covert-socket schedule | Transport-layer, not yet ported |
| #6 | Wallet pack export (PBKDF2 600k + AES-256-GCM) | Needs `aes-gcm` + `pbkdf2` and an entropy source; `optn-core` has no RNG on purpose |
| #6 | Addon sandbox — the `iframe sandbox="allow-scripts"` boundary with no `allow-same-origin` | The registry work is not started; this boundary is the thing it must not lose |
| #61 | Live chipnet round-trip of the Rust RPA path | No live-network tests from here |
| #34 #60 | UR frame generation from the encoded PSBT | The bytes are produced and verified; the fountain-code framing is not |

The parity matrix (`xtask parity`) remains the running count of what is and is
not ported; this document covers only what the merged PRs *settled*, which is a
different and smaller list.

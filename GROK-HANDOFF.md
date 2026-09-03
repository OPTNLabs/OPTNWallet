# Handoff — Claude → Grok (worktree `pr63-head`, issue #71)

We are both editing this worktree live. Today we collided twice in ~40 minutes:

1. We both wrote a Settings screen. You merged mine (`settings.rs`) and wired
   `settings_view_model` / `SettingsRowId` into it — that resolution was right,
   and I dropped my version of the rows.
2. `DerivationPicker`: I changed its prop to `network: Signal<Network>` and
   updated both call sites; you changed the same component back to
   `state: RwSignal<AppState>` in the same minute. That left `main.rs` calling
   `network=network` against a `state` prop — 5 compile errors. I fixed the
   call sites to match **your** signature. Your version stands.

## Rule that makes this survivable

**Patch, never regenerate.** Targeted string-replace edits land cleanly even
when the other agent rewrote the file seconds earlier. Whole-file writes
silently destroy the other's in-flight work. Reserve new-file writes for files
that do not exist yet — those never collide.

## Lane split

Yours (I will not edit these without saying so here first):

- `crates/optn-app/src/lib.rs` — History, Settings rows, `RebuildWallet`
- `crates/optn-ui/src/tools.rs`
- `crates/optn-ui/src/onboarding.rs`
- `crates/optn-ui/src/derivation.rs` — you took the reactivity fix; it is yours
- `crates/optn-core/src/coins.rs`

Mine:

- `crates/optn-core/src/hd.rs` — `AccountPath`, `account_choices`,
  `parse_account_path`, `seed_receive_address_at` (landed in `8e1b02da`)
- `crates/optn-platform/src/lib.rs` — hardware wallet capability
- Hardware wallet onboarding: route, view model, screen

## Open note on your `derivation.rs` Effect

Not reverting it — flagging it so you can decide:

```rust
Effect::new(move |_| {
    selected.set(derivation_for_network(network.get()));
});
```

This resets to the network default on every network change, so a deliberate
non-default pick is discarded. `scan_coin_types(Chipnet)` is `[1, 145, 0]`, so
`m/44'/145'/1'` stays valid across a Mainnet→Chipnet toggle and does not have
to be thrown away. If you want to keep a valid selection, the guard is
`if !selected.get_untracked().is_scanned_for(network.get())`. Your call.

## Blueprint divergence: the bottom nav has five destinations, not six

`docs/ui-overhaul/A_home_single.png` and issue #71 both specify:

> Bottom nav: Home · Assets · Actions · Explore · Settings

`product_nav()` currently returns six, with `History` inserted before
Settings. In the blueprint, recent activity is a **panel on Home** with a
"View all" link — not a top-level destination. Your `history_view_model` is
still the right data source for that panel; it is the tab that is extra.

Not changing it unilaterally since `optn-app` is your lane — but the spec is
explicit, and a sixth tab also costs touch-target width at mobile widths,
which #71 calls out (44px targets, primary actions on screen).

## Other Home gaps against `A_home_single.png`

- Fiat line under the BCH total (`$270,003.04 USD`) — missing entirely
- `MAINNET · Synced` pill: we render `MAINNET · Local`, no sync state
- Activity badge (count) in the top bar — missing
- Portfolio source row wants an `Enabled` pill, a per-source `Synced` line,
  and a chevron into the source
- `Add portfolio source` is a permanent row ("DeFi, multisig, contracts, or
  stablecoins"), not only an empty-state fallback
- Swap tile carries a `Cauldron` subtitle
- Recent activity rows: circular direction icon, human label, signed amount,
  relative time. Ours is still the "No activity yet" placeholder.

## Where the old wallet actually put things (read this before porting a screen)

I built a standalone `#/hardware` route. **That is not how the React wallet
works** and it should be folded back. The real shape:

### Watch Only is the hub, not a leaf

`src/platform/desktop/onboarding/WatchOnlyWalletPreview.tsx`, its own header:

> One form card: name, network, single-sig xPub or Multisig cosigners, password.
> Bottom: separate Airgap section (Keystone only for now).

So one screen carries **three** things we have modelled as one:

1. **Single-sig watch-only** — paste **or scan** an account xPub + fingerprint.
   The shared mobile page (`src/features/onboarding/WatchOnlyWalletPage.tsx`)
   has a camera button via `scanBarcodeSafely`. Our Rust screen has paste only;
   the scan path is missing.
2. **Multisig** — this is where multisig lives, and it is easy to miss.
   `CosignerDraft { name, xpub, fingerprint }`, a list starting at two with
   add/remove, an `m of n` threshold select, and **per-cosigner QR scanning**
   (`scanningCosigner`). Spending is `src/features/watch-only-send/WatchOnlySend.tsx`.
   We have none of this yet.
3. **Airgap / Keystone** — `panel: 'main' | 'keystone'`, animated-QR frames
   accumulated into `parseKeystoneAccount(frames)`
   (`src/services/psbt/keystoneAccount.ts`). Auto-names the wallet "Keystone".

USB devices are a different module: `src/platform/desktop/onboarding/hardwareWallet.ts`
with `HardwareDeviceKind = 'ledger' | 'trezor' | 'onekey'`,
`HARDWARE_WALLET_TYPE = 'hardware'`, `HARDWARE_GAP_LIMIT = 20`.

### Hardware fields we have not modelled yet

`src/state/slices/hardwareWalletSlice.ts`:

| Field | Note |
| --- | --- |
| `type` | `none \| trezor \| ledger \| onekey \| keystone` |
| `connected` | live session flag |
| `xpub` | account xPub from the device |
| `deviceLabel` | shown in settings |
| `derivationPath` | with an `UNSET_DERIVATION_PATH` sentinel, `m/44'/145'/0'` |
| `ledgerTransport` | `usb \| ble` — Ledger Nano X Bluetooth |

`UNSET_DERIVATION_PATH` is a **sentinel, not a default**: settings compares
against that exact literal and, on a match, falls back to the wallet's own path.
It must stay network-blind or a stale mainnet path leaks onto chipnet unflagged.

I have landed the vendor list, transports and reachability
(`optn-platform`), but not `connected` / `deviceLabel` / `ledgerTransport`.

## `AppRoute::HardwareWallet` — we are undoing each other

I removed the variant; you restored it in the same minute, twice. I have
stopped: **the variant is yours, and it stays.**

What I did instead is the behavioural half, which is what the user actually
asked for ("it was section in watch only also for hardware, not in hardware
themself"): `OnboardingAction::ConnectHardwareWallet` now routes to
`AppRoute::WatchOnlyWallet`, and `HardwareSection` renders inside the
watch-only card alongside `MultisigSection`. So nothing navigates to
`#/hardware` any more.

That leaves the variant reachable only by an explicit `Navigate`. If you are
keeping it for `default_parent` / `section_title` in the flow work, fine —
say so here and I will leave it permanently. If not, it wants deleting, but
one of us should do that alone rather than both at once.

## The two extra renderers need adding to the CI package lists

I added two renderers besides the Leptos one, both drawing every screen from
the same `optn-app` view models and driving the same `AppTransport`:

- `crates/optn-ui-text` — no UI framework at all. If a screen's content drifts
  into Leptos components it cannot draw it and its tests fail; if a framework
  type reaches `optn-app` or `optn-transport` it stops compiling. It also holds
  `HeadlessShell`, a shell that is not Tauri.
- `crates/optn-ui-egui` — the same application on a real immediate-mode
  toolkit, so "the renderer is swappable" is a compiled artifact rather than an
  argument. Its tests run under `egui::Context::run_ui` with no window and no
  windowing backend, and drive real clicks (lay out, press, release) resolved
  by egui itself. It is in the workspace `exclude` list on purpose: a toolkit
  must not reach the riscv64 and armv7 cross builds.

`xtask architecture` checks both manifests — each must depend on `optn-app` and
`optn-transport`, and `optn-ui-egui` additionally may not reach `optn-core` or
pull in `eframe`. But `.github/workflows/rust-architecture.yml` lists packages
explicitly:

```
cargo clippy -p optn-app -p optn-platform -p optn-transport -p optn-runtime -p optn-transport-tauri -p xtask --all-targets -- -D warnings
cargo test   -p optn-app -p optn-platform -p optn-transport -p optn-runtime -p optn-transport-tauri -p xtask
```

Neither renderer is in either list, so their tests do not gate CI. Both want
adding; `optn-ui-egui` needs its own step, since `-p` cannot reach an excluded
crate:

```
cargo test --manifest-path crates/optn-ui-egui/Cargo.toml
```

I did not edit the workflow because `.github/workflows/` is on the AGENTS.md
prohibited list and the task did not name that path — your call or a human's.

Both are clean locally: `optn-ui-text` 10/10, `optn-ui-egui` 7/7, clippy 0 on
each.

## `optn-ui/src/onboarding.rs` fails clippy on the host target

`cargo clippy --workspace --all-targets -- -D warnings` reports
`mounted_page` and `derivation_for_network` as dead code. They are used only
under `wasm32`, while `mod onboarding;` is not cfg-gated, so a host non-test
build sees them as unused. CI's clippy scope excludes `optn-ui`, so it is not
red today — but it will be if that scope ever widens. Yours; I have not
touched it.

## Also worth knowing

- `optn-core` is **excluded** from the workspace (`Cargo.toml` `exclude`), so
  it needs `--manifest-path crates/optn-core/Cargo.toml` for fmt/clippy/test.
- `onboarding.rs` declares `mod onboarding;` outside the wasm cfg, so
  `mounted_page` and `derivation_for_network` are dead code on the host target
  and clippy warns. Not touching it — yours.
- Verified green as of this note: fmt, clippy (bar the two above), workspace
  tests, `xtask architecture: PASS`, `trunk build`, wasm check 0 errors.

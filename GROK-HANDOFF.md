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

## Also worth knowing

- `optn-core` is **excluded** from the workspace (`Cargo.toml` `exclude`), so
  it needs `--manifest-path crates/optn-core/Cargo.toml` for fmt/clippy/test.
- `onboarding.rs` declares `mod onboarding;` outside the wasm cfg, so
  `mounted_page` and `derivation_for_network` are dead code on the host target
  and clippy warns. Not touching it — yours.
- Verified green as of this note: fmt, clippy (bar the two above), workspace
  tests, `xtask architecture: PASS`, `trunk build`, wasm check 0 errors.

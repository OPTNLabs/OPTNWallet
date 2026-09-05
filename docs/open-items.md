# Open items

What is left on this branch, ordered so the cheapest useful work comes first.

Written for whoever picks this up next, human or agent, assuming no memory of
the session that produced it. Every claim here was verified by reading or
running something, and each item says how to check it yourself — if an item
disagrees with the code, the code is right and this file is stale.

Two documents sit next to this one and are worth reading first:

- **[`architecture-guards.md`](architecture-guards.md)** — what `xtask` enforces
  and why editing a guard is almost never the fix. Several items below are
  guards that need *tightening*; none want loosening.
- **[`multisig-interop.md`](multisig-interop.md)** — what the multisig work was
  checked against, and what it explicitly does not prove.

---

## Read this before you run anything

**`--workspace` covers 9 of the 14 crates.** The root `Cargo.toml` excludes
`crates/optn-core`, `crates/optn-cli`, `crates/optn-ui-egui` and `src-tauri`;
`fuzz` declares its own workspace. A green `cargo test --workspace` has not
compiled five crates, and a rule updated everywhere the workspace reaches can
sit stale in one of them for days. That has happened twice on this branch.

```sh
for d in crates/optn-core crates/optn-cli crates/optn-ui-egui src-tauri fuzz; do
  (cd "$d" && cargo check --all-targets && cargo test && cargo fmt --all -- --check) \
    || echo "FAILED: $d"
done
cargo check -p optn-ui --target wasm32-unknown-unknown   # components are wasm-gated
```

There are **six** lock files and `optn-core` is a path dependency of three of
them, so one dependency added to it invalidates four. `cargo run -p xtask --
audit` walks all six; CI's lockfile job checks three.

---

## Small wins

Ordered by cost. All are self-contained and none needs a product decision.

### 1. ~~The parity matrix claimed `unit` evidence 92 times without pointing anywhere~~ — **done**

**Where:** `rustification/parity-matrix.toml`, `xtask/src/parity.rs`.

`xtask parity` validated `evidence_refs` for `e2e`, `device` and `e2e-declared`
only. `unit` was never checked, so 92 cells asserted coverage that nothing
confirmed — and one of them was false: **`spv` has no implementation in any of
the fourteen crates** (nothing matches `spv`, `merkle` or `block_header`) and no
test in the TypeScript app either, yet claimed `unit` on three platforms.

Closed in the order that keeps the build green throughout:

1. **83 `evidence_refs` added**, each verified to resolve — 107 refs now checked,
   0 broken. Existing `e2e` refs were merged with, not overwritten.
2. **Three rows corrected.** `spv` → `none` everywhere with the reason in a
   comment. `electrum` → `unit` on all seven, since its tests are
   surface-independent and the four `none` cells understated coverage.
   `x402` → `na` with reasons on the four non-desktop surfaces, because it lives
   entirely in `crates/optn-cli` and no app surface ships the CLI.
3. **`EVIDENCE_NEEDING_REFS` now includes `unit`**, and
   `a_unit_claim_must_name_a_test_that_exists` proves the guard fires on all
   three failure modes: no ref, a missing path, and a stale token.

`pass` with no evidence went 12 → 7 (all `spv`, honestly recorded); `unit`
without a ref went 92 → 0.

The remaining 7 close when SPV gets a test — which is the honest next step for
that feature, since it currently has none anywhere.

### 2. `hardware_integration_ready` has no mobile arms, so a switched-on phone sees one device

**Status:** open, and correct as it stands. **Where:** `crates/optn-app/src/lib.rs`.

Hardware on a phone is now a default rather than a veto — switching it on
reveals what that surface can drive. Today that is Keystone alone, because
`hardware_integration_ready` lists no mobile arms for Ledger, Trezor, OneKey or
Tangem. That is honest: their mobile integrations do not exist, and a test
asserts they stay absent.

The item is to add each arm **as its integration lands**, not before. Adding an
arm without the plugin behind it puts a device on screen that cannot connect.

### 3. Tangem is offered by the platform crate and reachable on no surface

**Status:** open. **Where:** `crates/optn-platform/src/lib.rs`.

`HardwareVendor::Tangem` is in `OFFERED` and its transport is `Nfc`, so it is
reachable only on Android and iOS — the two surfaces where hardware defaults
off. It is also absent from `hardware_integration_ready`, so it is blocked
twice. A card that appears nowhere is fine while its SDK work is unstarted, but
it should be a stated decision rather than an accident of two filters agreeing.

Both of Tangem's JavaScript bridges are archived; the supported route is their
Swift and Kotlin SDKs, so this needs native code before it can move.

### 4. Two CI path filters do not fire on the code they guard

**Status:** open, **blocked** — needs `.github/workflows/`, which is off-limits
in the agent lane. Found by CodeRabbit on PR #63.

- `rust-quality.yml` line 14 lists only `src-tauri/Cargo.toml`. A pull request
  that changes only `src-tauri/**/*.rs` runs no nextest, dependency policy,
  feature or coverage job. **This is the exact hole that let a `src-tauri`
  syntax error reach CI.** Add `src-tauri/**`.
- `rust-formal.yml` excludes the workspace `Cargo.toml` and `Cargo.lock` from
  both `pull_request.paths` and `push.paths`, so a dependency change reaching
  `optn-core` can skip the Kani proofs. Add both files to both filters.

Each is one line.

### 5. Regenerating the fusion component vectors races its own readers

**Status:** open, **blocked** — `src-tauri/src/fusion/` is Codex's; coordinate
first. Found by CodeRabbit.

`component_vectors.rs` writes `PATH` with `std::fs::write` while four sibling
tests read the same file through `stored()` on other threads. With
`WRITE_FUSION_COMPONENT_VECTORS` set, a reader can observe a truncated file and
panic. The documented regeneration command is therefore intermittently red.

The fix is to serve the freshly built value to readers during regeneration
rather than making them race the file.

---

## Needs a decision, not a keyboard

### 6. Cosigner cap: 15 or 16

`optn_core::multisig::MAX_COSIGNERS` is **16**, which is what `OP_16` encodes.
`optn-multisig-core` caps at **15**, which is Electron Cash's limit —
`address.py` (`if not 1 <= m <= n <= 15`) and `transaction.py` (`assert n <= 15`).
A test in `crates/optn-cli/tests/` pins the disagreement so it cannot drift
quietly.

A 16-key wallet built here is valid on chain and **cannot be opened in Electron
Cash**. That is a product call: match EC and lose a script-legal configuration,
or keep 16 and document the trap. Paytaca has been asked what they do, in
[paytaca/paytaca-app#769](https://github.com/paytaca/paytaca-app/issues/769).

### 7. Ledger's Bitcoin Cash path

`@ledgerhq/hw-app-btc` is deprecated as of September 2026 per Ledger's own
portal. Its replacement, `device-signer-kit-bitcoin`, has **no BCH support** —
verified by unpacking the package: no `cashaddr`, no `forkid`, no
`additionals`, and its builder takes no currency option. Twelve signer kits
exist and none is BCH.

So the route is DMK's transport plus an app-binder we own, which is what
`ledgerBchApdu.ts` starts. Worth confirming that is the intended direction
before more is built on it.

### 8. The cut-over: two frontends still ship

The largest open item, and a decision rather than missing code.

`src-tauri/tauri.conf.json` — the default, used by `npx tauri build` with no
`--config` — serves `../dist`, the Vite/React build. **1066 `.ts`/`.tsx` files.**
The Rust stack builds and tests on every target, but only under
`--config src-tauri/tauri.leptos.conf.json` or `tauri.leptos.mobile.conf.json`.

The architecture is finished; nothing has been switched over. Until it is, every
product rule lives in two places and can diverge — which is exactly what
happened to the hardware surface matrix, twice.

---

## Needs a physical device

Nothing here is a code review problem.

- **Trezor and OneKey desktop `SignTx`** — both throw; the multi-round flow is
  unwritten. Seven unwired signing paths across `src/services/hardware/`.
- **Ledger signing** — connection and account export are on the Device
  Management Kit; the multi-round transaction APDUs are not. `ledgerBchApdu.ts`
  is pure, fully-tested byte functions with no device behind them.
- **Trezor in the browser** — `@trezor/connect-web` was removed (five
  high-severity advisories, pulled the whole Stellar SDK). `@trezor/transport`
  is named in a comment as the replacement but **is not installed**. Browser
  paths call `browserNotWired()`, which throws with the specific missing piece.

**Keystone is complete**, and it is the device that needs no vendor library, no
cable and no driver — only a camera. It is why the air-gap path is the one worth
handing to testers today.

---

## Interop still unproven

- **Nothing has been exchanged with a running Paytaca.** Everything is checked
  against their source, against BIP-129 and against the BIP's own vectors —
  never against a file one of their apps produced.
  [paytaca/paytaca-app#769](https://github.com/paytaca/paytaca-app/issues/769)
  is the attempt to close this.
- **No hardware vendor test vectors exist, from any vendor.** The Ledger APDU
  tests check our own encoders against replies *we construct*. Contrast the
  crypto — NIP-44, BIP-129, PBKDF2 and descriptors all run published external
  vectors. Every real bug on this branch came from checking against something
  outside the repo; hardware has nothing outside the repo to check against yet.

---

## Renderer swap: what is proven

| Seam | Proven by |
| --- | --- |
| Renderer | `optn-ui-text` ↔ `optn-ui-egui`, host blocks identical but for `type Ui<T>`; `xtask` fails the build if they drift |
| Shell / transport | `a_shell_that_is_not_tauri_hosts_the_whole_application` |
| Platform provider | `optn-platform` → `native` / `apple`, guarded by the Apple source scan |

Two gaps, both honest rather than hidden:

- **No Dioxus renderer exists** — zero hits in any `Cargo.toml`. What is proven
  is text ↔ egui, and that a fourth renderer costs two dependencies and one
  `type` alias. `optn-ui-text` is 640 lines and is the template.
- **Leptos is not in the swap test.** `optn-ui` is `#[cfg(target_arch =
  "wasm32")]`, so it cannot compile into a native host-block comparison. It is
  verified separately by its wasm build.

`optn-ui-egui` links **real** `egui 0.36` — deliberately without `eframe`, so
there is no winit or GPU stack and the whole renderer runs headlessly under
`Context::run_ui`. It is not a mock.

---

## Measuring the matrix

```sh
python - <<'EOF'
import re, io
raw = io.open('rustification/parity-matrix.toml', encoding='utf-8').read()
plats = ['windows','linux','macos','android','ios','web','extension']
no_evidence, unit_no_ref = [], []
for b in raw.split('[[feature]]')[1:]:
    fid = re.search(r'id = "([^"]+)"', b).group(1)
    pol = dict(re.findall(r'(\w+) = "([a-z0-9-]+)"',
               re.search(r'policy = \{([^}]*)\}', b).group(1)))
    evm = re.search(r'evidence = \{([^}]*)\}', b)
    ev = dict(re.findall(r'(\w+) = "([a-z0-9-]+)"', evm.group(1))) if evm else {}
    refs = re.search(r'evidence_refs = \{([^}]*)\}', b)
    rk = set(re.findall(r'(\w+) =', refs.group(1))) if refs else set()
    for p in plats:
        if pol.get(p) == 'pass' and ev.get(p) in ('none', None):
            no_evidence.append((fid, p))
        if ev.get(p) == 'unit' and p not in rk:
            unit_no_ref.append((fid, p))
print('pass with no evidence :', len(no_evidence))
print('unit with no ref      :', len(unit_no_ref))
EOF
```

`cargo run -p xtask -- parity` prints mostly `fail` because that view counts
only `e2e` and `device` evidence. **That is the production-ready grading, not a
feature inventory** — `unit` reading as `fail` means "not proven end to end",
not "missing". `parity matrix integrity: PASS` on the same run is the check that
actually gates.

---

## Conventions that are not obvious

- **Push to `fork`, not `origin`**, with an explicit refspec:
  `git push fork HEAD:agent/rpa-shared-vectors`. The local branch is named
  `pr63-head`, which is *not* the PR's head ref — pushing the bare name silently
  creates a junk branch.
- **Merge, never rebase.** The branch is shared and a rebase needs a force-push
  that would discard someone else's work.
- **Patch, never regenerate.** Other agents edit this worktree live.
  `src-tauri/src/fusion/` and `nostr/` are Codex's; coordinate before touching.
- **`yarn.lock` churns whenever npm runs here** — it swaps Linux esbuild
  binaries for Windows ones and drops ~1350 lines. Check `git status -- yarn.lock`
  before every commit.
- **Lock files race the crates.io index.** Regenerating locally and on the runner
  minutes apart can differ by a patch release. CI uploads its own regenerated
  files as the `generated-lockfiles` artifact; take those.
- Chipnet only in tests, never mainnet. No seeds, keys or mnemonics logged.

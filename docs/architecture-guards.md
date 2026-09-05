# The architecture guards, and why not to edit them

`cargo run -p xtask` and `cargo run -p xtask -- parity` enforce the decisions
this codebase is built on. They are cheap to silence and expensive to lose.

**If a guard fails, the guard is almost certainly right.** It is describing a
boundary someone chose deliberately, and the fix is on your side of it. Adding a
name to an allow-list, deleting an assertion, or widening a match to make the
build go green converts a design decision into a comment nobody reads.

Two of these checks were themselves *tightened* rather than relaxed when they
produced false positives. That is the pattern to copy:

- The framework check matched `eframe` inside a **comment** explaining why
  eframe is absent. The fix was `manifest_body()`, which strips TOML comments —
  not removing `eframe` from the list.
- The Apple/Opal source scan matched `SwiftFulcrum` in a doc comment, a code
  comment, and a test label naming the implementation being compared. The fix
  was `rust_code_only()`, which strips comments, string literals and raw strings
  so the scan reads *code* — not deleting the scan. A guard that fails on the
  word teaches people to reword the sentence; a guard that fails on the import
  is worth keeping.

Both took longer than an allow-list entry. Both left the guard stronger.

---

## `xtask architecture`

### Framework isolation

**Checks:** `optn-core`, `optn-app`, `optn-platform`, `optn-platform-native`,
`optn-platform-apple`, `optn-runtime` and `optn-transport` name none of
`leptos`, `tauri`, `dioxus`, `capacitor` in their manifests.

**Why:** the whole point of the split is that the shell is replaceable. The
moment `optn-app` knows what Leptos is, "swap the renderer" becomes a migration.

**If it fails:** you added a UI dependency to a crate that must not have one.
Move the code to a renderer crate, or put the capability behind a trait in
`optn-platform` and implement it in the shell adapter.

**Do not:** add the framework to the crate and remove it from `FRAMEWORK_NAMES`.

### Wallet truth stays in Rust

**Checks:** no Apple/Opal package name (`opalbase`, `opalcrypto`, `opalfusion`,
`opalhedge`, `opaldiagnostics`, `swiftfulcrum`) appears in `optn-core`,
`optn-app` or `optn-runtime` — in their manifests *or* in their Rust code, with
comments and string literals stripped first.

**Why:** Apple providers are optional adapters reached through
`optn-platform`'s contracts. A wallet whose derivation or signing lives behind a
Swift package is a wallet that cannot ship on Android. `OpalCrypto`'s own README
says its secret-scalar work has not completed constant-time hardening, so it
must never see key material.

**If it fails:** you referenced an Apple package from a wallet-authority crate.
Put the capability behind a trait in `optn-platform` and implement it in
`optn-platform-apple`.

**Do not:** widen `APPLE_REFERENCE_DEPENDENCIES` or skip the source scan. If it
fires on prose, fix `rust_code_only()` — that is what happened before, and the
scan got better rather than weaker.

### The renderer swap is one line

**Checks:** `optn-ui-text` and `optn-ui-egui` both depend on `optn-app` and
`optn-transport` and nothing else framework-shaped; `optn-ui-egui` does not
depend on `optn-core`, `optn-runtime`, `optn-platform` or `eframe`; and the two
crates' **host blocks are identical except for one line**, which must be the
`type Ui<T> = ...` alias.

**Why:** "the renderer is swappable" is a claim with a number in it. Two
renderers driving the same script through the same `optn_transport::run`, whose
only difference is which renderer is named, is the proof. It stops being true
the moment someone edits one side.

**If it fails:** you changed one host block and not the other. Make the same
change in both. If the change genuinely belongs to one renderer, it belongs
outside the host block.

**Do not:** relax the one-line rule to two. The number is the claim.

**On `eframe` specifically:** it drags in winit and a GPU backend, and the egui
tests would stop running on a machine with no display. That is why it is banned
rather than merely unused.

### No web source inside the Rust renderer

**Checks:** no `.js`, `.jsx`, `.ts`, `.tsx` or `.vue` file under
`crates/optn-ui`.

**Why:** the reference TypeScript wallet is a behaviour oracle to check against,
not a place to move code into. HTML and CSS build assets are fine; application
logic is not.

**If it fails:** the logic belongs in Rust, or the file belongs in `src/`.

### Apple packaging

**Checks:** `apple/OPTNAppleProvider` links no Opal package;
`apple/OPTNOpalReference` pins exact revisions, gates on `.macOS(.v26)` /
`.iOS(.v26)`, consumes no `branch:` dependency, isolates itself behind
`OPAL_APPLE26_REFERENCE`, and links none of OpalBase, OpalCrypto, OpalFusion or
OpalHedge.

**Why:** OpalBase pulls five siblings by `branch: "develop"`, so pinning it to a
tag still does not give a reproducible build. OPTN's iOS minimum is 14.0 and
every Opal package requires iOS 26 — adopting one would raise the product
minimum by twelve major versions. The reference flavour exists as a conformance
oracle, not as a shipping dependency.

**Do not:** raise OPTN's deployment minimums to satisfy a dependency, or replace
a pinned revision with a moving branch.

---

## `xtask parity`

This one guards *product decisions*, and it is the easier of the two to damage
by accident, because its assertions look like configuration.

### Watch Only is on every surface

**Checks:** `watch_only` is `pass` for all seven platforms in
`rustification/parity-matrix.toml`; `optn-app` exposes it as
`FeatureFlag::WatchOnly` rather than a hardcoded surface hide; `AppShell` keeps
the route registered; `capabilities.ts` agrees.

**Why:** Watch Only is the door an air-gapped device comes through, and unlike
hardware it needs no transport at all — an account xPub can be pasted. A popup
with no camera and no USB can still watch a cold wallet. An `na` appearing here
is a platform quietly losing that door.

**The rule lives in five places and they must agree:** `optn-app`'s
`surface_allows`, `optn-transport`'s wire snapshot, `capabilities.ts`, the
parity matrix, and `parity.rs` itself. Changing one and not the rest turns the
check red. That is the check working.

**Do not:** hide the route by omitting it from `AppShell`. Hide it with the flag,
so the surface stays reachable and testable.

### Hardware follows the integrations

**Checks:** `hardware_wallet` is `na` on android and ios, and `pass` on web and
extension.

**Why:** the phones have no native device plugin yet — that is missing work, not
a platform limit; Android holds a cable, both have radios and NFC, and Tangem is
phone-only. The browsers drive three of the five devices today: a Ledger over
WebHID, a OneKey through its own web SDK, and a Keystone by camera. The
extension is where people reach for a hardware wallet, so it is the worst place
to get wrong.

**Do not:** flip web or extension back to `na` to make a red check go away. If
an integration genuinely regresses, fix the integration.

### Evidence must exist

**Checks:** any cell claiming `e2e`, `device` or `e2e-declared` evidence names an
`evidence_refs` path that exists, and if it names a `::token`, that token appears
in the file. Any `na` carries an `na_reason`.

**Why:** a matrix that claims coverage without pointing at it is worse than no
matrix.

**Do not:** claim `e2e` for a unit test. The production-ready view counts only
`e2e` and `device`, and `unit` reading as `fail` there is correct — it means "not
proven end to end", not "missing".

### Reactivity invariants

**Checks:** `optn-ui` switches pages from a `Memo` over the route
(`mounted_page`) rather than the whole `AppState`; `DerivationPicker` follows a
reactive network rather than `get_untracked` at first render.

**Why:** both are bugs that were found and fixed. Keying page mount on the full
state snapshot remounts Create/Import/Watch-only whenever the network or theme
changes, losing whatever the user had typed. `get_untracked` at first render
pins the derivation path to Mainnet even after switching to Chipnet.

**Do not:** treat these as style rules. They encode two real defects.

---

## The other checks worth not defeating

- **`cargo run -p xtask -- audit`** walks *all six* lock files, not the three the
  CI lockfile job checks. `BASELINE_ADVISORIES` is deliberately empty: a mute
  that outlives its reason silently accepts the vulnerability's return.
- **`deny.toml`** allows `GPL-3.0-only`, not the deprecated bare `GPL-3.0`, and
  rejects wildcard path dependencies. Both caught real inconsistencies. Pin the
  version; do not widen the allow-list.
- **Kani proofs** run against `optn-core`. That crate carries **no
  dev-dependencies** on purpose — it is workspace-excluded, wasm-built and
  formally verified. Property tests that need `proptest` live in `optn-app`,
  which already has it. Adding a dev-dependency to `optn-core` to make a test
  more convenient trades a verified boundary for typing convenience.

---

## The one-line version

These guards exist because the alternative is a design that is true on the day
it is written and false a month later. When one fails, the honest fixes are: move
the code, implement the trait, or update all five places the rule lives. Editing
the guard is only correct when the guard is checking the wrong *thing* — as with
the two comment-stripping fixes above — and then the guard gets sharper, never
looser.

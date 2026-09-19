# PR #63 requirement ledger — #71 and #75

Current source and execution evidence establish what exists. Current issue
requirements establish what must exist. A disagreement is a gap to reconcile;
code does not override an unmet requirement.

Read the status column strictly:

| Status | Means |
| --- | --- |
| **PROVEN** | The named claim has evidence; its scope is limited to the cited test, live workflow or packaged target, never implicitly end to end |
| **INTEGRATION** | Implemented and tested, but not yet reached by the running application |
| **DEVICE EVIDENCE** | Implemented and tested; needs a packaged artifact or hardware to finish |
| **PARTIAL** | Some of it exists; the gap is named |
| **MISSING** | Not implemented |
| **BLOCKED** | Needs something this environment does not have |

"Implemented" never means a type exists. Every row names an entry point a
reader can open and, where there is one, the test that holds it up.

Record evidence as component, application integration, live workflow or packaged
platform, with revision/environment where available. Existing rows need that
distinction checked before being used as release evidence. Historical statements
about unavailable tooling must be rechecked on the current host. #84 is the
closed Vitest dependency PR; its migration and coverage requirements are carried
in #63, not a separate wallet architecture.

---

## #75 — chain, sources, verification

Latest bounded evidence (2026-09-19): a real Windows Tauri/Leptos watch-only HD wallet synced 39,774 sats and two history entries through explicitly confirmed Tor. With Tor stopped, process restart restored the same balance/history marked stale; an offline refresh retained it, and a later live refresh restored freshness. See `docs/chain-interop-evidence.md`. This is Electrum server-assertion evidence, not live SHV/MMR or all-platform completion.

Earlier bounded evidence (2026-09-12): the live Chipnet test now exercises HD
sync, matching CLI/transport totals, encrypted checkpoint restart, stale-state
retention and live resume. See `docs/chain-interop-evidence.md`. This closes that
runtime/CLI evidence gap, not the whole-issue milestone. A packaged Android
watch-only run at `a7af43d9` also preserved the saved wallet, password gate,
balance and history after offline restart. That APK exposed a server-override
fallback bug. The corrected `0e7da058` APK retains stale data when the chosen
local server is unavailable and resumes only after explicitly selecting the
live Chipnet server; the old saved overlay is covered too. This is bounded
Electrum/host-Tor evidence, not complete source/transport policy parity.
A further restart resumed through the same persisted selection, and the real
Windows CLI opened the Android-produced encrypted account/checkpoint and
restored/resynced the same 39,774-sat balance and two history entries.

Fresh source selection now mounts the same reviewed Rust bootstrap catalog in
native GUI and CLI. CLI Auto reached Chipnet through `shared-native-policy`
without writing public defaults into user settings. Runtime/CLI regressions
cover saved bootstrap bans, exact selection, and empty own-infrastructure
policies without public fallback. The Windows native adapter compiles with
the pinned Tor bundle staged; this is build evidence, not GUI interaction.

CashFusion recovery: the protocol engine is now `crates/optn-fusion`; the shared
app/transport policy and session state are committed. Wallet/network changes,
locking and disable/cancel actions revoke session consent. A running shared
Fusion driver, durable per-wallet Auto preferences and its UI/CLI controls are
still integration work; model/transport tests do not prove paid rounds run.

### Definition of done

| # | Requirement | Status | Entry point / evidence | Gap |
| --- | --- | --- | --- | --- |
| 1 | Auto is the default and operation-aware | **PARTIAL** | `optn-runtime/src/bootstrap.rs::shipped_bootstrap_catalog`, wired in `src-tauri/src/chain_runtime.rs::catalog_and_policy_from_app_state`; `a_fresh_install_starts_from_the_shipped_catalog` | Both halves that are implementation are done: the catalog is non-empty on a fresh install, and operation-aware selection is in `build_selection_plan`. What is left is breadth -- one reviewed endpoint per network rather than §21.3's upstream feeds -- and that is listed below as a deliberate non-blocker. It is a product decision about whose servers every fresh install should contact, not a coding task; inventing hostnames to close the row would point installs at hosts nobody reviewed |
| 2 | Users can pin policies/providers | **PROVEN** (Rust adapters; bounded GUI live selection) | Shared source catalog and `WireConnectionPolicy`; Leptos advanced selection/failover/add/remove controls, CLI `network configure`, and portable configuration import/export. Windows GUI Electrum selection and custom Tor persistence exercised on 2026-09-19 | Full selection matrix on every packaged platform and legacy React migration remain separate |
| 3 | Privacy / own-infrastructure fail closed | **PROVEN** | `ConnectionPolicy`, `optn-chain-native::build_native_chain_stack`; `remote_full_node_adapters_remain_fail_closed_even_with_tor`, and live against real hosts in `optn-chain-native`'s `live_route_eligibility_follows_ownership_not_address_shape`: a declared own-infrastructure node on a private mesh routes with no Tor running, while a public endpoint under the same policy is refused | — |
| 4 | Tor modelled as transport policy, not a provider | **PROVEN** | `TorProxyTrust` in `optn-chain-native`, `UserNetworkOverlay::trusted_socks_ports`, `optn_chain_trust_socks_proxy`, `optn_tor_readiness`, the CLI's `Client::trusting_socks_ports`, and `AppTransport::{tor_status, start_tor, trust_socks_port}` consumed by `optn-ui`'s `TorSection`; `a_socks_greeting_alone_does_not_make_a_proxy_trusted`, `provenance_is_what_makes_a_proxy_usable`, `a_trusted_port_that_stops_answering_is_not_still_trusted`, `an_unconfirmed_socks_proxy_is_reported_but_not_used` | A SOCKS5 greeting no longer grants trust -- it proves SOCKS5, which every no-auth proxy answers identically. Trust is provenance: a proxy this application started and owns, or one the holder confirmed once, persisted in the overlay the desktop and CLI share. Anything merely found on a conventional port is `Unverified` and refused. Both renderers now ask the runtime the same question instead of deciding for themselves -- the Leptos surface had no Tor awareness at all, so a holder there saw every public source refused with nothing saying why |
| 5 | Tor-required routes ineligible, no direct/DNS fallback | **PROVEN** | `needs_default_tor_proxy`, `endpoint_can_use_native_tor`; driven against a live route change in `live_route_eligibility_follows_ownership_not_address_shape` — with a verified SOCKS proxy the public route is eligible and serves verified headers, and with the proxy stopped the same policy and source is refused rather than dialled directly | The test asserts both directions, so it says something whichever way the host's Tor happens to be |
| 6 | Electrum and BIP37 preserved behind provider interfaces | **PROVEN** | `optn-chain-electrum`, `optn-chain-bip37`; live BCHD run in `docs/chain-interop-evidence.md` | — |
| 7 | Neutrino capability-gated, does not block Auto startup | **PROVEN** | `optn-chain-neutrino::connect` records `CompactFilters` only after the genesis-filter probe commits; `a_regtest_node_does_not_answer_for_mainnet` | — |
| 8 | BCHN RPC and ZMQ modelled separately from SPV | **PROVEN** | `crates/optn-chain-bchn`, `crates/optn-chain-zmq` | — |
| 9 | ZMQ is event/wake-up, never proof | **PROVEN** | `optn-chain-zmq`, `optn-runtime/src/event_recovery.rs`; driven against BCHN 29.1.0 regtest publishing all four topics on one socket by `optn-chain-zmq/tests/bchn_live.rs` -- `rawblock` and `hashblock` agree on a block the node then confirms it holds, `rawtx` and `hashtx` agree on one txid, and per-topic sequence numbers advance by one so a dropped notification is detectable | The live run found a real bug: BCHN publishes the `hash*` topics with the uint256 reversed, and the crate stored the frame as-is, so the same transaction arrived under two byte-reversed txids and a `hashtx` wake-up matched nothing the wallet held. Invisible to the unit test, whose fixture was 32 equal bytes -- its own reversal. Fixed in `parse_hash`; the never-proof half is held by `ChainEventKind`, which has no variant carrying verified state |
| 10 | Observations reconcile into one authoritative Rust state | **PROVEN** | `optn-runtime/src/reconciliation.rs`, `sync_worker.rs` | — |
| 11 | No 2-of-3 provider voting | **PROVEN** | `reconciliation.rs` ranks evidence; no vote count exists | — |
| 12 | SHV/MMR passes reference vectors | **PROVEN** | `optn-core/src/header_mmr.rs::reference_vectors` against bitcoincashautist's published vectors, byte-identical to BCHN's | — |
| 13 | Pruning preserves historical verification and reorg recovery | **PROVEN** | `header_store.rs::prune_below`/`rewind_to`; driven against a node that actually reorganised by `optn-chain-neutrino/tests/regtest_live.rs::a_reorg_is_refused_then_rewound_and_pruning_keeps_the_commitment` — pruning leaves the commitment unmoved, a forked branch is refused rather than extended onto, and the rebuild reaches the node's longer branch with a different commitment | Recovery is a rebuild from the anchor, not an in-place rewind: the accumulator is append-only and the test pins that rewinding the index alone does not let it extend. A pruned range still needs an SHV peer to re-prove, which BCHD does not serve |
| 14 | CashFusion uses the shared chain observation layer | **PARTIAL** | Protocol in `crates/optn-fusion` (8,782 lines) with `optn-core/src/fusion/` for the primitives; 138 Rust tests. Driven from `src/platform/desktop/Fusion*.ts` (3,454 lines) | The protocol is Rust -- an earlier revision of this row said otherwise and was wrong. What remains is one module: `crates/optn-fusion/src/electrum_input.rs` (666 lines) speaks Electrum JSON-RPC over its own stream to check a peer's inputs, instead of routing through `chain_service`. Moving it is not mechanical: it decides blame during a live round, it takes a `Transport` whose Tor route the caller already chose, and the feature is released and reported working on chipnet and mainnet. It needs a live fusion round to verify, which this branch has no way to drive, so it is deferred rather than attempted blind |
| 15 | Explorer routing independent of consensus | **PROVEN** | `optn-core/src/explorer.rs` owns the presets, the templates and the refusal; `optn-runtime/src/explorer.rs::route_for_overlay` turns a saved `UserNetworkOverlay` into a link or a refusal; the renderer calls through via `explorerPresetUrl`/`explorerCustomUrl` and `src/utils/servers/useExplorerLink.ts`. `a_saved_own_infrastructure_policy_refuses_a_public_explorer`, `the_same_policy_opens_the_holders_own_explorer`, `own_infrastructure_refuses_every_public_preset`, and the renderer-side `explorers.test.ts`; `cargo run -p xtask -- architecture` fails any surface that names a public explorer host | Explorer links were the one path around the policy: the renderer held its own preset table and built URLs itself, so a wallet set to own-infrastructure-only still handed txids to a public site. The decision now has one home, and the refusal is rendered with its reason rather than as a missing button |
| 16 | No renderer/shell owns networking or chain truth | **PARTIAL** | `cargo run -p xtask -- architecture` proves declared dependency boundaries | Legacy desktop Home/subscriptions still call TypeScript `ElectrumService` through `UTXOService`. Dependency checks do not prove every packaged interface uses the shared Rust runtime. |

### Architecture and verification

| Requirement | Status | Entry point / evidence | Gap |
| --- | --- | --- | --- |
| One accepted block-header authority | **PROVEN** | `header_store::SharedHeaders` + `header_view::VerifiedHeaderView`; BIP37 and Neutrino both read `BlockHeaderSource`; the host owns it across stack rebuilds (`chain_runtime::AcceptedChain`) | — |
| Shipped network anchors | **PROVEN** (component) | `shipped_header_verifier` anchors each supported network at its own genesis; `every_shipped_genesis_anchor_is_the_chain_it_claims` | The former missing-mainnet-anchor blocker is obsolete. This is not evidence of a complete live mainnet wallet sync. |
| Worker publishes accepted headers | **PROVEN** | `sync_worker::publish_headers`; `a_header_pass_advances_the_view_and_the_store_together`, `a_rejected_header_pass_publishes_nothing` | — |
| Neutrino off private block-header state | **PROVEN** | `optn-chain-neutrino` holds `Arc<dyn BlockHeaderSource>`; filter hashes/headers remain its own | — |
| Duplicate network maps audited | **PROVEN** | Three copies now cross-check: `bip37_and_neutrino_agree_about_every_network`, `this_copy_agrees_with_the_accepted_header_store` | — |
| BIP37 merkle proofs bound to the accepted chain | **PROVEN** | `optn-chain-bip37/src/lib.rs` merkle-binding tests; a forged block is refused | — |
| Header checkpoint persistence | **PROVEN** (runtime/GUI/CLI integration tests) | Guarded wallet/header checkpoint publication; shared `with_stored_header_progress`; native `accepted_chain` restores a sealed view after wallet open | Live GUI checkpoint reopen is proven for Electrum wallet state; a live P2P/MMR checkpoint restart still needs evidence |
| Authenticated historical replay | **PROVEN** (connected runtime regression) | `sync_worker::restore_historical_store_on_same_route` calls `header_recovery`; typed private locators acquire on the same route, then an atomic authenticated commit publishes the dense store | Live P2P restart and interruption/resume performance remain to verify; missing dense history may require replay from genesis |
| SHV P2P root/peak proofs | **PROVEN** | `optn-chain-bip37/src/shv.rs`; live against BCHN `e6d380373` with `-mmrindex=1`, proof accepted only against OPTN's own root | — |
| BCHD-correct compact filters | **PROVEN** | `optn-chain-neutrino/src/filter.rs`; live BCHD scan agrees with the Bloom path on the same coins | Independent BCHD-produced filter fixtures not yet vendored |
| Sequential receive → spend lifecycle | **PROVEN** | `a_spend_is_found_through_an_outpoint_the_receive_scan_discovered`; spend invisible to a script-only scan | CashTokens/NFT/OP_RETURN/reorg/restart cases not covered |
| Manual rescan, encrypted restart, GUI/CLI routing | **PROVEN** (runtime/CLI; bounded Windows GUI refresh/reopen) | `request_wallet_rescan`, encrypted checkpoints, Settings `rescan_wallet_from`, CLI `rescan --from-height`; CLI live floor checks and Windows GUI offline restart/online resume on 2026-09-19 | GUI custom-height interaction and current Android/macOS packages still need separate verification; normal HD refresh rechecks the configured floor, not only a suffix |
| Wallet birthday | **PARTIAL** (durable imported hints connected) | Shared `SetBirthday`/`ClearRescan`, sealed checkpoint, atomic `BeginHd` floor resolution; CLI process restart and Windows GUI height/date reopen and manual-override clearing verified on 2026-09-19. Unknown imports explicitly scan from genesis; missing authenticated date evidence fails closed; legacy manual floors migrate | Host-generated creation-anchor capture and automatic header acquisition for unresolved dates remain. Imported mnemonic input is never treated as proof of fresh wallet creation |
| Local BCMR / authchain | **PARTIAL** | Core authchain/publication verification and shared identity projections; bounded native Tor registry adapter passes six checks. Wallet-local absence of a spender no longer grants verified identity | Source-bound spentness/authchain execution is not yet connected to registry retrieval. Legacy TypeScript metadata/indexer calls remain outside this Rust path |
| Token capability execution | **INTEGRATION** | `optn-runtime/src/token_capability.rs`; refuses global totals from partial data | Planner and executor exist; no provider adapter routes through them |
| Broadcast lifecycle | **PARTIAL** | `optn-runtime/src/tx_broadcast.rs` | Uncertain-broadcast reconciliation exists; Send/PSBT/hardware/Fusion are not yet on one lifecycle |

---

## #71 — product UI

| Requirement | Status | Entry point / evidence | Gap |
| --- | --- | --- | --- |
| Web build produces a shipping bundle | **PROVEN** | `npm run build` → `dist/` (50 MB, typecheck clean) on Vitest 5 / Vite 8 | — |
| Four theme modes | **PROVEN** | `optn_app::ThemeMode` — Light, Gray, Green, Dark | — |
| Default / Cyberpunk skins | **PROVEN** | `optn_app::UiSkin` | — |
| Theme/skin persist without touching keys | **PROVEN** | `AppAction::SetTheme` / `SetSkin`; `appearance_dispatch_acknowledges_durable_changes_and_reports_failed_saves` drives all three actions through the real dispatch path and restores them from disk, `restart_restores_all_eight_combinations_before_initial_snapshot` covers every theme/skin pair, and `changing_appearance_writes_nothing_but_appearance` asserts the other half -- a presentation change leaves wallet material byte-identical and creates no file but its own | The gap this row named -- "persistence across restart not asserted" -- was already closed and the row had not caught up. What was genuinely unasserted was "without touching keys", which is now explicit |
| Landing: Create / Import / Watch Only | **PROVEN** (desktop/Android landing) | `optn-ui/src/onboarding.rs`; Android APK `a7af43d9` displayed all three paths and completed typed watch-only onboarding | iOS and F-Droid have no packaged assertion; Android seed create/import and scanned-account flows need separate verification |
| Watch Only never gains signing authority | **PROVEN** (component/runtime) | `WalletKind::WatchOnly`; `WalletSecurity::wallet_for_operation`; `watch_only_password_and_biometrics_never_grant_signing_authority` | Password/biometric storage authentication cannot return a private wallet for Spend, Reveal, Background or Chat |
| Watch-only persistence and reopen | **PROVEN** (runtime/CLI, Android typed import) | `WalletSecurityRequest::ImportWatchOnly`, encrypted `WatchOnlyFile`, shared checkpoint lifecycle, GUI `SaveWatchOnly`, CLI `wallet` → `watch` / `import_watch_only`; `a7af43d9` APK reopened encrypted Chipnet account/history offline after force-stop and rejected a wrong password; `0e7da058` restored the same persisted data with corrected source isolation | The earlier `4f3face1` loss is corrected. Scanned import and macOS need packaged verification. Public browser previews remain explicitly temporary |
| Master fingerprint asked once, persisted | **INTEGRATION** | `OpenedWallet::master_fingerprint` | Matrix evidence is `unit` on every surface except Android `e2e-declared` |
| Home / portfolio | **PARTIAL** | `AppRoute::WalletHome` | Exists; not audited against `docs/ui-overhaul` |
| Assets | **INTEGRATION** | `optn_app::assets_view_model`; `categories_total_across_every_coin_that_carries_them` | Leads with held categories rather than outpoints. Category is still raw hex until BCMR resolution is wired to it |
| **My NFTs** | **INTEGRATION** | `AppRoute::Nfts` → `#/nfts`, `optn_app::nfts_view_model`, `optn-ui/src/tools.rs::NftsPage`; `my_nfts_is_a_wallet_destination` | Screen exists in both renderers and opens from Assets. Identity still unresolved hex |
| Send / Receive | **PARTIAL** | `AppRoute::Send` / `Receive` | Screens exist; end-to-end spend from the Leptos UI not demonstrated |
| History / tx details | **PARTIAL** | `AppRoute::History` | Details view not separately routed |
| Owned CashToken/NFT state without a global indexer | **PROVEN** | `optn_app::assets_view_model` / `nfts_view_model`, derived from `state.coins` alone; consumed by both renderers | — |
| BCMR identity in Assets / My NFTs | **INTEGRATION** | `token_metadata::IdentityMetadata` keeps current / stale / unpublished / unresolved distinct | Not consumed by any screen |
| PSBT / SeedCash / UR | **INTEGRATION** | `optn-core/src/airgap_spend.rs`, `psbt.rs`; `optn-runtime/src/airgap.rs` reserve HD change durably before export and bind signed imports to the current request. Captured SeedCash Schnorr return and ECDSA finalization pass; runtime actor tests cover reservation, storage failure, cancellation and restart | Fresh GUI/CLI signing and packaged-platform verification are still pending. Single-input Chipnet P2PKH `0x41` path; multisig, advanced sighash and broadcast integration remain separate |
| RPA / Cash Code | **INTEGRATION** | `optn-core/src/rpa.rs` | Matrix `unit` |
| Hardware | **PARTIAL** | `optn-ui/src/hardware.rs`, `HardwareVendor` | Vendor-by-surface audit not done; no device evidence |
| CashFusion | **PARTIAL** | Rust protocol in `src-tauri/src/fusion/` + `optn-core/src/fusion/`; driven from `src/platform/desktop/Fusion*.ts` | Implemented and released; reported working on chipnet and mainnet. The remaining gap is the renderer/driver layer, not the protocol |
| 44px targets, safe areas, contrast | **PARTIAL** | `optn-ui/style.css`, measured by `optn-ui/src/stylesheet.rs`: `interactive_controls_declare_a_44px_minimum_tap_target` requires an explicit `min-height: 44px` on `.primary`, `.secondary`, `.chip`, `.tab-item` and `.settings-row`, and `the_shell_respects_the_devices_safe_areas` requires both safe-area insets | Targets and safe areas are now measured rather than assumed -- declared as `min-height` because padding plus a line box lands near 42px and "nearly" never gets revisited. Contrast is still unmeasured. The same module found 17 classes the renderer uses that the stylesheet never defines -- `.error` and `.warn` among them, so a failure message renders as ordinary body text. They are baselined in `UNSTYLED_TODAY` rather than invented, and `no_new_class_is_left_unstyled` stops the list growing |
| Capacitor/React retained until Leptos is proven | **PROVEN** | Both trees present | — |

---

## What is genuinely blocked here

| Blocker | Needs |
| --- | --- |
| Signed Android Play / F-Droid and packaged iOS verification | This host now has an Android SDK and isolated Android 36 emulator; a Rust debug APK rendered landing and watch-only import. Store signing and iOS device/simulator verification remain separate requirements |
| Hardware wallet signing evidence | Physical Ledger / Trezor / Keystone devices |
| Fulcrum/Electrum real-node evidence | A reachable Fulcrum instance; regtest has no Electrum server |

---

## Deliberate non-blockers

These are future work and must not be read as release blockers.

- **Retiring non-SHV compatibility.** SHV is the long-term header architecture;
  ordinary BIP37 and Neutrino nodes stay supported until the ecosystem has
  moved, which is a retirement review rather than today's implementation.
- **Removing TokenIndex or another specialized provider.** The point of the
  capability model is that this becomes an adapter deletion. It is not a
  precondition for the owned-asset work.
- **Ingesting the full §21.3 bootstrap feeds.** The shipped catalog is the
  product's own reviewed defaults today; broadening it is an ingest into the
  same structure, which already preserves per-project provenance.

## Source settings integration evidence (2026-09-19)

The Leptos/Tauri adapter now renders the typed source catalog and edits protocol
filters, primary/fallback scopes, preferred order, dispositions and user sources.
CLI `network configure` uses the same Rust selection validator. GUI backup/restore
and CLI `network export` / `network import` use the shared network-bound portable
codec and atomic native store. Imports cannot transfer machine-local SOCKS trust;
wrong-network or malformed imports preserve the existing file.

Evidence: runtime network-configuration tests (19), CLI wallet process tests (13,
including configure/export/import/restart/refusal), native portable-file test,
native source tests, BIP37 provenance/stale-network tests, strict runtime/CLI/native
and WASM UI Clippy, architecture gate, and a Leptos Trunk WASM build passed.
These are component/process/build checks, not a live GUI or packaged-device claim.

Legacy BIP37 commands no longer accept renderer-selected SOCKS routing and check
network selection before and after route resolution. Probe, headers, scan and
broadcast now also require a BIP37-permitted endpoint in the shared planner's
primary/fallback selection, rejecting disabled, banned and unselected sources
before proxy probing. Native tests: 93 passed, four live mainnet tests ignored;
strict native Clippy passed. This closes that command-entry policy gap, not live
P2P/GUI verification. The React migration, full live wallet workflow, remaining
provider integration and platform evidence remain open.

### 2026-09-19: wallet history is not BCMR spentness evidence

The shared identity collector no longer treats a missing spender in wallet-scoped history as an unspent authhead. Transaction inclusion, even from a validated node, cannot establish the absence of a later spend. Matching registry bytes therefore remain unresolved until explicit authchain spentness is supplied; owned tokens and NFTs stay visible. Checked through the collector and wallet-sync finish (20 metadata tests, 16 wallet-sync-related tests, strict runtime Clippy). Pure hash-verification positive tests remain. Native registry retrieval and a source-bound authchain execution path are still separate outstanding integration work.

### 2026-09-19: authenticated historical header recovery is connected

CLI restores the sealed header view through the shared worker helper. The native GUI picks up restored header progress when a wallet opens after route-stack initialization. BIP37/Neutrino can acquire missing historical hashes using typed private locators; replay remains in a private store until it matches the accepted MMR commitment, then swaps atomically after a concurrent-store check. Recovery is bounded at 2,000,000 headers and stays on the selected route. Runtime suite: 267 passed, strict Clippy passed; native/CLI/provider checks passed. The connected regression observes the shared store during every replay request. This is integration-test evidence, not a live P2P restart or all-platform claim. Dense historical recovery may still need network replay after process restart; the saved wallet balance remains independently available as stale.

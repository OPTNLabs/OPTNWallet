# PR #63 requirement ledger — #71, #75 and #83

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

For user-facing requirements, completion requires the actual GUI control and CLI
command to reach the shared backend, display its result or failure, and preserve
the intended state across reopening. Visual polish may be deferred; reachable
controls, cancellation, authorization and correct result handling may not.

Record evidence as component, application integration, live workflow or packaged
platform, with revision/environment where available. Existing rows need that
distinction checked before being used as release evidence. Historical statements
about unavailable tooling must be rechecked on the current host. [#83](https://github.com/OPTNLabs/OPTNWallet/issues/83)
coordinates authority boundaries, dependency direction, trusted transports and
untrusted add-on contracts. It does not replace the detailed #71/#75 requirements
or imply that the #82 marketplace is complete. #84 is the
closed Vitest dependency PR; its migration and coverage requirements are carried
in #63, not a separate wallet architecture.

---

## #75 — chain, sources, verification

Native renderer pilot (2026-09-19): `crates/optn-ui-slint` is an opt-in Windows
Network Sources test window, not a replacement for the v1.7.4 UI. Native view
callbacks exercised add, ban, pin, preference, selected pools, removal and
Automatic through `optn-transport-native` and durable rereads. Four adapter
tests cover malformed input, bootstrap removal refusal, bans after reopening,
and removal retaining an empty explicit pool. Tauri reuses the extracted source
projection (four focused tests). Architecture and strict pilot/adapter Clippy
pass. Native snapshots cover wide, narrow and short windows plus
maximize/minimize/restore. This establishes bounded settings integration, not
live sync, visual parity, wallet actions or mobile/macOS completion. Reproduce
with `crates/optn-ui-slint/README.md`; all shipping renderer/platform gates remain.

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
| Wallet birthday | **PARTIAL** (durable imported hints connected) | Shared `SetBirthday`/`ClearRescan`, sealed checkpoint, atomic `BeginHd` floor resolution; CLI process restart and Windows GUI height/date reopen and manual-override clearing verified on 2026-09-19. Unknown imports explicitly scan from genesis; missing authenticated date evidence fails closed; legacy manual floors migrate | Automatic same-route header acquisition is connected and tested; requests retain their runtime generation across header I/O. Host-generated creation-anchor capture, restored historical-date evidence and live date acquisition remain to verify. Imported mnemonic input is never treated as proof of fresh wallet creation |
| Local BCMR / authchain | **PARTIAL** | HD sync now invokes selected transaction/spentness routes, bounded registry retrieval and guarded identity publication. Connected synthetic sync checks accepted identity, unknown spentness, output mismatch, wrong registry hash, absent fetch transport and stale-state downgrade | Needs real-node/token workflow; desktop RPC credential controls and CLI private-input controls are connected (see evidence below). Unknown successors outside wallet history need a selected spender-discovery capability; legacy TypeScript migration remains. Authenticated token-identity caching and stale restart semantics are connected and tested (see 2026-09-19 evidence below) |
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
| Assets | **INTEGRATION** | `optn_app::assets_view_model`; held categories and connected HD metadata projection test | Raw category remains visible when resolution is unavailable; live token metadata and packaged UI evidence remain |
| **My NFTs** | **INTEGRATION** | `AppRoute::Nfts` → `#/nfts`, `optn_app::nfts_view_model`, `optn-ui/src/tools.rs::NftsPage`; `my_nfts_is_a_wallet_destination` | Screen exists in both renderers and opens from Assets. Identity still unresolved hex |
| Send / Receive | **PARTIAL** | `AppRoute::Send` / `Receive` | Screens exist; end-to-end spend from the Leptos UI not demonstrated |
| History / tx details | **PARTIAL** | `AppRoute::History` | Details view not separately routed |
| Owned CashToken/NFT state without a global indexer | **PROVEN** | `optn_app::assets_view_model` / `nfts_view_model`, derived from `state.coins` alone; consumed by both renderers | — |
| BCMR identity in Assets / My NFTs | **INTEGRATION** | Shared identity projections retain current / stale / unpublished / unresolved states; Leptos consumes Assets/NFT view models | Connected synthetic HD sync reaches Assets; live token workflow and packaged token rendering remain; authenticated metadata restart caching is connected (see 2026-09-19 evidence below) |
| PSBT / SeedCash / UR | **INTEGRATION** | `optn-core/src/airgap_spend.rs`, `psbt.rs`; `optn-runtime/src/airgap.rs` reserve HD change durably before export and bind signed imports to the current request. Captured SeedCash Schnorr return and ECDSA finalization pass; runtime actor tests cover reservation, storage failure, cancellation and restart | Fresh GUI/CLI signing and packaged-platform verification are still pending. Single-input Chipnet P2PKH `0x41` path; multisig, advanced sighash and broadcast integration remain separate |
| RPA / Cash Code | **INTEGRATION** | `optn-core/src/rpa.rs` | Matrix `unit` |
| Hardware | **PARTIAL** | `optn-ui/src/hardware.rs`, `HardwareVendor` | Vendor-by-surface audit not done; no device evidence |
| CashFusion | **PARTIAL** | Rust protocol in `src-tauri/src/fusion/` + `optn-core/src/fusion/`; driven from `src/platform/desktop/Fusion*.ts` | Implemented and released; reported working on chipnet and mainnet. The remaining gap is the renderer/driver layer, not the protocol |
| 44px targets, safe areas, contrast | **PARTIAL** | `optn-ui/style.css`, measured by `optn-ui/src/stylesheet.rs`: `interactive_controls_declare_a_44px_minimum_tap_target` requires an explicit `min-height: 44px` on `.primary`, `.secondary`, `.chip`, `.tab-item` and `.settings-row`, and `the_shell_respects_the_devices_safe_areas` requires both safe-area insets | Targets and safe areas are now measured rather than assumed -- declared as `min-height` because padding plus a line box lands near 42px and "nearly" never gets revisited. Contrast is still unmeasured. The same module found 17 classes the renderer uses that the stylesheet never defines -- `.error` and `.warn` among them, so a failure message renders as ordinary body text. They are baselined in `UNSTYLED_TODAY` rather than invented, and `no_new_class_is_left_unstyled` stops the list growing |
| Capacitor/React retained until Leptos is proven | **PROVEN** | Both trees present | — |

---

## #83 — architecture coordination

#83 is the coordination contract, not the closed #84 dependency update. Its
acceptance is not implied by #75's provider tests or a renderer build. The
following is a current-code reconciliation, not an approval or security sign-off.

| Requirement | Status | Entry point / evidence | Gap |
| --- | --- | --- | --- |
| Layer/dependency and authority map | **PARTIAL** | `RUSTIFICATION.md` separates runtime calls from actual Cargo dependencies; runtime owns wallet sessions, providers return observations, platform ports supply capabilities | Current transport contracts are a runtime dependency; do not claim the issue's target graph is the literal manifest graph. Maintainer approval remains separate |
| Durable state ownership | **PARTIAL** | `optn-runtime/src/wallet_security.rs`, `wallet_checkpoint.rs`, `wallet_sync.rs`; encrypted restart evidence above | Legacy Redux/SQL services remain a second authority until migrated; reservations/outbox lifecycle must converge |
| Versioned trusted transport and separate guest protocol | **PARTIAL** | `optn-transport::WIRE_PROTOCOL_VERSION` and unknown-version rejection; Rust `addon::legacy_guest_call_allowed` gates the real iframe bridge via generated WASM | The legacy guest message format is not the required versioned runtime guest/session protocol |
| Intent → proposal → approval → sign/export → broadcast → reconcile | **PARTIAL** | `spend`, `airgap` and `tx_broadcast` runtime modules | One connected durable lifecycle across Send/PSBT/hardware/Fusion/add-ons remains #79/#8 work |
| Providers cannot directly publish wallet state | **PROVEN** (contract/component) | `ChainBackend` returns typed observations; runtime reconciliation and guarded sync finish own publication | Legacy paths listed under #75 still need migration |
| Host-owned package identity, grants, sessions, updates/rollback | **PARTIAL** | Existing core add-on policy primitives and legacy installer/SDK | No complete Rust host package/session authority. A manifest trust claim is not verified identity; #82 owns implementation |
| Migration map and child scopes | **PROVEN** (documentation) | Map below; linked #71/#75/#79/#82/#8 scopes | This records remaining ownership work, not completed migration |
| Spend-capable guest boundary review | **PARTIAL** | Rust guest ceiling rejects raw tx/signature templates/message signing, writes, and direct network methods before SDK dispatch, regardless of manifest/grant; native and actual WASM bridge regressions | Full host/proposal/session security review is outstanding. Third-party spending stays unavailable until that boundary exists |

### Migration map

| Existing path | Required destination / compatibility rule | Canonical scope |
| --- | --- | --- |
| `src/state/slices/{wallet,utxo,transaction,network}Slice.ts` and React lifecycle | Projections of runtime snapshots/events; preserve React, remove authoritative state decisions only as callers migrate | [#71](https://github.com/OPTNLabs/OPTNWallet/issues/71), [#75](https://github.com/OPTNLabs/OPTNWallet/issues/75) |
| `ElectrumService`, `UTXOService`, metadata/indexer clients and Fusion peer queries | Typed provider operations under the same source/privacy policy; runtime verifies observations and persists accepted state | [#75](https://github.com/OPTNLabs/OPTNWallet/issues/75) |
| `TransactionManager`, `TransactionService`, signing/PSBT/hardware adapters | Shared intent/proposal, exact-effect approval, reservations, outbox and uncertain-broadcast reconciliation | [#79](https://github.com/OPTNLabs/OPTNWallet/issues/79), [#8](https://github.com/OPTNLabs/OPTNWallet/issues/8) |
| `AddonsSDK`, `AddonPolicyEngine`, iframe bridge and desktop installer | Narrow versioned guest requests; host-authenticated identity/digest, grants, context-bound sessions, quotas and package lifecycle. Never export the trusted UI transport | [#82](https://github.com/OPTNLabs/OPTNWallet/issues/82), [#83](https://github.com/OPTNLabs/OPTNWallet/issues/83) |
| Tauri/CLI/browser platform glue | Execute storage/network/hardware ports; policy and wallet authority stay in Rust runtime. Browser restrictions cannot be lifted by renderer choice | [#71](https://github.com/OPTNLabs/OPTNWallet/issues/71), [#75](https://github.com/OPTNLabs/OPTNWallet/issues/75) |

The current iframe compatibility ceiling exposes only SDK-authorized public
wallet context/address reads and cached wallet UTXO reads. It denies even a guest
claiming `internal` trust with host-supplied spend grants. Legacy registry/network,
logging, audit, confirmation and metadata-discovery methods are not guest
authority. Built-in reviewed UI clients retain their separate SDK path. This is
a containment fix, not a completed add-on runtime or source-policy migration.

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


## RPC credentials interaction evidence (2026-09-19)

The Rust runtime owns endpoint/network/source-bound credential records through
`SecureStorage`. Desktop GUI source rows expose save/status/remove; CLI wallet
navigation accepts `network credentials set|status|remove <source>`, with hidden
prompts, or private stdio `network.credentials` requests. Passwords are absent
from public status, app snapshots and portable network exports. Native stack
construction loads only selected RPC credentials; storage failure refuses the
stack instead of silently retrying without authentication. Credential changes
invalidate wallet freshness and retire old native routes. Removing a GUI source
clears its local RPC credentials before deleting its configuration.

Validation: eight connected store/provider tests, including exact Basic auth
received by a loopback RPC server, changed-endpoint isolation, protocol exclusion,
malformed records and escaped-password bounds. A real Windows secure-store CLI
test saved, reopened in a new process, checked export exclusion, removed and
reopened missing credentials. CLI wallet/security process tests and strict CLI,
WASM GUI and native GUI Clippy pass; architecture gates remain unchanged.
The built Windows GUI also passed save/status, cleared-input, export exclusion,
and delete-source/re-add-with-no-credential interactions on a disposable loopback
source. This used the isolated public Chipnet fixture and cleaned up its source
and credential afterward.

This does not prove a live funded node wallet roundtrip, macOS/Linux keychain
behavior, or mobile credential storage. Mobile/browser controls remain disabled
or unsupported. Linux native keyring entries last for the login session.


## Fusion cryptographic alert review (2026-09-19)

GitHub reports alerts #129/#130 open on `main` commit `bfc7a149` and fixed
on the older PR63 merge analysis `898cebb1`. The alerted shell file has moved to
`crates/optn-fusion/src/encrypt.rs`; path movement alone is not a cryptographic
repair or evidence that a new scan is clean. No alert was dismissed and no
scanner exclusion was added.

[Electron Cash's reference implementation](https://github.com/Electron-Cash/Electron-Cash/blob/master/electroncash_plugins/fusion/encrypt.py)
uses a zero CBC IV and a freshly generated ephemeral ECDH key per encryption.
The [CashFusion audit, KS-SBCF-F-01](https://electroncash.org/fusionaudit.pdf)
explains why the constant IV depends on avoiding key reuse. OPTN obtains a new,
nonzero scalar from OS randomness in every `encrypt` call, derives the key there,
and authenticates the tag before decrypting. A regression now checks that two
encryptions of the same padded proof produce different ephemeral public keys
and ciphertexts, while both decrypt successfully. All seven encryption tests
and strict Fusion Clippy pass. This is a bounded implementation review, not a
new protocol audit or a claim that the still-open main-branch alerts were closed.

## Source deletion preserves privacy (2026-09-19)

Removing the last explicitly selected source no longer silently switches to
Auto. The shared editor preserves protocol and scope boundaries, removes the
source from explicit primary/fallback pools and preferred ordering, and leaves
an empty permitted pool unavailable until the holder chooses another source.
Twenty network-configuration tests pass, including
configuration serialization/reopen with public bootstrap sources present and
no eligible public fallback. Strict runtime Clippy passes. This fixes the shared
policy used by native adapters; it does not establish all-platform UI evidence.

Source removal now invalidates wallet freshness before editing on every native
platform. Mobile skips desktop-keyring cleanup because it cannot save RPC
credentials; previously that unsupported operation prevented even P2P/Electrum
source deletion. Native source tests (3) and strict native Clippy pass. The local
Android check stopped at a missing NDK clang executable, before application
compilation; the Android CI build remains the cross-target verification gate.

## Cached token identity restart and refresh (2026-09-19)

The authenticated HD checkpoint now retains bounded token presentation metadata.
Restore keeps previously verified names as `Stale`; an old unpublished conclusion
becomes `Unresolved`. Neither restores chain freshness or spend authority. Legacy
checkpoints remain readable. Oversized optional labels are omitted from the cache
rather than preventing balance/history persistence; malformed cached records are
rejected on decode. A failed metadata refresh preserves a known name only as stale;
a current unpublished observation clears it.

The connected selected-route resolver test now runs successful HD sync, actor
checkpoint capture, authenticated seal/open, new actor restore and successful
refresh. It verifies equal coins, stale names and no freshness/spend state after
restore, then verified identity and fresh state only after another accepted sync.
The runtime suite passed 288 tests; the extended refresh regression and strict
all-target runtime Clippy also passed. This is connected synthetic-provider
integration evidence, not a live funded token-node or packaged-device claim.

The built Windows GUI also passed actual source selection, deletion, process
restart and export checks: the deleted single-source pool stays explicitly empty,
with no public fallback. Original isolated test settings were restored and the
owned test process stopped. Build: base `28e02ea0` plus the checkpoint diff;
SHA-256 `0dfc85545176a4301a8ecdda85b96e697dd80af1c0131033286e7cb1a9f3fef7`.

## Native source edits revoke before persistence (2026-09-19)

Every native source/policy/selection/proxy-trust edit and portable import now
revokes published routes and active wallet sync before waiting for the serialized
settings write. It rechecks revocation under the rebuild lock, preventing an old
probe from republishing between cancellation and persistence. Failed writes keep
freshness invalidated. Safety no longer depends on a renderer sending the second
rebuild command. Corrupt persisted network policy also refuses public update
requests instead of falling back to app-state defaults.

Nineteen native chain-runtime tests pass, including a pending shared HD refresh,
a held rebuild lock, successful and failing writer callbacks, and corrupt update
policy refusal. Strict native Clippy and the unchanged architecture gate pass.

## CLI source management parity (2026-09-19)

CLI one-shot commands, wallet navigation and private stdio now expose source
addition, availability changes and removal through the existing shared Rust
network overlay. Removal clears applicable local RPC credentials first, rejects
concurrent endpoint changes, and preserves an empty exact scope rather than Auto.
Invalid dispositions, unknown sources, wrong-network requests and bootstrap
removal are refused. The CLI README documents actual GUI and CLI navigation.

Validation: 105 CLI binary tests and 19 wallet-process tests pass; one real-OS
keyring test remains explicitly ignored in that suite (previously run separately).
Strict all-target CLI Clippy passes. A process regression adds/selects/disables/
enables/removes a source across one-shot, private stdio and prompt interfaces,
then proves a new process retains the empty selection without public fallback.
The Windows GUI selection/delete/restart test also passes on `7984e8ae` after
native route-revocation wiring; isolated settings were restored and the app stopped.

## Android packaged source selection (2026-09-19)

Built the Rust Leptos/Tauri ARM64 debug APK from `7984e8ae`, installed it on
an isolated Android 36 emulator, and opened its landing page. Through the GUI,
imported and encrypted a published public Chipnet watch-only account, added a
disposable source, selected it with Electrum only and no fallback, and removed it.
The exported policy retained an empty explicit primary scope. Force-stopping and
relaunching the APK, then unlocking the wallet, preserved exactly that policy.
Mobile deletion no longer fails on an unavailable desktop credential store.

APK SHA-256: `a8f59b8a055024cc041c529ebbb5ff3247fd3f1275fd3794d44956ad35489974`.
The signature verifies and the embedded ARM64 native library matches the compiled
output byte-for-byte. This validates packaged launch, encrypted watch-only reopen
and source-selection persistence, not SeedCash signing or all-platform parity.

The same APK subsequently completed live Chipnet HD sync via the selected
`chipnet.imaginary.cash:50002` route through an existing local Tor proxy:
39,774 sats, one UTXO, two history entries, tip 324159. After removing the proxy
forward and restarting the process, encrypted unlock restored exactly those
values as **Saved balance / refresh needed**, without freshness. Restoring the
proxy, using **Retry connections**, then **Refresh wallet** accepted tip 324160
with the same balance/history. No signing or broadcast was performed. This is
packaged Android BCH selection/sync/restart/resume evidence; token metadata,
SeedCash signing and other platform workflows retain their separate gaps.

## Network navigation and evidence (2026-09-19)

Rust source views now separate catalog capability claims, registered backend
claims and endpoint protocol status. Confidence and provenance are projected
without executing a provider; a counting-backend regression proves zero calls
and revocation clears registered observations. Route eligibility is not promoted
to verified capability evidence. Same-host service additions refuse conflicting
ownership/group declarations rather than silently changing direct-dial permissions.

Leptos provides separate overview, public/own/custom source directories, source
details, routing, privacy/transport, explorer, backup and two-stage manual service
setup views. ZMQ is an event-source choice. Capability details work by keyboard
and tap. Public cards have no removal action. Narrow desktop windows collapse
the sidebar to bottom navigation without changing platform capabilities.

Actual isolated Windows GUI checks passed directory search, public ban/navigation,
absence of public removal, user source add/remove, distinct routing/privacy/
explorer controls, ZMQ separation, restored settings and a 390px viewport without
horizontal overflow. Native strict Clippy, WASM strict Clippy, stylesheet checks,
source projection tests and the unchanged architecture gate pass. A rebuilt
Windows GUI also passed BIP37/compact-filter choice navigation and preference
addition/removal followed by Save selection, restoring the original configuration.
See `docs/ui-overhaul/NETWORK-SOURCES.md` for the product contract.

Automatic service discovery, arbitrary transport-policy editing, authenticated
remote catalog updates and full packaged renderer parity are not established by
this batch. Setup explicitly labels manual configuration. Previously linked
APK/macOS artifacts predate this navigation change.

The retained React settings now use the existing release UI components for
separate directories, details, routing, transport and explorer views. The explorer
view reuses the original controls. Advanced selections carry the viewed network
explicitly to the existing Rust command. A component interaction test covers
read-only browsing, advertised/verified protocol filtering, bootstrap removal
absence, ZMQ separation, preference removal and exact selection submission.
Bridge/hint tests (7), component test (1), full TypeScript check and targeted lint
pass. These are adapter tests, not packaged React wallet end-to-end evidence.
The user rejected the replacement Leptos visual shell; interaction checks above
do not satisfy visual parity with the pinned main-release design.

### 2026-09-26: selected BCMR indexer byte adapter

`BcmrIndexerHttps` is a persisted metadata endpoint, not a wallet sync protocol.
The native stack shared by CLI and GUI derives permitted indexer origins from the
same scope, fallback, ordering and bans as other configured metadata endpoints.
The retained UI exposes **Network sources → Metadata & indexing → Add BCMR
indexer**; Leptos and CLI accept `bcmr-indexer` through their existing add-source
contracts. Opening the directory performs no provider probes. No public indexer
is injected into the user's settings automatically.

After local authchain resolution, publisher URIs are tried first, followed by up
to three selected indexer candidates at `/api/registries/<category>/latest/`.
This uses the [Paytaca-compatible API](https://github.com/paytaca/bcmr-indexer#api-endpoints).
Verified Tor with remote DNS, HTTPS, same-origin indexer redirects, the existing
20-second work deadline and aggregate 2 MiB accepted-body budget remain enforced.
An indexer supplies untrusted bytes only: missing chain evidence remains unresolved,
and the exact response bytes must match the locally established publication hash.
Reserialized/normalized JSON can fail that hash even if the fields look identical;
this adapter deliberately does not bypass the commitment. Arbitrary base paths,
cleartext/LAN indexers, external authchain truth and general token-index queries
are not implemented by this endpoint.

Evidence: selected-source persistence/reopen and boundary tests; connected HD sync
accepts matching indexer bytes into Assets and restores them stale after restart,
rejects wrong hashes and refuses to query when spentness cannot be established.
These are synthetic integration tests, not a claim of live Paytaca token acceptance.
SHV/MMR implementation and its existing reference/live proof evidence are unchanged.

### 2026-09-26: metadata bootstrap and passive Network directory

The maintained Rust catalog now supplies `bcmr.paytaca.com` for Mainnet and
`bcmr-chipnet.paytaca.com` for Chipnet, using Paytaca's pinned deployment examples
as provenance. Both origins responded to bounded HTTPS checks. `ipfs.io` supplies
an optional content gateway on both networks; it is network-independent and
returned bytes still require the chain publication commitment. These entries are
unverified hints, with stable IDs, shared by GUI and CLI. Catalog updates preserve
saved bans, exact selections and own-infrastructure boundaries. Unsupported
networks do not inherit Mainnet metadata services. No user overlay is rewritten.

`optn_chain_sources` no longer waits for Tor SOCKS probing on every open/poll.
It projects the installed stack's last observation, or unknown while unavailable
or revoked. Active readiness checks and route construction still verify Tor.
The old UI shows BCMR/IPFS entries before unavailable adapters, with source details
and the usual bootstrap enable/disable/ban controls. Opening this directory
does not contact providers. Packaged Windows measurements changed from 4.6 seconds
to 10 ms for Mainnet and 5 ms for Chipnet. Both catalogs returned their correct
BCMR origin and non-removable bootstrap status. All five saved wallets remained
visible after the normal-profile relaunch.

Validation: all 294 runtime tests, 19 native runtime tests
(including reading status during blocked sync), four source-view tests, 25 native
chain tests, retained UI interaction test, TypeScript, strict Rust Clippy and
architecture gate, CLI native check and Leptos WASM check. Two existing catalog tests were updated to count chain routes
separately from metadata entries. General TokenIndex/Chaingraph query adapters and
metadata proxy/cache remain unavailable; adding a hostname would not implement
those APIs. No live Paytaca token-identity acceptance is claimed.

### 2026-09-26: BCMR publication acceptance corrections

Rust now treats the first BCMR-prefix output as definitive even when malformed,
so a later output cannot substitute a different registry. HTTPS authorities
without paths use the specified well-known path, preserving query/fragment
suffixes and explicit paths. Hash-only publications may accept bytes from an
already permitted candidate provider, subject to the same exact SHA-256 check.

Validation: 13 core BCMR tests, 25 runtime metadata tests, eight native registry
fetcher tests, the connected HD metadata/checkpoint/reopen test, strict core and
runtime/native-chain Clippy, regenerated WASM/freshness check, and 21 existing
WASM signing/connector tests passed. This is bounded protocol and integration
evidence; retained React Assets migration, broader authchain discovery and live
token metadata acceptance remain separate work.

### 2026-09-26: BCMR discovery and retained Assets projection

Token categories are display-order identifiers; chain requests and transaction
inputs use internal hash order. The runtime now converts at the authchain entry
boundary. The HD integration fixture uses a non-palindromic, correctly encoded
category, correcting a fixture that had repeated the original byte-order bug.

The shared router executes `OutpointSpenderLookup`. Electrum derives candidates
from UTXO creators, then height-filtered history/mempool, deduplicating downloads
and checking raw transaction hashes and exact inputs. Work is capped at 128
transactions, 2 MiB of raw transactions and 20 seconds. An empty, incomplete or
timed-out search is unknown, never an unspent authhead. Existing scopes, protocol
restrictions, fallback and transport policy still govern every route. The runtime
refetches discovered successors from the selected validating node and still
requires source-bound full-node terminal unspent evidence. This closes discovery
outside wallet history; it does not establish Electrum-only identity acceptance.

Authenticated descriptions, URI references and bounded NFT schema data now cross
core, application state, encrypted checkpoint/reopen and typed transport. The old
desktop Assets and token details consume wallet/network/epoch-bound runtime
snapshots and preserve verified/stale/unpublished/unresolved labels. Legacy cached
names cannot override these statuses. Opening token details no longer directly
queries Chaingraph on desktop. URI references do not grant network permission:
images remain placeholders pending a policy-aware image-byte adapter. Non-desktop
legacy metadata behavior is retained, so cross-platform migration is not complete.

Evidence: 18 core BCMR, 173 app, 300 runtime, 23 transport and 22 Electrum adapter
tests; 74 focused TypeScript and 25 desktop UI tests; TypeScript, strict Rust
Clippy, architecture, native host check, regenerated WASM/freshness and 21 WASM
connector tests passed. The connected HD actor test discovers transactions absent
from wallet history, publishes identity, seals/reopens it stale, then refreshes it;
missing terminal evidence remains unresolved. These are integration/component
checks, not live token acceptance. ISO8601 snapshot-time selection, full public
light-client authchain acceptance, policy-aware icons, global index queries and
packaged live token rendering remain open.

### 2026-09-26: Current BCMR snapshots and packaged inspection

Core now validates BCMR's exact UTC/calendar timestamps and selects the latest
reached snapshot, or the earliest when all timestamps are in the future, using
the runtime's supplied wall clock. Selection is confined to the authenticated
category's identity history and precedes token-field validation. A withdrawn or
invalid current token definition cannot revive an older definition or another
identity's claims. Fresh hash-verified registry bytes supersede cached names;
fetch/hash failures still retain explicitly stale metadata. The earlier ISO8601
gap is closed. Validation: 22 core BCMR and 302 runtime tests, strict Clippy,
formatting, architecture, native host check, regenerated WASM/freshness and 21
WASM connector tests passed. This also fixes the discovery-block formatting
failure reported by CI at `8399f9cc`.

The Windows desktop package at `8399f9cc` used the desktop frontend configuration
and normal wallet profile. Its picker retained all five saved wallets. Normal
unlock of Chipnet wallet #2 displayed the cached balance/history; Assets had zero
token categories, so this is not live token-metadata evidence. Network -> Nostr
contained profile/name/publish/relay-check controls, no duplicate top-level
Nostr settings entry, and Back returned to Network. No profile was published.
Live shared sync initially had no route because an orphaned inspection Tor
process occupied the integrated port. After closing that verified orphan and
starting app-owned Tor, the unchanged policy exposed four eligible routes.
Full public light-client authchain acceptance, policy-aware icons, global index
queries and live token acceptance remain open.

### 2026-09-26: Covered-address refresh and send holds

The retained wallet refresh now replaces every returned address result, including
empty results, while preserving omitted addresses. The former address-count
heuristic discarded changed/empty results on a narrower refresh. Regression cases
failed against that implementation; all 32 refresh/UTXO checks now pass.

Retained desktop sends now read Rust's durable coin holds at review/Max and again
before handoff. Manual coin selection cannot reintroduce held coins. The broadcast
adapter decodes actual inputs through the existing Rust transaction decoder in
WASM, so omitted caller input metadata cannot bypass the check. Wallet/network/
session changes invalidate reviews, and unreadable hold records fail closed. The
native spend builder also propagates hold-read errors and requires a wallet ID.
This is a repair to the existing desktop hold capability; non-desktop support is
unchanged, and this does not establish an atomic cross-process spend reservation.

Validation: 45 send/binding/UI checks, 21 WASM connector/Fusion regressions, two
native spend tests, TypeScript, formatting, ESLint, native and WASM strict Clippy,
generated-WASM freshness and architecture checks passed. No funds were spent.

Live Chipnet sync in the earlier `8399f9cc` desktop package reached tip 325177
through the saved Tor/source policy and reported 15,529,363 confirmed sats. The
retained Home showed 49,896,199 sats. These are different projections, not proof
that either total covers the entire wallet: legacy issued-address horizons are not
imported, RPA receipts and tracked contracts are not persisted in the shared HD
checkpoint, and HD discovery rejects non-HD scripts. Whole-wallet balance
replacement remains blocked on a union of those scopes with durable coverage.

The `4f76c047` Windows desktop package was built with `vite.desktop.config.ts`
and the normal `com.optilabs.wallet` profile. Both launches retained all five
saved wallets; ordinary empty-password unlock of the previously tested Chipnet
wallet restored its cached Home history/balance. Diagnostics also retained the
shared 15,529,363-sat checkpoint and marked it stale after route reconstruction.
No token categories were present. The executable's SHA-256 is
`0cbafee7f45b8a4b8fa06d2faa28ef5f651f1d2f365335d9c5db0f8b1e8c4e9e`.
An actual graceful-exit check verified that only this app's owned Tor child exited
with the wallet and SOCKS port 9251 was released; the wallet was then reopened.
This verifies the earlier Tor-exit fix in a running package, not just unit tests.

### 2026-09-26: retained public HD inventory reaches shared discovery

`ImportHdInventory` now accepts at most one public high-water address for each
ordinary branch (0, 1, 7, 2). Rust checks the current session/account and derives
each supplied address from that account before atomically reserving its range.
The sealed allocation stores these ranges across restart; imported inventory
does not assert transaction history, fresh balance, or a new current receive
address. Discovery covers the retained range plus its gap within the existing
10,000-address hard bound. Expanding the range cancels older sync/spend work.

The retained desktop password-open/create bridge reads only public derivation
columns and submits this request. Storage/ownership failures are visible and do
not erase the already unlocked legacy wallet. CLI stdio accepts the same request;
the prompt exposes `inventory <account-path> <public-addresses JSON>`.

Evidence: the connected actor test finds funds beyond the default 200-address
budget, persists/reopens before and after expanded sync, preserves cached funds
as stale, rejects foreign/stale input and failed writes, and cancels older work.
The actual CLI process verifies import and restart. Core watch-only (17), app
(173), runtime (303), transport (23), and desktop bridge/metadata/UTXO (50) tests
passed, as did TypeScript, strict core/runtime/CLI/native Clippy, architecture,
WASM freshness and nine generated-WASM signing tests. These are automated
integration checks, not yet a packaged/live legacy-wallet migration result.

Biometric/file/seed import sibling handoffs now reuse the same bridge, retain
auto-lock settings, and surface failures without undoing an already successful
unlock/import. Affected bootstrap calls retain the selected account index.
Validation: 81 adapter/onboarding tests and the combined TypeScript check passed;
no physical biometric-device acceptance is claimed. RPA receipts, tracked
contracts and multiple-account inventory remain outside this HD-only migration.
Whole-wallet scalar replacement remains blocked on their durable union; this
change does not close #75.

The subsequent live scan traced the timeout to repeated HD inventory queries:
2,780 interests took about 175 seconds on the permitted Electrum route, then a
second complete query was needed for the trailing gap and exceeded the native
300-second deadline. Initial derivation took 14 seconds and headers 4 seconds.
Rust now includes that gap in the first query after each durable issued horizon.
It does not extend from the previous scan length or infer used addresses from
the imported inventory. The regression proves a single expanded query after
reopen and stable scope on later refreshes, including normal receive allocation.
All 303 runtime tests, strict Clippy, formatting, architecture and native build
passed. The retained Windows UI then completed a live Chipnet scan with
49,896,199 sats and 121 history entries, both freshness flags true, no error and
tip 325188. After a full process restart, normal saved-wallet unlock restored
the same balance/history as stale. A second live refresh restored freshness at
tip 325189 with unchanged totals. Both completed within the existing 300-second
deadline through Auto routing and the existing Tor policy; no transaction was
signed or broadcast. The selected Electrum route was
`bootstrap:electrum-tls:blackie.c3-soft.com:64002` with **Server assertion** evidence,
not SHV/MMR proof.

Build provenance: `fee6bff3` plus the production gap fix committed as `cf16e8c5`,
without tracing; executable SHA-256
`f892f9de91a6b7a30c3ea91c86c39c8200308c4a6b6a168c3a802ca96d88e0e4`.
Local evidence: `hd-gap-live-cf16e8c5.json`, `hd-reopen-cf16e8c5.json` and
`hd-resume-cf16e8c5.json` under the outside-Git `old-ui-network-20260919` artifacts.
This closes the measured saved-wallet HD timeout/reopen/resume gap. Matching
this wallet's legacy total does not prove the outstanding RPA/contract or
multiple-account union, every platform, or all of #75.

Linux Desktop E2E run `36267842277` passed on exact head `86f8407b`, including
the isolated create/lock/reopen case. CLI CI exposed a stale four-address
expectation after the HD fix: receive index zero was already issued, so the
initial query also needs receive index one. The real CLI process test now checks
the exact five script hashes across receive, change, DeFi and compatibility
branches. All 20 ordinary CLI wallet-security tests pass; the existing real-OS
credential-store test remains explicitly opt-in.

### 2026-09-26: default-on Chat and automatic native relay health

The retained UI no longer has a Chat enable switch or persisted enable flag.
The Chat route still requires an open wallet. Desktop wallet-open and Network ->
Nostr now request automatic reachability checks, refreshed every 30 seconds with
a bounded native cache; users can also explicitly recheck. Native Rust validates
the entire supplied WSS pool, applies the public-source boundary and trusted Tor
requirement, and performs only TLS/WebSocket handshake and close. It sends no
Nostr identity, subscription, profile, or message. Network/session/policy changes
cancel stale probes and invalidate cached results. Blocked checks remain unknown
rather than incorrectly marking the relay unreachable.

Validation: seven native tests cover URL limits, policy/transport refusal, cache
scope/coalescing, cancellation and an in-memory handshake that sends only Close.
Nineteen Redux/SSR/UI tests cover retired settings, wallet gating, automatic
checks/timer cleanup, stale replies, relay edits and explicit profile actions.
Combined TypeScript, scoped ESLint/formatting, strict native Clippy and the
desktop package build passed. The `21780bfe` Windows package retained all five
saved wallets. Ordinary unlock restored the cached Chipnet Home balance/history;
the runtime accepted 1,370-address horizons on both receive and change branches.
Opening Network -> Nostr displayed **26/30 reachable at last check** immediately,
without pressing Check relays. The enable switch was absent and no profile or
message was published. Its executable SHA-256 is
`30aa226f78419aa49a4b250628c50fd8e4161cda6d6cee41283539a99675a2fd`.
This is live native relay-health evidence, not completion of wallet-wide sync.
Chat/profile traffic itself still uses the legacy transport; owned-relay
classification and non-desktop native health remain separate gaps.

Semgrep on this head reported plaintext URLs in the new negative/loopback tests.
The fixture now models the established stream in memory without a plaintext
listener, and plaintext rejection remains tested by changing a parsed URL's
scheme. All seven native tests and strict Clippy passed again. No finding was
dismissed, no scan rule was suppressed, and no production transport was relaxed.
The Linux E2E run stopped at the Tor bundle download timeout before app testing;
the next push will rerun that gate.

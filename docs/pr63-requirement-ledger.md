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
| 14 | CashFusion uses the shared chain observation layer | **PROVEN** (component) | A round checks its own and its peers' inputs through `optn_fusion::lookup::InputLookups`, implemented once by `optn_fusion_native::lookups::ChainInputLookups` over `optn-chain-electrum` (`ElectrumBackend::script_unspent_values`), on connections of the round's own and only through the verified Tor proxy for remote servers. The desktop and the CLI both use it; `electrum_input.rs` is deleted. A live round on the native host is still to run (needs Tor and a server) | Rounds are driven natively for the CLI and the docker runner (`optn-fusion-native::server_round`). The desktop still drives its rounds from `Fusion*.ts` for wallets whose keys live in the TypeScript key database, and P2P rounds (Nostr) have no Rust driver yet |
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
| Header checkpoint persistence | **PROVEN** (runtime/GUI/CLI integration tests; live local P2P runtime/CLI restart) | Guarded wallet/header checkpoint publication; shared `with_stored_header_progress`; native `accepted_chain` restores a sealed view after wallet open. `optn-cli/tests/shv_regtest.rs` reopens an encrypted HD wallet against two peered real nodes, preserving balance/history and the accepted MMR commitment | Packaged GUI P2P restart and public-network scale remain separate from the local runtime/CLI result |
| Authenticated historical replay | **PROVEN** (connected runtime and live local P2P) | `sync_worker::historical` authenticates a starting header against the runtime's saved MMR root, then recovers linked hashes through the accepted tip on the same selected route. Ordinary peers retain authenticated genesis replay. Real-node encrypted reopen, prune/recover and CLI source switching are covered by `shv_regtest` | Normal HD refresh still rechecks its configured floor. Ordinary peers retain the hash index and may need genesis replay after process restart; this is not constant-memory full-chain synchronization |
| SHV P2P root/peak proofs | **PROVEN** | `optn-chain-bip37/src/shv.rs`; live against BCHN `e6d380373` with `-mmrindex=1`, proof accepted only against OPTN's own root | — |
| BCHD-correct compact filters | **PROVEN** | `optn-chain-neutrino/src/filter.rs`; live BCHD scan agrees with the Bloom path on the same coins | Independent BCHD-produced filter fixtures not yet vendored |
| Sequential receive → spend lifecycle | **PROVEN** | `a_spend_is_found_through_an_outpoint_the_receive_scan_discovered`; spend invisible to a script-only scan | CashTokens/NFT/OP_RETURN/reorg/restart cases not covered |
| Manual rescan, encrypted restart, GUI/CLI routing | **PROVEN** (runtime/CLI; bounded Windows GUI refresh/reopen) | `request_wallet_rescan`, encrypted checkpoints, Settings `rescan_wallet_from`, CLI `rescan --from-height`; CLI live floor checks and Windows GUI offline restart/online resume on 2026-09-19 | GUI custom-height interaction and current Android/macOS packages still need separate verification; normal HD refresh rechecks the configured floor, not only a suffix |
| Wallet birthday | **PARTIAL** (durable imported hints connected) | Shared `SetBirthday`/`ClearRescan`, sealed checkpoint, atomic `BeginHd` floor resolution; CLI process restart and Windows GUI height/date reopen and manual-override clearing verified on 2026-09-19. Unknown imports explicitly scan from genesis; missing authenticated date evidence fails closed; legacy manual floors migrate | Automatic same-route header acquisition is connected and tested; requests retain their runtime generation across header I/O. Host-generated creation-anchor capture, restored historical-date evidence and live date acquisition remain to verify. Imported mnemonic input is never treated as proof of fresh wallet creation |
| Local BCMR / authchain | **PARTIAL** | HD sync invokes selected transaction/spentness routes, bounded registry retrieval and guarded identity publication. Electrum routes resolve at a labelled server-reported assurance; burned heads and quiet heads follow the 2026-10-08 entry; Moria USD and Furu resolve live on mainnet through public Fulcrum | Packaged GUI rendering of a live token is not yet observed. The web/Android React app still resolves through its legacy TypeScript path |
| Token capability execution | **INTEGRATION** | `optn-runtime/src/token_capability.rs`; refuses global totals from partial data | Planner and executor exist; no provider adapter routes through them |
| Broadcast lifecycle | **PARTIAL** | `optn-runtime/src/tx_broadcast.rs`; retained desktop `TransactionManager` now submits signed bytes through the authenticated native command | Desktop single-account Send/CashTokens has guarded submission and preserves ambiguous outbox records. Durable shared outbox, uncovered contract/RPA/multisig inputs, and the other submission paths still need integration; see 2026-09-27 evidence below |

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
| CashFusion | **PARTIAL** | Protocol in `crates/optn-fusion`; coin selection, tier planning and the depth record in Rust (`optn_core::fusion::{coin_selection, depth}`, `optn_fusion::allocate`), reached by the desktop through the WASM core and Tauri commands; native server-round host `crates/optn-fusion-native`, used by `optn fusion` and the docker runner | Released; reported working on chipnet and mainnet. Remaining: a Rust P2P (Nostr) round driver, moving the desktop's renderer driver onto the native host once its wallets are runtime-managed, and a Leptos fusion screen |
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
An earlier Linux E2E attempt stopped during Tor bundle download. The later
exact-head `86f8407b` run passed Tor setup and both desktop E2E stages above.

### 2026-09-26: durable BCMR authhead hints and managed-wallet reopen

The shared runtime now stores bounded authbase-to-head raw links and committed
registry bytes inside the existing encrypted wallet checkpoint. Limits remain
32 owned categories, 64 chain entries and a 2 MiB aggregate payload budget.
Records bind to network, selected source and endpoint. They confer no current
authority: resume fetches the head through the selected node and checks current
full-node terminal unspent evidence, exact outpoint/value/script and accepted
tip before using committed registry bytes. Registry snapshots are reparsed at
the current checked wall clock. Old checkpoint versions remain readable.

Transient failure retains only stale hints; invalid evidence, burned identity,
revocation and publication withdrawal cannot resurrect an old publication.
Saving receive allocation, birthday, annotations or air-gap reservations preserves
the private cache. The connected managed-wallet test also exposed and fixed
`WalletSecurity::open` discarding saved token presentation while recapturing a
checkpoint: names now reopen as stale alongside the coins.

Evidence: all 319 runtime tests, strict runtime/CLI Clippy, CLI/native checks,
architecture, formatting and a native desktop build passed. The actual managed
storage test syncs a token identity, freezes a coin, allocates receive, locks,
opens through a new runtime/storage instance, then revalidates with a fresh
provider service that has no registry fetcher. This proves persisted reuse and
current-authority checks through the shared wallet path. It is synthetic-node
integration evidence, not live public-token or packaged token-rendering proof.
Electrum assertions and transaction inclusion proofs alone still cannot establish
terminal unspentness; the existing full-node evidence requirement remains.

### 2026-09-26: remaining review findings and authenticated spend ownership

`eab6b58a` includes updater archives and detached signatures in release assembly.
The regression executes the workflow's actual Bash against ten fixtures across
all five desktop targets and checks their filenames and bytes: three artifacts
were copied before the fix, all ten afterward. All 52 workflow tests pass.
No platform, packaging dependency or completeness gate was removed.

`eaacf6ce` requires the complete predecessor cursor for resumed BIP37 header
walks before transport lookup or I/O. Genesis uses its known timestamp, including
compatibility with the old `(0, 0)` request. Ten native header tests cover missing
and contradictory cursors, refusal before connection and resumed ASERT acceptance
and rejection. Difficulty and proof-of-work checks remain enabled.

`0957fe5b` removes renderer-chosen hold-file ownership from native prepare/send.
The authenticated runtime record supplies the legacy owner, preserved across
password migration and checked against the unlock epoch and synchronized account.
Unreadable holds or missing/ambiguous ownership refuse the spend. Holds are read
again after authorization and before broadcast; runtime coin freezes also apply.
The connected runtime test switches two stored wallets and locks to verify that
ownership cannot follow a stale session. Shared signing paths now use the scanned
address's complete derivation path, preserving branches 0, 1, 7 and 2 and nondefault
accounts instead of interpreting every non-change branch as receive.

All 321 runtime tests, three native spend tests, strict native/runtime/CLI Clippy,
TypeScript and architecture checks passed. Retained UI hold, transaction-service,
biometric and file-import tests pass. The first ad-hoc combined run used Vitest's
5-second default and timed out on its first cold TransactionService import; its
isolated rerun passed all 21 tests without changes or a timeout increase.
`cb196b7c` limits wallet-open failures to fixed adapter stage labels; all 36 bridge
tests include native diagnostic leakage cases and pass with scoped ESLint.

All eight previously unresolved review threads were answered with evidence and
resolved after the fixes were pushed. The PR-scoped open code-scanning query was
empty at head `0957fe5b`; that revision's new scans and platform jobs were still
queued/running. This is not full CI clearance, packaged spending evidence or
completion of the separate durable proposal/outbox and wallet-scope union work.

### 2026-09-27: automatic shared refresh and guarded retained-UI submission

The retained desktop Send/CashTokens path reached CashScript's independent
Electrum client through `TransactionManager`, bypassing the shared route policy.
It now sends the exact reviewed signed bytes through `optn_wallet_broadcast`.
Rust binds the request to the authenticated wallet, network and unlock epoch,
requires every input in the fresh owned coin set, and checks durable holds again
after acquiring the current selected service. It neither rebuilds nor signs.
Unsupported ownership scopes refuse submission without a legacy-network fallback.

The runtime retains cancellation across coalesced state updates and across the
entire native hold-file mutation, including failed writes. Pending setup is
cancelled on wallet/route changes; cancellation after possible handoff preserves
the transaction id and an uncertain outcome. An ambiguous provider attempt stops
broadcast failover. Deterministic rejection/unsupported-route handling and query
failover remain intact. The retained outbox stores the Rust-decoded input outpoints
before handoff, keeps uncertain records reserved, and binds retries to their saved
wallet id. This does not yet move that renderer-owned outbox into Rust storage.

`WalletRefresh` now schedules the existing shared HD/checkpoint/BCMR workflow on
wallet open and periodically in both the native host and persistent CLI. Manual
and automatic requests share one gate; a busy adapter does not invalidate fresh
coins. Failures use bounded 5/10/20/40/60-second retries. Lock/context changes cancel
pending setup and scans. CLI source/credential changes pause setup before waiting
for the gate, then keep it paused throughout persistence. Native acquisition checks
the installed network, current saved selection, generation and credentials even
before its selection worker reacts. CLI EOF/input errors release the refresh
owner and stop the dedicated driver. No renderer timer or new dependency was added.

Validation: 341 shared runtime tests; 49 retained transaction/tracker/reconciler
tests; five CLI wallet-security unit tests; both native automatic-refresh and
installed-context regression tests; TypeScript, scoped lint/format and architecture
checks pass. Strict runtime/native/CLI Clippy and the retained desktop production
bundle also pass. The native automatic test reaches the real HD adapter with its header
prerequisite and verifies lock cancellation. The CLI test uses its real dedicated
driver and proves source-override refusal and shutdown. These are component and
adapter proofs, not a live positive GUI send or new packaged-platform completion.

The current submission scope is one authenticated HD account. Contracts, RPA and
multisig inputs need authenticated coverage before admission; hardware/watch-only
submission additionally needs the corresponding managed runtime record. The legacy
whole-wallet Home balance remains separate because durable HD/RPA/contract union is
unfinished. One-shot CLI token projection was subsequently connected below; shared durable
outbox/reconciliation, CashFusion orchestration and complete-category indexer
execution remain open connections.

### 2026-09-30: one-shot CLI Tokens uses the shared HD workflow

At `6819c3ed`, `optn tokens` uses the same account acquisition, configured route,
header restoration, HD discovery and encrypted checkpoint publication as Rescan
and History. It reads accepted runtime coins and derives reported paths from the
accepted HD address book. Saved nondefault accounts and HD watch-only records no
longer fall through the legacy default-account seed path. Legacy credential input
precedence remains unchanged for callers without a managed wallet.

The existing JSON balances retain decimal `u128` totals and NFT details. Additive
source, evidence and coverage fields identify the scanned HD scope; they do not
claim global supply, RPA or contract coverage. Route, timeout, stale-state and
persistence failures return errors rather than cached or legacy-network success.
The documented 300-second default covers the whole HD pass; explicit timeouts
remain exact. `--gap` now means history-driven discovery rather than a fixed
receive/change prefix.

Application integration evidence: the real CLI with a loopback provider covers
saved account 1, watch-only and legacy credentials, tokens beyond the old prefix,
branches 0/1/7/2, totals wider than `u64`, NFT paths, Rescan/History consistency,
encrypted restart and failed-route refusal. The slice passed 107 CLI unit tests
and 22 wallet-security integration tests (one OS credential-store test ignored).
After integrating `dev`, both connected Tokens tests and strict CLI Clippy pass.
The merged runtime also passes 87 wallet tests and strict Clippy. These are
deterministic application tests, not new live token or packaged-device evidence.

PR63 conflict resolution at `883ca9cc` retains the full desktop package matrix,
mobile/extension/RISC-V gates and the newer `dev` wallet fixes. At `a1816267`, all
six full Cargo dependency graphs resolve; native/core dependency audits pass
with existing unmaintained-dependency warnings. Ninety-two focused retained-UI,
signing, minting and release checks pass, and the Rust WASM is regenerated and
freshness-checked. Checkpoint test nonces use OS randomness and missing biometric
credentials are explicitly refused with regression coverage. Remote scans and
platform builds must still succeed for the pushed revision; no security alerts
were dismissed in this continuation.

### 2026-10-07: x402 BCH Rust SDK integration draft on dev

The `feat/cli-x402-bch-sdk` branch starts at merged `dev` revision
`c45be9b70a87198a08fea2c0ad1dc79b8c812d39`. It depends on
[OPTNLabs/x402-bch#2](https://github.com/OPTNLabs/x402-bch/pull/2), currently pinned
to its immutable source revision `a6e50946f95ce6e65bb3d08071eb49584786fba9`.
Merge the SDK PR first, move the dependency and locks to the upstream merged
revision, then complete review/checks before merging this wallet PR into `dev`.

For #71/#83, protocol encoding sits in `optn-x402`; native HTTP sits in the CLI;
shared runtime owns authorization, HD change, signing, bounded durable outbox and
input reservations. The same reconciled spendable-coin extractor now serves the
native GUI and this runtime flow. Signed transaction import receives independent
core signature/value validation and SDK verification. Raw signed bytes never enter
the renderer/add-on `WireState`. For #75, chain data comes from shared selected
sources; SDK source access is an immutable snapshot, and merchant HTTP uses the
existing outbound/Tor policy without redirects or implicit proxy/public fallback.

Windows local evidence: 979 shared core/application/runtime/transport tests,
149 CLI tests (two opt-in live/credential-store tests ignored), three SDK tests,
and two native storage tests pass. The CLI test covers a lost HTTP response,
identical-byte retry, held-input refusal, changed quote refusal and signed import.
Four runtime tests cover encrypted restart, CAS/storage failure, signature/fee
validation, watch-only import and legacy-wallet refusal. Windows CLI binaries
reserve a 4 MiB stack to prevent the debug HTTP/signing flow overflowing the
default 1 MiB stack; the complete CLI suite passes in a fresh build directory.

Strict Clippy passes for affected shared crates, CLI, SDK adapter and desktop
library. Rust formatting, architecture, TypeScript core typecheck/lint,
dependency policy, six security tests, addon validation, 21 connector tests and
the generated WASM rebuild/freshness checks pass. Repository formatting passes
after normalizing this Windows checkout to the committed LF line endings.
The broader core suite has 1,928 passing tests; its one Windows Bash process
timeout in the unchanged release-assembly fixture passes on a focused rerun.
All 49 UI tests pass. The lockfile fixture now covers the new SDK adapter.
Remote scans and packaged/cross-target CI remain pending. This draft is not
merge-ready and includes no live-network or mainnet spend proof.

The scope is native BCH from runtime-managed HD saved wallets, plus finalized
P2PKH import (including watch-only). Migrated desktop wallets, token/RPA/contract/
multisig spending and the common lifecycle for other signing commands remain
unfinished. Legacy CLI signing is refused after this outbox exists, and a CLI
session lease serializes access to that wallet directory. Reservations never expire
on HTTP success or timeout; there is no automatic cancellation/pruning, and the
outbox is capped at 256 records / 8 MiB. Server receipts are reported as claims,
not chain confirmation. The earlier shared outbox/reconciliation gap remains open
for those other surfaces and retirement behavior.

PR #105 continuation: the initial Linux desktop jobs failed while fetching
deleted AppImage plugin assets, before compiling wallet code. Both architectures
now pin the versioned upstream `1-alpha-20250213-1` release rather than assets
from its replaceable continuous release. Both downloaded binaries match the
committed SHA256 values, and all 52 release-workflow regression tests pass.
The checksum enforcement and full package matrix remain intact. This is the
same packaging repair already proposed independently in
PR #103; it does not import that PR's wallet-sync changes. Full remote builds and
security gates must pass for the new head before readiness is reported.

The next PR #105 CI run exposed a standalone-core Clippy error and missing
`ExternalPayment` handling in the Leptos coin row. Hex decoding now uses typed
two-byte chunks after its existing even-length guard. The coin row labels
payment reservations and consults the shared `is_user_reversible` policy before
offering unfreeze. The policy regression includes external-payment holds.
All 438 core tests, strict standalone-core Clippy, both browser and Tauri WASM
frontend checks, and the architecture boundary check pass locally. The core
WASM was rebuilt and freshness-checked; all 21 connector/BCH VM tests pass.
This resolves the source errors seen in desktop, iOS, Android and architecture
jobs; complete packaged-platform validation remains a remote CI requirement.

The dependency-audit and supply-chain gates also found
[GHSA-rvm3-566m-v7fv](https://github.com/advisories/GHSA-rvm3-566m-v7fv) in the
inherited Capacitor Android/iOS 7.4.2 dependencies. Android, iOS, core and CLI now
resolve to the patched 7.6.9 release. The Android Gradle compatibility patch was
regenerated for that release, retaining the existing settings and omitting old
generated build-cache entries. A clean locked install applies all patches;
the production dependency audit reports zero vulnerabilities. Dependency and
direct-license policy, core TypeScript typecheck, production web build and all
six security tests pass locally. Existing development-only audit and transitive
license-metadata warnings remain visible; no audit threshold or gate changed.
Android/iOS package and device evidence still depends on their respective CI
jobs, and the SDK PR #2 remains unmerged at this validation point.

The full-graph audit subsequently reached the development dependencies. Its
`source-map-js` finding (GHSA-68fv-2mgg-jv7q) is fixed by updating the single
locked package from 1.2.1 to the upstream 1.2.2 release. Dependency policy,
TypeScript core typecheck, production web build and all 49 UI tests pass; the
production audit still reports zero vulnerabilities.

The full audit remains red: all 13 high-severity entries trace to
`braces@3.0.3` (GHSA-vfj7-8cjw-p6xm) through existing development tools.
As checked on 2026-10-07, npm has no patched braces release and upstream
micromatch/braces PRs #78 and #79 remain open. The audit exit code is still 1;
no finding is suppressed and no threshold changed. This is an additional
merge blocker alongside the unmerged SDK dependency and required review.
The source-map update does not constitute full-audit or merge-readiness proof.

Further PR #105 dependency repair on 2026-10-07: the development `braces`
consumers now use the exact published MIT backport
`@dieub/braces-depth-guard@3.0.3-pn.3`. It is a third-party release while the
upstream fix remains unpublished. All ten published files match provenance
commit `305a2e4bfe324bb53c336c1b03387ee1251c926f`; npm verified its registry
signature and attestation. The reviewed runtime diff adds bounded parsing and
AST traversal, option validation and expansion-parent cycle detection, without
new runtime dependencies or install hooks. The unchanged upstream 3.0.3 test
suite passes all 764 cases against the patched runtime; the fork's extended
suite passes all 799. The dependency policy records the temporary pin and its
limits, including that expansion cardinality is not bounded by this fix.

Three new repository regressions fail against the original package and pass
against the installed replacement, covering deep brace/parenthesis strings,
direct and cyclic ASTs, normal glob behavior, actual Micromatch/Chokidar
consumers and every locked copy. Both lockfiles retain published integrity
hashes. Yarn was regenerated with Yarn 1.22.22 and also brought forward the
existing Capacitor 7.6.9 and source-map-js 1.2.2 fixes. Its installed-consumer
checks pass. Both managers report zero high/critical findings: npm retains
6 low / 4 moderate findings and Yarn retains 1 low / 4 moderate findings.
The production npm audit reports zero vulnerabilities. No advisory, audit
threshold, workflow or required check was suppressed or weakened.

A clean install with the declared npm 10.9.2 applies all repository patches.
Dependency/license policy, formatting, core TypeScript typecheck, strict core
lint, five focused dependency regressions, the production web build and all
49 UI tests pass. The broad core run passed 1,927 tests with 10 skipped and
five Git Bash subprocess timeouts on Windows. Both affected workflow-test
files then passed all 54 tests with one worker, without changing their
timeouts or assertions. Fresh current-head remote CI is still required;
SDK PR #2 remains open and the wallet PR still requires human approval.

PR #105 merged #103 (`fix/shv-runtime-recovery-20261007`) on 2026-10-08 so it
could be reviewed on a base without the hand-submitted dependency-graph snapshot
on `c45be9b7`. #103 carries the same dependency repairs in its own form
(Capacitor 7.6.9, source-map-js 1.2.2 and the vendored `@optn/build-braces`
3.0.4-optn.1), and this branch now uses them unchanged: the
`@dieub/braces-depth-guard` alias above and its dependency-review advisory
exception are gone, and package.json, both lockfiles, the Capacitor patch,
`docs/dependency-policy.md` and the desktop AppImage pins are identical to #103.

### 2026-10-07: production SHV recovery, bounded retention and date restart

The follow-up based on merged `dev` at `c45be9b7` connects historical proof
requests to normal shared wallet refresh. Proofs bind to the runtime's existing
MMR commitment and selected route; recovered linked ranges remain private until
the complete range reaches the accepted tip and the source/store guards pass.
An optional SHV timeout/refusal preserves ordinary same-peer replay. A
structurally valid proof that fails cryptographic verification is discarded and
also falls back to authenticated replay against the existing MMR commitment.
Wrong heights/checkpoints, malformed structure and invalid tails still fail.
Invalid proofs cannot promote wallet evidence, grant pruning authority or expand
source policy.

Accepted wallet checkpoint publication now triggers retention: a recent 2,016
raw-header window by default, with older compatibility hashes retained unless
the same BIP37 route has actually proved SHV service. Neutrino keeps the hashes
needed for filter-header reconstruction. Ordinary header updates also refuse
concurrent store changes and conflicting previously accepted heights. Restored
date anchors are reauthenticated from their raw header windows before resolving
a birthday; hash-only history cannot substitute for timestamp evidence.

Review fixes remove full accepted-store clones from normal refresh and recovery.
A write-locked revision check guards publication; only incoming headers are
staged, with whole-batch conflict/link checks and a final revocation check before
insertion. Pruning, rewinds, empty publications and whole-store replacement all
invalidate the prior revision. Existing chain generation and unrelated entries
remain intact.

Live evidence in `docs/chain-interop-evidence.md` and the opt-in
`optn-cli/tests/shv_regtest.rs` covers two peered local BCHN nodes, encrypted HD
reopen, actual SHV recovery, repeated pruning/recovery, unchanged balance/history
on ordinary-peer fallback, both real CLI routes, and saved-date actor refresh
after restart at an unchanged tip. This closes the former **local P2P restart
evidence** gap and the restored-date connection for these P2P paths. Host-created
birthday anchors, packaged GUI/mobile interactions, public-network scale and
automatic wallet reorg recovery are not established by this fixture. The broader
RPA/contract union, durable outbox, Fusion and category-indexer gaps remain
separate work; this follow-up does not claim all of #71/#75/#83 complete.

Validation: 361 runtime library tests pass, including 16 recovery/retention/date
regressions and four new store publication tests. The connected real-node
runtime/CLI test passes after the review fixes; strict runtime and CLI Clippy,
Rust formatting and the architecture boundary check pass. Remote platform
packages and security scans remain independent checks on the pushed revision.

### 2026-10-08: #63 follow-up scope, checked against `62f8d85a`

This follow-up keeps the shipped React/Tauri interface. The #71 Leptos/Slint
overhaul is out of scope. Each row below was checked against the source at
`62f8d85a` rather than copied from an earlier row. Rows close as the follow-up
lands evidence for them.

| Gap | Current code at `62f8d85a` | Closure |
| --- | --- | --- |
| Electrum-only wallets never resolve a token identity | `token_metadata::resolve_selected_identities_inner` accepts only `FullNodeValidated` transaction and terminal evidence, and `identity_from_step` discards any other authhead. Only `optn-chain-bchn` produces that evidence. The shipped sources are Electrum servers, so every owned token reads *Unverified* unless the holder runs BCHN | Accept Electrum observations at an explicit server-reported assurance that reaches every surface. Node-validated stays distinct |
| Electrum cannot answer `OutpointSpentness` | `optn-chain-electrum` returns `Unsupported` | `blockchain.utxo.get_info` where the server has it, `listunspent` otherwise, bound to the tip it was evaluated at |
| rnbrady's walk-back, race and forward-entry heuristics | Spender discovery tries UTXO creators, then height-filtered history, one after the other. No ancestor walk-back, no race | Bounded walk-back (three ancestor hops, 30 fetches) racing the history scan. Every candidate still passes the authchain rule |
| Burned identities lose their publication | An `OP_RETURN` identity output maps to *Unpublished*. That includes the common case where genesis output 0 *is* the BCMR publication | Read the publication from the burned authhead, whose outputs carry the claim, and mark it final |
| `authchain` registry extension unused | Registry extensions are parsed and never consulted | Use it as an untrusted candidate chain, checked like a restart hint |
| Desktop token icons are always placeholders | `projectEngineTokenMetadata` sets `iconUri: null`. There is no policy-aware image port | Fetch image bytes in Rust under the wallet's transport policy, bounded by size and type |
| Renderer requests bypass the Tor/proxy policy | `http-bridge.ts` routes only the price host natively. Every other webview request goes direct | Policy gate for renderer HTTP and image loads on desktop. **Closed 2026-10-09** (the webview cannot reach the network, below) |
| §21.3 feeds partly ingested | P2P DNS-seed and Fulcrum peer-discovery feeds are declared but not ingested. Peers returned by `server.peers.subscribe` are dropped | Ingest them with provenance, unverified until probed. **Fulcrum peers closed 2026-10-09** (below); P2P DNS seeds are still not ingested |
| Versioned network-configuration migrations | The schema is fixed at 1 and any other version is refused | Migration step with atomic write and rollback tests. **Closed 2026-10-09** (schema 2, below) |
| Fusion input checks bypass the chain layer | `optn-fusion/src/electrum_input.rs` speaks Electrum JSON-RPC directly | Route through `chain_service`. Needs a live round to verify. **Closed 2026-10-09** (CashFusion checks inputs through the shared chain adapter, below) |
| Stale open items | `open-items.md` #4 and #5 are already fixed in code. `src-tauri/src/fusion/component_vectors.rs` is no longer compiled | Document updated, orphan deleted |

The ancestor-publication rule below was first left out of this scope; live
mainnet data reversed that (see the next entry).

Still blocked or out of scope here: hardware-device signing evidence,
store-signed and iOS packages, the React-to-Leptos cut-over (#71), the #82
marketplace, and maintainer approval of #83's diagrams.

### 2026-10-08: token identities over Electrum, rnbrady's search, live mainnet tokens

Token identities now resolve on the default Electrum sources. The resolver
accepts a route's own node or that route's server, and the result says which:
`IdentityBasis { assurance: NodeValidated | ServerReported, burned }` travels
through `optn-app`, the encrypted checkpoint (records written before it read as
unattested), the transport and the desktop bridge. React labels a server-backed
name "Verified via server" and a burned identity "· final"; the text and Leptos
renderers add "as reported by server". A walk rests on its weakest step, and a
node-selected walk still refetches every hop from the node, so a discovery
server can neither lower nor raise it. Registry bytes still have to match the
committed hash; a timeout, partial history or exhausted budget is still never an
authhead.

Electrum answers `OutpointSpentness` with `blockchain.utxo.get_info` (protocol
1.4.4 and later), or with the address's unspent list on older servers or when the
method is refused. The tip, the transaction and the lookup share one pipelined
round trip, and the answer is bound to that output's script and value.
`TransactionLookup` also returns the block height from `get_merkle`, which bounds
later history searches. A backend keeps one negotiated connection for 30 seconds,
so a walk no longer pays a TLS or Tor handshake per question; a broadcast never
reuses one and is never retried. Identity lookups run through
`ChainService::execute_optional_on_route`: the same policy and response-binding
checks, without route-health bookkeeping. Now that identity resolution runs on
every Electrum wallet, a metadata lookup a server cannot answer must not take
that server out of wallet sync, and it no longer can.

Spender discovery follows rnbrady's Electron Cash work. It tries the address's
unspent outputs first, walking back three hops through any input and through
output-0 links until a 30-fetch cap, then the history after `from_height`, oldest
first. The transactions the walk passed through come back as untrusted hints; the
resolver accepts them only as the authchain rule allows and uses their bytes in
place of a lookup only when they came from the route's own source. Not adopted:
racing the two phases. Pipelining already sends up to 64 fetches per round trip,
and a race would request the history even when the unspent outputs answer.

Two readings changed on live data. An `OP_RETURN` identity output is a burned
head whose outputs carry its registry, often the burning output itself, and it
is resolved without asking anyone whether it is unspent. A head without a
publication leaves the newest earlier publication in effect: Moria USD's head is
four identity moves past its registry, and the strict reading showed that token
as unpublished on desktop while Electron Cash and OPTN's own legacy TypeScript
resolver showed its name. Withdrawal is still a newer publication or a burn.

The shipped catalog had one IPFS gateway, and it rate-limited during the live run
(HTTP 429). Four path gateways that served the exact committed bytes now ship on
every network but regtest: OPTN's own, ipfs.io, Filebase and Pinata.

A verified registry's `authchain` extension now serves as a restart point for
the identities it lists: from registries cached by earlier refreshes and from
those verified during the current one. It gets the same link checks as a
restart hint. Its last transaction is still looked up live, and its
unspent state is asked for live. A tampered or out-of-order chain is ignored, and
the walk starts cold.

Desktop token icons come through `optn_token_image`. The renderer names a
category and one image URI from that category's authenticated presentation; the
host fetches through the wallet's metadata transport, recognises a bounded image
by its content and returns a `data:` URL. A runtime identity never shows a remote
URI the webview would fetch itself.

Live evidence, from the opt-in `optn-chain-native/tests/bcmr_live.rs` against
public Fulcrum `bch.imaginary.cash` over direct TLS:

| Token | Result | Chain | Time |
| --- | --- | --- | --- |
| Moria USD `b38a33f7…` | Verified via server: "Moria USD", MUSD, 2 decimals | 8 hops, registry at hop 4 | 8.7 s |
| Furu `d9ab24ed…` | Verified via server: "Furu Tokens", FURU, 0 decimals | 6 hops, found by the walk back | 7.4 s |

The desktop shell's unit tests did not compile on this base: a test still called
a function #105 had moved. One Tor lifecycle test also raced its siblings over
process-wide state. Both are fixed, and Desktop E2E now runs the shell's tests
after its build; nothing ran them before.

### 2026-10-09: one Tor switch for chain, metadata, Cash Code and CashFusion

#75 §4.1 asks for one transport policy that every feature consumes, and says
ownership must not be encoded as transport. Before this, the Rust stack made
every remote, non-own route need verified Tor and dialled declared own
infrastructure directly. Nothing the holder set changed that. The old UI's Tor
switch had not been rendered since the #63 refactor. The renderer's
`torEnabled` flag reached only the TypeScript Fusion and Cash Code paths.

The connection policy now carries the rule, `TransportPolicy::{Tor, Direct}`,
shown as one switch under *Settings → Servers → Privacy & Transport* and as
`optn network tor on|off`.

- **Tor on** (the default) is what every route already did. Public sources go
  through Tor; a node the holder declared as their own is reached directly.
- **Tor off** proxies nothing.

Ownership is now an input to the rule rather than a rule of its own. A third
"Tor even for my own node" state was built and then removed: it served only
onion-service setups and otherwise broke the holder's own node.

The switch reaches:

- native chain routes;
- the Tor-need probe, which also decides whether the app starts its Tor;
- BCMR and IPFS retrieval;
- Cash Code scans and the legacy SPV commands;
- CashFusion.

Direct registry fetches from origins the holder did not declare resolve only to
public addresses, so a URI published on chain cannot aim the wallet at its own
network. Remote full-node RPC and ZMQ stay local-only either way. The refusal
now says why. An idle install, with nothing selected, still does not wait on
Tor detection; the first version made it probe, and a desktop test caught it.

CashFusion stays Tor-mandatory. Every remote leg needs Tor with provenance:
server, pool, peer-input and Electrum lookups, covert endpoints and the P2P
Nostr relays. With Tor off, Fusion is refused before any proxy is consulted,
rather than run in the clear. P2P relay connections used to accept a SOCKS port
from the renderer; they now take Tor from provenance like every other leg.

The network overlay is schema 2:

- Schema-1 files read as `tor` with every other field intact. The file changes
  only on a successful save; a failed read writes nothing.
- Schemas outside 1..=2 are refused, never reset. A schema-2 file must name a
  transport this build knows.
- Portable backups carry the switch and never proxy trust.
- Presets, pinning a source, editing the selection and saving the old
  one-server fields all keep the switch. No setting of it makes those fields
  unreadable or widens "only my server".

The last guarantee needed `ConnectionPolicy::selects_like`. Three legacy
comparisons against `ConnectionPolicy::auto()` would otherwise have refused the
old server screen, or widened it, as soon as the switch was off.

Fulcrum peer lists are now ingested (#75 §21.3), and the 2026-10-08 row for
them closes. Every connected Electrum server's `server.peers.subscribe` answer
is filtered:

- TLS hostnames are kept, and onions only while Tor is on.
- IP literals and local or single-label names are dropped.
- Servers the catalog already has are dropped.

What is left goes to a bounded per-network cache file beside the settings, not
in them. The desktop runtime polls the selection and rebuilds every route,
cancelling sync, when the catalog changes. Discovered servers therefore join
only the catalog routes are built and listed from, never the selection that
decides when to rebuild.

They rank after every other source. A build dials them only when no other
Electrum route connected, three at most, so they are failover. They are
bootstrap entries: they can be disabled or banned, the ban lives in the overlay
keyed by stable ID, and they cannot be removed. They are eligible only under
public scopes, never under own-infrastructure-only, an explicit list or the old
fields' "only my server", and never on an idle install. The desktop app and
the CLI share the cache.

Still open from the 2026-10-08 table: renderer HTTP and image loads, which
still go direct from the webview, and Fusion input checks through
`chain_service`. The first is closed in the next entry.

### 2026-10-09: the webview cannot reach the network

Everything above governed Rust. The webview still made its own requests, so
none of it applied there:

- `fetch` went direct to every host the CSP listed, and only the price host
  went through Rust. The Cauldron activity scan sends up to 300 of the
  wallet's PKHs to `indexer.riften.net` on every wallet open.
- Every relay socket went direct, because the CSP allowed any `wss:`/`ws:`:
  WalletConnect, CashConnect, WizardConnect (whose pairing URI names the
  relay, plaintext included) and Nostr chat.
- The P2P Fusion relays went direct as well. `FusionP2pService` set the
  Tor socket through `nostr-tools/pool`, but its `SimplePool` comes from
  `nostr-tools`, a separate module with its own default, so the Tor socket was
  never used. A relay could link a peer's inputs to its outputs.
- Images from any `https:` host loaded straight from the webview.
- The legacy Electrum client's native TCP socket, the price fetch and the
  update check all ignored the switch.
- Links opened in the system browser with no warning, through `cmd /C start`,
  where a `&` in a query string is a second command.

Now the CSP allows only the app, IPC and loopback, in release and in the Vite
dev server. Remote `fetch`, sockets, images and the Electrum socket all go
through Rust (`src-tauri/src/egress.rs`), and one rule decides each route. The
rules are in `docs/network-transport-policy.md`:

- the stricter of the runtime's and the window's network;
- own nodes direct only when declared own on both;
- with Tor off, public names resolve to public addresses only, and the
  connection goes to the address that was checked;
- sockets close with their page and on every change of the switch;
- a link outside Tor asks first.

HTTP is still limited to the hosts the old CSP allowed. Images take `https`
names only.

Fusion's relay pools are now given the Tor-only socket directly, and a test
checks every pool, the per-output ones included.

A review of the first version found 31 issues, all fixed here. Among them:

- WalletConnect never connected: its relay URL has a query and no path, and
  a hand-written parser read the query as part of the host. URLs are now
  parsed by `reqwest::Url`.
- Two windows on different networks followed the wrong switch.
- A socket outlived its page, and ignored a later switch change.
- Frames that arrived before the page listened were lost.
- Failed images were cached for the session.

Checking the release bundle found that the bridges themselves loaded too
late. The desktop prelude was imported first in `main.tsx`, but the bundler
runs every chunk an entry imports before the entry's own code. The chunk
holding nostr-tools and the redux store ran first.

- nostr-tools had already captured the webview's `WebSocket`. Under the new
  CSP its relays would have failed closed.
- The store had already opened the shared `optn-wallet` database before
  `storagePartition` could rename it. Every release window shared one persist
  database: the bug the partition exists to prevent. This one predates this
  work, and development builds never showed it.

The prelude is now a chunk of its own, imported before any other.
`scripts/__tests__/desktopPrelude.test.mts` checks the chunking, the import
order and the dev-server CSP.


### 2026-10-09: headers before the ASERT anchor are bounded by the network's limit

#75 §20 (item 75-62). `verify_header_extension` checked a header's link and
its own declared proof-of-work everywhere, and the expected ASERT difficulty
only from the anchor on. Below the anchor nothing bounded the declared
target. A mainnet header below 661,647 that declared `0x207fffff` (regtest's
limit) and met it passed. Nor was the anchor tied to a chain: a chain that
crossed the anchor height on different blocks was judged by the anchor's
bits and time all the same.

Two checks now run wherever an `AsertCheck` is attached. The shipped
verifiers, header recovery, the desktop SPV walk and the CLI all attach one:

- **The proof-of-work limit, at every height.** The declared target may not
  be easier than the network's `powLimit`. Mainnet, chipnet, testnet3 and
  testnet4 use `0x1d00ffff`, and regtest `0x207fffff`. These are the compact
  forms of the `powLimit` values in BCHN's `chainparams.cpp`, and they were
  already `AsertParams::max_bits`.
- **The anchor's chain.** BCHN keeps the ASERT anchor by height, bits and
  previous time, and requires "the block after this height" to be
  checkpointed. `AsertAnchor::successor_hash` is that checkpoint, copied
  from `chainparams.cpp`:
  - mainnet 661,648;
  - testnet3 1,421,482;
  - testnet4 and chipnet 16,845.

  The header at that height must have that hash. Regtest pins none.

Tests use real mainnet headers fetched from a public Fulcrum server. None of
them is taken on trust:

- genesis and block 661,648 match BCHN's hardcoded hashes;
- block 661,646's timestamp is the anchor's `prev_time`;
- the rest link to those.

They show that block 1 (exactly at the limit) is accepted, and that a forged
easy-target header after it is refused even though it meets its own target.
Crossing the anchor on BCHN's chain is accepted; the same header against a
different pinned successor is refused.

Two `header_view` fixtures had ground regtest-difficulty chains and verified
them under chipnet's rules. They now say regtest, which is what they are.
The legacy DAA/EDA rules before the anchor remain unchecked. Shipped
checkpoints are option (2) of the item.

### 2026-10-09: the renderer's Electrum servers come from the source selection

#75 §20 and §21 (items 75-16 to 75-21, 75-26, 75-96 and 75-98). The native
stack chose Electrum servers from the holder's source selection. The
renderer's Electrum client kept its own list (shipped defaults, its own user
servers, desktop-only extras), and `electrum_tcp_connect` dialled whatever it
was given. A server the holder disabled or banned in *Settings → Servers* was
still dialled, and so was every server under Privacy, own infrastructure
only, BIP37 only or Neutrino only. CashFusion's peer-input lookups took
servers from the renderer too.

`src-tauri/src/electrum_selection.rs` is now the one rule:

- `listed_selection` resolves a network's catalog and policy. The Servers
  screen lists from it as well, so the two cannot disagree.
- `pool_from` turns it into Electrum servers, in plan order. Electrum must be
  among the policy's protocols, since under Privacy a source is selected for
  its P2P endpoint. Onion servers are left out with Tor off.
- `optn_chain_electrum_pool` gives the renderer that list. The desktop
  router uses it in place of its own, and fails at once with the policy's
  reason when it allows no Electrum. The desktop Home screen then says so
  instead of showing an empty wallet.
- `electrum_tcp_connect` refuses any other server before dialling, with
  `electrum-not-selected`. Loopback and Cauldron's Rostrum indexer are
  exempt: neither is a chain source.
- Every settings save now notifies, whatever screen made it. Renderers fetch
  the pool again, and sockets to servers the new selection excludes close.
- Fusion lookups use the servers the renderer offered that the selection
  includes, then the rest of the selection, eight at most. A round with none
  is refused.

With nothing saved, the selection is the shipped catalog under Auto, as the
Servers screen already listed it. A fresh install therefore still connects
during onboarding.

The renderer used to dial some servers that are not in the shipped catalog.
None of them are dialled now:

- chipnet `electrum-chipnet.optnlabs.com`, which answers neither raw TLS
  (50002) nor TCP (50001) as of today, so the desktop could not use it;
- testnet3 and testnet4 servers on their WSS ports (60004, 62004), which the
  desktop dialled as raw TLS;
- mainnet `electron.jochen-hoenicke.de` on 50002, where the catalog has 51002.

Legacy servers in the renderer's local storage are not imported, and are
refused like any server outside the selection.

Not covered yet:

- cashscript's `ElectrumNetworkProvider` names its own hosts. They are in the
  shipped catalog, so they pass under Auto and are refused under narrower
  policies.
- Plain-TCP Electrum servers cannot be written in the renderer's server
  format and are left out of its list.

### 2026-10-09: a transaction the node already has is not a rejection

#75 (item 75-69). A broadcast that met a node already holding the
transaction was reported as rejected, or as uncertain. The desktop then told
the holder their sources had refused a transaction that was in the mempool.

- **BCHN RPC.** BCHN answers a JSON-RPC error with HTTP 500 and the error in
  the body (`JSONErrorReply`, httprpc.cpp). The adapter read only the status,
  so every refusal arrived as "BCHN RPC HTTP status 500". It now reads the
  node's code and message.
- **Electrum servers** pass the node's message on after Fulcrum's preamble.
- **BIP37 peers** send a `reject` (BIP61) naming the transaction.

All three now read the node's own words through one classifier
(`optn_runtime::tx_broadcast::classify_node_message` and `classify_reject`).
The strings come from BCHN's source:

- `transaction already in block chain` (RPC -27);
- `txn-already-in-mempool` and `txn-already-known`, reject code 18,
  formatted as `<reason> (code 18)` by `FormatStateMessage`.

Any of these means the node has the transaction, so the broadcast counts as
observed and the coordinator reports it as submitted.

`txn-mempool-conflict` shares code 18 but means another transaction spends
the same coins, so it is a rejection. Only exact wording counts: the same
words under another RPC code, or with anything added, are handled as before.

### 2026-10-09: an Electrum wallet loads even when its headers do not

#75 (item 75-61). The sync worker advanced the verified header view before
every wallet refresh. For any route, a failed header batch skipped that route
with "header prerequisite failed". So a header fault or a reorg on an
Electrum server kept the wallet from loading at all, though an Electrum
snapshot is server-asserted and never tied to the header view.

Now only BIP37 and Neutrino, whose snapshots must match the verified tip,
take headers first; a header failure still refuses those routes. Electrum
and other server-asserted routes refresh and reconcile first, then advance
the headers best-effort. A failure there leaves the accepted snapshot fresh
and says why in its degraded reason ("headers did not advance: ...").
Nothing reads the header view between the refresh and the reconcile: token
identities use the snapshot's tip, and wallet sync captures the view only
after the refresh returns.

Tests record the order of requests: Electrum asks for the wallet first and
loads with misnumbered headers; BIP37 asks for headers first and sends no
wallet query when they fail.

### 2026-10-09: a stack dials a few servers, in plan order, and fallback last

#75 (items 75-14, 75-34 and 75-105). `build_native_chain_stack_with_tor_status`
dialled every selected source one after another. The order was the catalog's,
with only discovered servers moved last, so:

- under Auto on mainnet, every rebuild did about 22 TLS handshakes;
- a slow peer delayed every source behind it;
- fallback sources could be dialled before primary ones, so a public fallback
  saw a handshake while the holder's own node was serving.

The builder now works in tiers, in the selection plan's order:

- **Primary sources** first. Connects run concurrently, six at most at once,
  so a hung peer holds only its own slot. Results are recorded in plan order.
- **Electrum, where the app chooses** among public servers (`AllEnabled`,
  `PublicEnabled`): three are dialled. If none connects, the next three are,
  and so on. The rest are held back. Servers the holder named, their own
  infrastructure or an explicit list, are all dialled.
- **Fallback sources** only when no primary source gave a wallet route.
- **Discovered servers** last, one at a time and three at most, as before.

Held-back servers are not failures and are not listed as such. Before a
wallet sync, the desktop runtime checks the installed stack. When it has no
wallet route left, the next held-back servers are dialled into the same
service, so the wallet fails over without a rebuild. A retired stack dials
nothing.

Counting fake servers show the behaviour:

- of 21 public servers, three are dialled and 18 held back;
- the next three are dialled on request;
- three that hang up lead to the next three;
- a public fallback gets no connection while the own node serves, and does
  when the own node is down.

### 2026-10-09: token identities ask fewer servers

#75 (items 75-132 and 75-153). The identity resolver walked a category's
authchain on the outpoint-spentness routes in plan order, so a public
Electrum server ranked ahead of the holder's full node was asked first even
though the node could answer with node-validated evidence. On each hop
without a known successor it asked every spender-lookup route, so every
selected server learned which token chains the wallet follows.

- A full node's routes now come first for both the walk and spender
  discovery; a walk the node completes is never asked of a server.
- Spender discovery stops once two sources have answered. Two is enough to
  catch two sources naming different spenders, which still leaves the
  identity unresolved.

Tests show a node resolving with node-validated assurance while a server
ranked ahead of it only cross-checks spenders. Of three servers behind the
node, one is asked per hop and two never are. A rival spender from a second
source still leaves the identity unresolved. The fan-out test fails without
the cap.

### 2026-10-09: the runtime draws a new wallet's phrase (#71)

#71 (part (1) of item 71-1). The Leptos renderer generated new wallets'
recovery phrases itself: Web Crypto `getRandomValues`, then
`mnemonic_from_entropy`, held in a signal. `Create` then carried those words
back to the runtime. So the phrase existed in the renderer before the
runtime had seen it, and the runtime stored whatever words it was sent.

- **`seed_draft(word_count)`**, a new transport call (Tauri command
  `optn_wallet_seed_draft`), draws the phrase in the runtime from the
  platform's entropy (`WalletStorage::entropy`, `getrandom` on native). The
  runtime keeps it under a draft id and returns the id and the words to
  display. The words are a `SecretText`: never `Debug`, zeroized when dropped,
  and never in the shared state.
- **`Create { draft: Some(id) }`** creates the wallet from the runtime's own
  copy. A drafted create carrying words of its own is refused, and so is a
  stale or unknown draft id. The draft is used once.
- **`DiscardSeedDraft`** forgets the draft when the screen closes. A lock or
  unlock, which changes the security epoch, forgets it too.
- **Import** still sends the typed phrase. The web preview, which has no
  runtime holding keys, reports that a new phrase is unavailable, as wallet
  security already did there.
- **`xtask architecture`** now fails if any renderer crate draws entropy
  itself (`get_random_values`, `getRandomValues`, `mnemonic_from_entropy`,
  `OsRng`, `getrandom`). It fails on the old UI source and passes on the new.

A runtime test checks the whole path through the real actor:

- 12- and 24-word phrases are valid BIP39;
- no drafted word reaches the serialized shared state;
- a stale, discarded or reused draft is refused, as is a draft whose epoch
  was ended by a lock;
- a wallet created from a draft holds that phrase's account key.

Part (2) of 71-1, the React renderer's authoritative slices and its
TypeScript Electrum and UTXO services, belongs to the #75/#83 migration and
is not this change.

### 2026-10-09: a reorg rolls the header view back to a state it really had

#75 (item 75-reorg ring, rank 15). The verified header accumulator is
append-only. `rewind_to` could drop time anchors above a height, but the
accumulator itself could not go back. A reorg below the verified tip
therefore meant rebuilding from a checkpoint.

- `VerifiedHeaderView` now keeps a ring of snapshots: the full verifier
  state and median-time window after each of the last `REORG_WINDOW` (10)
  blocks, plus the one before them. That is about 700 bytes each. BCHN
  finalizes a block ten deep.
- `rollback_to(height)` returns to one of those states rather than editing
  peaks, and drops the time anchors above it. Extending from there gives
  exactly what a straight extension gives, and another branch is accepted
  from the same block.
- The persisted view is schema 3. The ring is stored as its oldest state and
  the headers after it, never as the intermediate states. On restore the
  oldest state is loaded at the commitment it claims and extended with the
  stored headers, which are checked like any others: linkage, proof-of-work,
  difficulty. The ring is kept only if that replay reaches the trusted tip.
  A ring longer than the window, an altered header, or one that stops short
  is refused with the rest of the record.
- Schema 2 is schema 3 without the ring, so it still reads, with an empty
  ring. A later, unknown schema is refused.

Automatic recovery, which detects a reorg and calls `rollback_to`, is the
next item (rank 16). It needs this ring and the Electrum ordering change
above.

### 2026-10-09: a reorg within the window is followed automatically

#75 (items 75-60, 75-65 and 75-77; rank 16). With the snapshot ring in
place, a header pass now handles a source on another branch rather than
failing on it.

- **Detection.** The pass's first batch does not build on the verified tip.
- **Fork.** The worker asks the same route once for the blocks the ring
  covers. The fork is the highest block both chains share.
- **Rollback.** The view rolls back to the fork with `rollback_to`, a state
  it really had, and the pass continues from there.
- **The new branch wins only with more work.** Its blocks must declare more
  total work than the ones they replace (`optn_core::header_pow::more_work`,
  BCHN's `GetBlockProof`). A longer branch of easier blocks is refused
  (`ReorgWithLessWork`), and nothing is written. After a rollback the pass
  runs until the source has no more, so the branch is weighed whole and
  never cut short by the per-pass limit.
- **Store.** The accepted store drops the orphaned blocks and takes the new
  ones. That happens on a copy, published only if the join holds. The
  store's generation moves, so caches stamped with the old one (token
  identities, scan progress) see the reorg.
- **Deeper than ten blocks.** A source whose chain leaves this one below the
  window is refused (`ReorgBeyondWindow`). BCHN finalizes a block ten deep
  and will not reorg past it, so neither does the wallet. A source cannot
  force a rebuild by claiming such a fork.
- **Restart.** The sealed view after a reorg carries the new tip and its
  ring, so a restart does not bring the orphaned tip back.

Tests run against regtest-difficulty chains through the worker and a shared
header store:

- 1- and 3-block reorgs on Electrum and BIP37: the result equals a straight
  build of the new chain, the store keeps the fork block, takes the new ones,
  and changes generation;
- a longer but lighter branch is refused with nothing written;
- a fork below the window is refused;
- a restored view keeps the new tip.

Not covered yet: a store that must first be replayed from a peer after a
restart, if that peer has already reorged. The replay stops at the
divergence and the pass fails. The next pass, with the store intact,
recovers.

### 2026-10-09: a weaker source can move the wallet forward, labelled

#75 (item 75-67; rank 14, first half). A snapshot never gave way to one with
weaker evidence, at any tip. That protects a proven snapshot from a faster
server, but it also left a holder stale forever once their stronger source
was gone. For example, after moving from BIP37 (header-proven) to Electrum
(server-asserted), every refresh came back `PreservedWeakerEvidence` and the
wallet stayed at the last BIP37 tip.

Wallet refreshes now go through `ReconciliationState::reconcile_refresh`. A
weaker candidate replaces a stronger snapshot only when both of these hold:

- its tip is newer than the retained one, and
- the verified header view holds that tip, as its own tip or in its reorg
  ring (`VerifiedHeaderView::holds`).

A server claiming a height is not enough, so a fast or lying server still
cannot displace a proven snapshot. At the same or an older tip, at an
unheld tip, or with no tip, the stronger snapshot stays.

An accepted downgrade is shown to the holder in two places: the
verification state follows the new evidence, and the degraded reason says
"evidence lowered from header-proven to server-reported at a newer verified
tip".

The rule applies at both points where a refresh is reconciled:

- **Sync worker.** For Electrum, headers are primed after the wallet
  answer. A weaker answer refused because its tip was ahead of the headers
  gets one more check once they are primed.
- **Wallet sync finish.** This reconciles against the runtime's published
  state. It rebuilds the view from the round's captured header progress,
  and only when a weaker, newer candidate raises the question.

Finish used to clear the worker's degraded reason, so "headers did not
advance" never reached the published status. It now carries the reason
over. `note_degraded` keeps an earlier reason beside a new one, once each.

Tests:

- the rule itself: newer and held is accepted and labelled; the same tip,
  an older tip, an unheld newer tip and no tip are all refused; equal or
  stronger evidence follows the ordinary rule;
- a worker switching from a BIP37 snapshot to an Electrum route ahead of
  its headers: accepted once the primed headers hold the tip, refused when
  they fail;
- finish on regtest: accepted with the captured header progress, carrying
  the worker's note; refused without the progress.

`weaker_assertion_cannot_replace_stronger_evidence_at_any_tip` and
`shared_worker_restores_evidence_and_cannot_shrink_discovery_scope` still
pass unchanged: neither has a header view that holds a newer tip.

A wallet with no header view at all, such as Electrum without a shipped
checkpoint for its network, still cannot be downgraded. That stays on
purpose: without headers nothing vouches for the newer tip.

### 2026-10-09: the sync status says how old, through whom, and to where

#75 (item 75-56; rank 14, second half). The status could say "stale" but
not how stale, which providers were down, or how far the verified headers
went. `WalletSyncState` now carries three more fields, and so do
`WalletSyncView` and its wire form:

- **`snapshot_at_unix_ms`.** Stamped by wallet-sync finish when a snapshot
  is accepted, and kept while a later refresh is refused. It is a time, not
  an age: the view is not republished as it ages, so each surface takes its
  own clock minus this. The checkpoint seals it, so a reopened wallet still
  says how old its snapshot is; older checkpoints read as not known.
- **`providers`.** `ChainService::provider_statuses` lists each registered
  provider once per source and protocol. A route this stack marked degraded
  or offline wins over the backend's own report. The refresh paths capture
  it into the lease, and finish publishes it whatever becomes of the
  snapshot. Finishes that ran no refresh here, such as air-gapped imports,
  leave the last list as it was.
- **`header_checkpoint`.** The verified view's checkpoint from the round's
  header progress: the height it reached, and who vouches for where it
  began. A restore brings it back from the sealed header progress.

The wire stays version 1: `WireWalletSyncView` is `serde(default)`, so a
payload without these fields reads as "not known". A test removes them from
a payload and checks that.

Three pure helpers give the wording: `snapshot_age_label`,
`provider_health_summary` and `header_checkpoint_label` in optn-app, and
their mirror in `src/platform/desktop/engineSyncStatus.ts`. The two sets
are tested against the same table. The Leptos wallet panel and the React
Sync page show the age after the tip, then the header line, then any
providers that are not usable.

Tests: provider health with an override, a backend going offline, and a
revoked stack; the checkpoint keeps the time across a reopen and a reseal;
finish publishes the header checkpoint and the time, and providers still
appear after a refused refresh; wire round trip and an older payload; the
wording on both sides.

### 2026-10-09: CashFusion checks inputs through the shared chain adapter

#75 (items 75-75, 75-80 and 75-94) and #83 (items 83-3 and 83-31). optn-fusion
spoke Electrum itself: its own JSON-RPC client, its own connection handling,
and no check that the server was on the round's chain. It now asks through an
`InputLookups` trait (`optn_fusion::lookup`) and holds only the verdict:

- a claimed input matches only when the source's unspent list for the
  pubkey's P2PKH script holds that exact outpoint at the exact value;
- a lookup that could not be made is an error, and an error never becomes
  blame, as before.

The desktop shell implements the trait (`src-tauri/src/fusion_lookups.rs`)
over the holder's selected Electrum servers, through the shared adapter:

- `ElectrumBackend::script_unspent_values` asks all of a round's questions
  on one connection. A list that is malformed anywhere (a non-canonical
  hash, a missing field, an output listed twice, more than 1,024 entries) is
  an error for that question, never "not unspent". Extra fields are ignored:
  the old parser refused `token_data`, so a peer whose address also held a
  token output made the round abort unverified.
- `optn_chain_native::connect_fusion_lookup` gives each server a connection
  of the round's own: loopback directly, anything else only through the
  verified Tor proxy, with isolation credentials no wallet connection shares.
  The server's genesis is checked, which the old client never did.
- A definite answer from any server settles a question; only unanswered
  questions move to the next server. `fusion_transaction_is_known` asks the
  same way and accepts only the exact bytes.

The chain layer's `OutpointSpentness` was not used for this: it fetches the
previous transaction first, so a peer claiming a transaction that does not
exist would make the check fail as unavailable instead of "not unspent", and
that peer would escape blame.

Token coins stay out of fusion, as in Electron Cash. Coin selection already
excluded them on every path; `gatherInputs`, the last step before signing,
now refuses them too.

Tests: the verdict rules and reference P2PKH script; questions batched and
kept in order; run.rs's revalidation (exact match, spent between
boundaries, no source, cancellation) and two full mock rounds on a fake
source; the adapter's batching on one connection and every malformed list;
the Tor-only and isolation rule; server ordering, partial answers, exact
transaction bytes; the token refusal.

Not proven yet: a live chipnet round with the desktop app.

### 2026-10-09: the fetch bridge never bridges Tauri's own IPC

A regression from "the webview cannot reach the network" above, on Windows
only, found by a live run: the desktop renderer grew to 7.5 GB within
seconds of launch and crashed ("Out of Memory"), before any wallet opened.

On Windows, WebView2 carries every Tauri `invoke` as a `fetch` to
`http://ipc.localhost/<command>`. The fetch bridge sent every non-loopback
http(s) request to Rust, and `isLoopbackHost` (which mirrors Rust's
`is_loopback_host`) does not count `ipc.localhost`. So each IPC call was
bridged, the bridge's own `optn_http_fetch` invoke was bridged again, and each
level base64-wrapped the request before it. A CPU trace put nearly all time in
the bridge's body encoder, called from the bridge, called from Tauri's
`sendIpcMessage`. None of it reached Rust. Linux was unaffected, because
WebKitGTK's IPC is an `ipc://` URL, which the bridge ignores; the desktop E2E
job runs only on Linux, and no job launched the Windows build.

The routing decision is now one pure function, `bridgedToRust`
(`src/platform/desktop/rendererNetwork.ts`), used by the bridge:

- the page's own origin, loopback (exactly Rust's rule, unchanged), and any
  `*.localhost` app host (`ipc.localhost`, `asset.localhost`; RFC 6761 keeps
  `.localhost` on the machine) stay on the webview;
- only other http(s) hosts go to Rust.

`localImageSrc` passes the app's asset protocol through for the same reason.

Tests pin the rule: IPC and asset URLs in both schemes, the page, loopback and
non-http schemes stay local; remote hosts, including look-alikes such as
`ipc.localhost.example.com`, are bridged. On the real app with the holder's
largest chipnet wallet (2,821 addresses): heap 39-69 MB over a minute idle,
wallet open in 15 s with the heap at 42-61 MB, where before the page froze
at 4 s and died.

Follow-up worth doing: a Windows desktop launch in CI (start the app, render
the landing page, stay responsive for 30 s) would have caught this.

### 2026-10-09: a fusion round declares its chain

Found in the live fleet run: the local Electron Cash server logged "No
genesis hash declared by client, we'll let them slide" for every OPTN
client. Electron Cash always sends its chain's genesis hash in ClientHello
(`comms.get_current_genesis_hash`, `fusion.py`), and a server on another chain
refuses at once; OPTN sent `None` both in the round (`run.rs`) and in the
desktop's status probe.

`FusionRunParams` now requires `genesis_hash` (internal byte order), so no
caller can leave it out, and the round sends it. The desktop passes the
runtime network's genesis to the round and to the status probe. The mock
server in both full-round tests now refuses a ClientHello without the chain.

### 2026-10-09: a busy Tor is still the trusted Tor

Found in the live ten-wallet fleet run: Auto halted on some wallets with
"a verified Tor proxy is required for every remote endpoint" or "Tor is not
reachable", and a P2P coordinator stayed at "verification pending" for a
transaction already on chain. Tor was up and trusted (port 9050); its SOCKS
greeting answered in 1.4 s under the load of ten wallets, and both probes
(`optn-fusion` and `optn-chain-native`) gave up at 1.5 s, demoting the
trusted Tor to "unverified".

The probe's timeout and SOCKS5 greeting now live once in `optn_core::tor`
(`SOCKS_PROBE_TIMEOUT` = 5 s, `SOCKS5_NO_AUTH_GREETING`,
`SOCKS5_NO_AUTH_ACCEPTED`) and both probes use them. A port with nothing
listening still refuses at once. Test: a trusted SOCKS port that answers
after 2 s is verified. The fleet run's rounds are recorded in this PR's
description.

### 2026-10-09: the CLI's Electrum-only commands follow the shared selection

Found while funding the fleet: under the desktop's default Auto selection,
`send` refused with "shared network settings contain no Electrum route",
while `rescan` on the same settings used the selected chipnet servers.
`balance`, `utxos` and `broadcast` already go through the shared native
stack; `send`, `tx` and the header fallback still use a single-server
Electrum client, which read only the desktop's older one-server fields.

`shared_electrum_servers` now gives that client the selection's own
encrypted Electrum servers, in plan order (primary, then fallback): the
named server when the older fields name one, otherwise every server the
selection plan picks. `client_for` uses the first that answers
`server.version`, so a down server (one refused connections in the fleet
run) is skipped, never replaced by one outside the selection. A direct
P2P-only selection, plaintext Electrum, or a selection with no Electrum is
still refused.

Test: under Auto the offered servers are the plan's Electrum endpoints in
order, all encrypted; the existing refusals hold. Not yet run live (needs
the trusted Tor). Follow-up in the Rust-first direction: move `send` and
`tx` onto the shared native stack like `balance`, then retire the
single-server client.

### 2026-10-09: fusion tier planning runs in Rust, once for every surface

Server CashFusion's tier planning (Electron Cash `allocate_outputs` and
`random_outputs_for_tier`: every tier the coins can fund, a random excess
fee per tier, exponential output amounts) lived in the desktop renderer
(`ServerFusionRunner.ts`), with the ServerHello limits checked there too.
The CLI and the headless docker runner could not plan a round without a
second copy.

`optn_fusion::allocate` is the one implementation. `plan_contribution`
takes a hello snapshot, each input's compressed public key and value, and
optional pinned tiers, and returns plans in the form `fusion_run` takes. It
refuses a snapshot outside Electron Cash's limits, a key that is not a
compressed public key, and a contribution that funds no tier, naming pinned
tiers when they are the reason. Randomness comes from the operating system
(`os_uniform`). An empty pin list restricts nothing, as before.

The desktop asks through `fusion_allocate_tiers`; only public keys and
values cross for planning, never private keys. The renderer's allocation
code, its constants and its limit checks are removed. The limits are now
checked natively where the ServerHello is read (the status handshake
refuses a server outside them, so no caller shows or plans against one),
again when planning, and again on the live hello in the round. One
addition: a tier or `max_excess_fee` above all money (21M BCH) is refused,
which also keeps every advertised value exact as a JavaScript number, the
renderer's old safe-integer check.

`test-vectors/fusion-allocation.json` was generated from the TypeScript
before it was removed, with a fixed uniform sequence, over a small hello
and Electron Cash's 72-tier reference; the Rust port reproduces every draw
and plan exactly. Rust tests also cover balance and limits over 50
sequences, pinning, the hello limits on the wire and on snapshots, and
refusals before any random draw. The renderer tests now check that the
runner plans from public keys and values only, requests fresh scripts for
the largest plan, passes the plans to the round unchanged, and stops before
any address or round on a planning refusal.

Next in the same direction: the Auto Fusion driver (coin choice, rounds,
fresh outputs) in `optn-runtime`, so `optn fusion` on the CLI and the
docker runner fuse with the same code as the desktop.

### 2026-10-09: fusion coin selection runs in Rust, through the shared WASM core

Which coins a round offers was decided in TypeScript
(`serverFusionCoinPolicy.ts`, plus a P2P branch and a 20-coin limit inside
`FusionRunnerService.ts`). The CLI and the docker runner had no way to make
the same choice.

`optn_core::fusion::coin_selection` is the one policy: Electron Cash's
`select_coins` / `select_random_coins` / `FUSE_DEPTH_THRESHOLD` for server
rounds (address buckets offered whole and at random, three largest coins
from a crowded address, Auto stopping at 99.9% of eligible value fused deep
enough), and the P2P selection (plain coins below the rounds-per-coin depth,
largest twenty). It is pure; randomness is a parameter. `FusionMode` moved
into the same module and `optn-app` re-exports it, so there is one
definition.

The desktop reaches it through the shared WASM core (`fusionSelectCoins`),
synchronously and without IPC, with draws from the host's
`crypto.getRandomValues`. `fusionCoinSelection.ts` only describes the
wallet's UTXO records (legacy freeze-flag names, token fields, recorded
depth) and maps the answer back to them. `serverFusionCoinPolicy.ts`, its
test, the runner's own P2P filter and limit, and the dead timing constants
are removed. Pre-consolidation now sweeps the crowded address the policy
names rather than recomputing it.

One tightening: a P2P round no longer offers a frozen coin. The TypeScript
P2P branch checked only tokens; `optn_core::coins` already says a frozen
coin (a pledge, an authhead, another round) is never fused.

Tests: 12 Rust tests port and extend the TypeScript ones. The runner's
vitest suite now runs the real Rust policy through WASM instead of a
TypeScript copy, and a new glue test checks the record mapping.

The committed WASM was also stale before this change: the Tor probe change
(`7b70e937`) touched `optn-core` without a rebuild, which the "Shared Rust
connectors" check would have refused once this PR targets `dev`. The
regenerated artifact passes `build-optn-core-wasm.mts --check`, and the
connector tests that run against it pass.

### 2026-10-09: fusion depth is one Rust record

Auto's stopping condition, each coin's fusion depth (Electron Cash's
`fuse_depth`), was a 907-line TypeScript module mixing its rules with its
storage. The CLI and the docker runner could not read or keep it.

`optn_core::fusion::depth::FusionDepthBook` holds the rules: a coin's depth
from its own entry, else its parent fusion's depth, else 1 when the parent
is a recorded fusion; a round's outputs one deeper than the shallowest coin
it spent (Electron Cash's `is_fuz_coin` ancestry rule, so the claim can
understate privacy and never overstate it); eviction only on evidence (a
round's spent inputs, or a snapshot that no longer holds the coin, never an
empty one); cold-import merging by the deeper record; cross-window merging
that an empty copy cannot wipe; and Auto's eligibility and its two status
lines.

The desktop holds one book per wallet as a WASM object and keeps the same
three localStorage keys and the SQL label table every earlier build wrote,
so an upgrade reads existing depth unchanged (a test seeds the old stored
forms and reads them back). `fusionCoinDepth.ts` is now storage, the
BroadcastChannel, the change event and the history stub rows. The
renderer's `formatAutoDepthMetMessage`, `formatAutoDepthGateLog`,
`coinsBelowDepth` and the unused `pruneSpentDepth` are gone; their callers
read the book's eligibility. The process-global `__optnFusionTxidSql`
cache is gone too: the book is the cache.

The freshness test now accepts exported classes and their members. The
shared WASM grew from 782 KB to 924 KB; Android already loads it
asynchronously, so no load path changes.

Tests: 11 Rust tests port the TypeScript ones and add the stored-form,
merge and import cases. The desktop tests now run the real book through
WASM, including an upgrade read of the old stored forms and a cold
export/import round trip.

### 2026-10-09: the runtime prepares a fusion round's contribution

A round needs each offered coin's signing key and fresh output scripts. On
the desktop both came from the renderer's key database; the CLI and the
docker runner had no source for either that respected the wallet's guards.

`AppRuntime::fusion_input_keys` and `AppRuntime::reserve_fusion_outputs`
are that source, beside `external_payment` and under the same guards: a
durable session, fresh coins, the synchronized HD account, no legacy
reservations, and Background authorization (Auto Fusion never prompts; a
prompt mid-round would kill the round). They are two requests because the
second depends on the first: the output count comes from the tier plans,
which are made from the offered coins' public keys. Each requested coin must
be an ordinary HD coin of this wallet, unheld, offered once; asking for keys
reserves nothing. The outputs are change addresses, as Electron Cash's
`reserve_change_addresses` does, reserved through the durable HD allocation
and saved before any script leaves the runtime, so a round that fails after
disclosing them never reuses them. A failed save reserves nothing and, as
with a payment, asks for the wallet to be reopened. Private keys are
zeroized on drop and never printed.

Tests: keys match the coin's own derivation and reserve nothing; three
outputs advance the change counter by three and nothing else; a second round gets different
outputs; foreign, duplicate, held and out-of-range requests are refused; a
failed save reserves nothing, and the same request succeeds after a reopen.

### 2026-10-09: one native fusion host for every surface

The pieces around the protocol engine that a native surface needs to fuse a
wallet lived in `src-tauri`, where only the desktop could reach them.

`crates/optn-fusion-native` is that host, for the CLI, the docker runner and
the desktop:
- `lookups`: the round's chain evidence through the holder's selected
  Electrum servers, on connections of the round's own (moved from
  `src-tauri/src/fusion_lookups.rs` with its tests; the desktop now calls
  it);
- `depth_file`: the fusion depth record on disk, in the same three stored
  forms the desktop keeps, written by temporary file and rename. A document
  that is not JSON is refused rather than read as empty, because an empty
  record reads every coin as depth 0 and Auto would pay to redo mixing;
- `server_round`: one server round. It runs the handshake (declaring the
  chain and refusing a server outside the limits), gets the coins' keys from
  the runtime, plans tiers, reserves the largest plan's outputs, runs the
  round with peers' inputs checked through the holder's servers, then waits
  up to a minute for a selected server to hold the transaction (Electron
  Cash waits the same). Every remote leg needs the verified Tor proxy.
  Server addresses parse as the desktop's do. The chain's genesis is the
  hash of the runtime's own anchored genesis header, not a fourth copy of
  the table.

Tests: the moved lookup tests; server address parsing, the per-leg Tor
rule, genesis for chipnet and mainnet against their known hashes, finding
the wallet's outputs by script, and the depth file's round trip and
refusals. The full round is exercised live with the fleet (next).
`cargo run -p xtask -- architecture` passes.

### 2026-10-09: `optn fusion` runs server rounds from the CLI

The CLI could not fuse at all, so a fleet could only be desktop windows and
the docker runner had nothing to run.

`optn fusion --server HOST[:PORT][:s|:t] --yes` runs CashFusion server
rounds for a saved wallet (`--wallet`) through `optn-fusion-native`, the
same host the desktop's round code now lives in. Each round refreshes the
wallet through the shared HD runtime, chooses coins with
`optn_core::fusion::coin_selection` against the depth record, and runs
`server_round`. Without `--auto` it runs one round (or `--rounds N`). With
`--auto` it behaves like the desktop's Auto Fusion, with the same timing
constants from `optn_app::fusion` (20 s after a paid round, 10 s after a
failure, 30 min idle once every coin reaches `--fuse-depth`) and Electron
Cash's 600 s pool inactivity rule. `--tier` pins tiers so wallets meet.
Progress goes to stderr as JSON lines; the result is one JSON document on
stdout. Ctrl-C cancels a round through the engine's cancellation registry,
which still finishes what it must after components are disclosed.

Tor follows the desktop's rule: no fusion while the holder's transport is
Direct, and every remote leg through a proxy verified from the shared
trusted ports. The lookup servers are the holder's selected Electrum
servers (up to 8, as on the desktop). Depth moves only for a transaction a
selected server holds.

Known limits, stated rather than hidden:
- server rounds only; P2P fusion is coordinated over Nostr and has no Rust
  driver yet;
- the depth record is a plaintext file beside the wallet, the same exposure
  as the desktop's localStorage. Moving it into the encrypted checkpoint
  waits on the checkpoint forward-compatibility fix;
- the desktop still runs its rounds from the renderer for legacy wallets,
  whose keys live in the TypeScript key database; the runtime refuses those
  wallets' coins until they are runtime-managed;
- not yet run live: that needs Tor and a local Electron Cash server for the
  fleet.

Each CLI process holds its wallet directory's session, so a CLI fleet uses
one `--wallet-directory` per member. The skill manifest lists `fusion` as a
spending command that requires confirmation.

### 2026-10-09: the docker fusion lab runs Auto Fusion headless

The fusion-lab profile held Tor and waited for an `OPTN_HEADLESS_CMD` that
did not exist ("separate product milestone"). Two things also stood in the
way of any native runner: Tor ran in another container at `tor:9050`, while
fusion trusts a proxy only by its local port; and only the desktop could
declare a trusted port.

- `optn network tor-trust PORT [--remove]` declares the holder's Tor the
  way the desktop's Privacy & Transport does, in the same shared overlay.
- `packages/docker-dev/scripts/fusion-lab-headless.sh` is the runner: it
  builds the CLI from the mounted repository (or uses `OPTN_CLI_BIN`),
  turns Tor on, trusts the container's own Tor port, and runs
  `optn fusion --auto` for `OPTN_WALLET` against `OPTN_FUSION_SERVER`. It
  refuses `p2p` with a clear message, since P2P has no Rust driver yet.
- The `fusion-lab` service shares the `tor` service's network namespace
  (`network_mode: service:tor`), so Tor is on its loopback; both compose
  files validate with `docker compose config`.
- The image creates `/optn-data` owned by uid 1000. Without it a new named
  volume is root's and the lab could not write its health file, wallets or
  build cache. `docker buildx build --check` passes.
- VPS.md, README.md, SCOPE.md and PRODUCTION.md describe the runner and its
  settings instead of "future CLI".

Not yet run live in a container: that needs a CashFusion server and Tor,
the same as the fleet run.

### 2026-10-09: a newer build's checkpoint is refused by name

Found in the fleet run: a CLI built before `snapshot_at_unix_ms` existed met
a checkpoint the newer desktop had saved and refused it as "invalid wallet
checkpoint data", which reads as damage.

The refusal itself is right and stays. A build cannot see a field a newer
build added, and some such fields hold coins (the payment outbox was one);
reading the rest and saving again would drop it and release them. What
changed is the message: a field the build does not know, or a newer
`optn-hd-restart-vN` format, is now reported as "written by a newer OPTN
build (it records `field`) ... Update this build to open it; the saved
state was left unchanged." A failed open never stores, so the newer record
stays intact. Damage and foreign formats keep their old messages.

Test: an unknown field and a v9 format are refused by name; a foreign
format and damaged JSON are reported as before.

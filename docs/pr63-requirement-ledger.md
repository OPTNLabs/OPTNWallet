Warning: truncated output (original token count: 51060)
Total output lines: 3083

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
| 1 | Auto is the default and operation-aware | **PROVEN** | `optn-runtime/src/bootstrap.rs::shipped_bootstrap_catalog`, wired in `src-tauri/src/chain_runtime.rs::catalog_and_policy_from_app_state`; `a_fresh_install_starts_from_the_shipped_catalog`. The catalog carries every §21.3 feed: Electron Cash's and General Protocols' server lists, servers found through `server.peers.subscribe`, and the DNS seeds of BCHN, Flowee the Hub, bchd and Knuth (2026-10-10 entry), each pinned and reviewed, with provenance merged | Operation-aware selection is `build_selection_plan`. Wallet operations go to a server first; P2P nodes found through the seeds are failover |
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
| 14 | CashFusion uses the shared chain observation layer | **PROVEN** (component) | A round checks its own and its peers' inputs through `optn_fusion::lookup::InputLookups`, implemented once by `optn_fusion_native::lookups::ChainInputLookups` over `optn-chain-electrum` (`ElectrumBackend::script_unspent_values`), on connections of the round's own and only through the verified Tor proxy for remote servers. The desktop and the CLI both use it; `electrum_input.rs` is deleted. Live on chipnet: six server rounds on the native host from the CLI and the docker runner, one with the desktop as a third player ("a live mixed fleet fuses") | Rounds are driven natively for the CLI and the docker runner, through a server (`optn-fusion-native::server_round`) or peer to peer over Nostr (`optn-fusion-native::p2p_round`, `optn fusion --p2p`). The desktop still drives its rounds from `Fusion*.ts` for wallets whose keys live in the TypeScript key database. The Rust P2P host is proven over a local relay. Live on chipnet, a round mixing Rust and TypeScript peers reached a CoinJoin signed by all seven wallets but has not fused: the Rust host's one-shot connections now use one circuit each and are paced, while blobs a desktop peeler forwards to a Rust peeler still go missing ("one circuit per component, paced") |
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
| CashFusion | **PARTIAL** | Protocol in `crates/optn-fusion`; coin selection, tier planning and the depth record in Rust (`optn_core::fusion::{coin_selection, depth}`, `optn_fusion::allocate`); one Rust driver (`optn_fusion_native::driver`) runs every round, manual and Auto, server and P2P, for the desktop (`optn_fusion_start`), `optn fusion` and the docker runner | Released; reported working on chipnet and mainnet. The P2P (Nostr) protocol is now also in Rust (`optn_fusion::p2p`), checked against the TypeScript peers in both directions, and the native host carries it over Nostr and Tor for the CLI and docker (`optn-fusion-native::p2p_round`, `optn fusion --p2p`; proven over a local relay, 2026-10-15). The desktop's TypeScript round runners are gone; the renderer only starts, stops and shows a run (2026-10-15). Live on chipnet (2026-10-16): P2P rounds of Rust peers fuse (six CLI peers; the desktop with six CLI peers), and desktop server rounds and Auto fuse through the shared driver. A live round mixing Rust and TypeScript peers fused on 2026-10-16 (`3e3b2c3f…`). Remaining: the coordinator's relay budget (see 2026-10-15), the onion's time budget with slower TypeScript peelers (see 2026-10-16), several desktop instances sharing one Tor (see 2026-10-16), pre-consolidation of crowded addresses in Rust, and a Leptos fusion screen |
| 44px targets, safe areas, contrast | **PROVEN** (measured in the stylesheet) | `optn-ui/style.css`, measured by `optn-ui/src/stylesheet.rs`: `interactive_controls_declare_a_44px_minimum_tap_target` requires an explicit `min-height: 44px` on `.primary`, `.secondary`, `.chip`, `.tab-item` and `.settings-row`; `the_shell_respects_the_devices_safe_areas` requires both safe-area insets; `text_meets_wcag_contrast_in_every_mode` (2026-10-10) checks text, muted, danger and warning at WCAG 4.5:1 against the page and the surface in all four modes and the default | Failure and caution text (`.error`, `.field-error`, `.warn`, `.warning`) now use the use-named `--danger` and `--warning` tokens, where before a failure read as body text. 13 layout classes remain in `UNSTYLED_TODAY`, and `no_new_class_is_left_unstyled` stops the list growing |
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
| §21.3 feeds partly ingested | P2P DNS-seed and Fulcrum peer-discovery feeds are declared but not ingested. Peers returned by `server.peers.subscribe` are dropped | Ingest them with provenance, unverified until probed. **Fulcrum peers closed 2026-10-09**, **P2P DNS seeds closed 2026-10-10** (below) |
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

### 2026-10-09: the webview cannot reach the…1060 tokens truncated…ues in BCHN's `chainparams.cpp`, and they were
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
  fleet. (Run live since: "a live mixed fleet fuses", below.)

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
the same as the fleet run. (Run live since: "a live mixed fleet fuses",
below.)

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

### 2026-10-09: `send` from a saved wallet runs on the shared native stack

Found while funding the fleet: `optn send --wallet ...` could never spend.
The wallet runtime releases signing keys only after a refresh in the same
session, and `send` never refreshed, so every saved-wallet send was refused
with "Refresh the wallet before preparing or authorizing a spend".

For a saved wallet, `send` now refreshes through the shared HD runtime
(`--max-addresses` bounds the scan, as for `rescan`), spends the runtime's
own ordinary HD coins with `optn_runtime::wallet_spend::prepare_spend`
(tokens never, every hold honoured), sends change to a change address the
runtime reserved durably, and broadcasts through the selected chain stack.
`--dry-run` plans and signs against the next change index without
reserving it. A phrase or keychain wallet keeps the old path.

The change reservation is the same runtime operation fusion rounds use,
renamed `reserve_change_outputs`. Its guard refuses a wallet migrated from
the desktop's TypeScript key database, because the desktop may hold its
coins in records the runtime cannot see. That refusal is correct and
showed up live: the desktop's wallets fund other wallets from the desktop.

Live: a dry run from a desktop-migrated chipnet wallet (3,000-address scan)
planned one input, a 226-sat fee and change to a fresh address; the real
send was refused by that guard, as designed.

### 2026-10-09: a live mixed fleet fuses: CLI, docker and desktop

Server CashFusion on chipnet across all three surfaces at once, on the
native host, `optn fusion` and the docker runner above. The test-only
pieces stay outside the repository:

- an Electron Cash fusion server on `127.0.0.1:8787` with
  `FUSION_MIN_CLIENTS=2` (the harness pins covert ports to 8790-8799 so a
  container can reach them) and Tor on 9050;
- two CLI wallets, each in its own `--wallet-directory`, running
  `optn fusion --server 127.0.0.1:8787 --auto --rounds 2 --yes`;
- the docker `fusion-lab` profile running `fusion-lab-headless.sh`
  unchanged; a test-only compose override adds loopback forwarders to the
  host's server through `host.docker.internal`;
- the desktop debug build, with Server Fusion and Auto on for one wallet.

Funding: 60,000 sats to two addresses of each new wallet from the shared
chipnet test wallet (txids in its handoff log), then 300,000 sats from the
desktop wallet to CLI w1 (`cbee36e0bdd45be90584a481c1b16f82509977077df1955863ec7a32c9b0b375`)
and to the docker wallet (`c92d5302d55318f4b19e799bacd6834fd2b1ac71b0e21e89bd9a983837c7bf02`).
The send meant for CLI w2 never happened, so w2 kept 2 x 60,000.

Eight rounds, each broadcast and on chain:

| Round | Tier | Players | Who |
| --- | --- | --- | --- |
| `6ddebc1638b000fd746e670f2becd3089e06c6542b885a63dffd6dda58866e25` | 10,000 | 2 | CLI w1, docker |
| `8e16870ba4485218b8fc3378ddba37977b9ab06e2c518afcf23e5327f6a35e0c` | 22,000 | 3 | CLI w1, docker, desktop |
| `b2cdcf955cbcea550a2507f5e0e9dc8f4e30fdaed44dd8e976d4b62de36c2b34` | 18,000 | 2 | docker, desktop |
| `a992a0963e39dab66d7ba285e3121b1fc8a1aae05e3dff69a7fccaf6a80ba73c` | 12,000 | 2 | docker, desktop |
| `87f43d10a4bb0833e1fbe146f274d18530bfec0cdc2040563aca8bfc811f0b25` | 12,000 | 2 | docker, desktop |
| `6945d0ad3fbe82c9045865fac2224dea077de44bc55ebba90cad91f9f1334b48` | 18,000 | 2 | docker, desktop |
| `4709406db83e3ad3e1618d7ab1a4a76bf5ab4b9ef649651ae4970da8156e976d` | 15,000 | 2 | docker, desktop |
| `970dc0a660686dd5f0715ab887062fb773134e81547e0e4e4f724e8e85a12233` | 15,000 | 2 | docker, desktop |

Player counts are the server's ("Starting fusion with N players"). Who
took part comes from each member's own record: CLI w1's result lists the
first two rounds, the docker runner's log the first seven, the desktop's
log the last six. Depth reached 2 on every surface (CLI w1's second round
spent only the first round's outputs), each step recorded only after the
selected servers held the round. The docker lab was stopped while round 8
was being broadcast, so its record ends at round 7.

What the run found:

- **CLI w2 could not fuse, correctly.** Electron Cash wants 11 components
  counted by distinct keys, so two coins at two addresses need nine
  outputs, each at least 10,000 sats plus its fee and a random spread:
  roughly 180,000 sats at the smallest tier. With 120,000 every attempt
  ended in "Selected inputs cannot afford any fusion tier". `--auto`
  retried every 10 s with a new random bucket choice (47 attempts). Open:
  wait for the wallet to change when no choice of its eligible coins can
  fund a tier, as Auto already waits once every coin is deep enough.
- **Simple Send pays all change to one address.** Both desktop sends above
  paid change to `bchtest:qpxc7u3y3d9fkhneddjy39flv34ywv5qtcfq5j2wu5`. The
  retained UI sends BCH change to the wallet's first address
  (`TransactionService.fetchWalletAddresses` returns `addresses[0]`;
  `preferInternalChangeForBch` is `false`), and here both spent coins were
  fusion outputs, so the shared change address links what the fusion had
  separated. The runtime's spend path (`optn send --wallet`) reserves a new
  change address for every spend. Open: Simple Send's change through the
  runtime's reservation; it is refused for wallets whose keys are still in
  the TypeScript key database, which these were.
- **The desktop's depth record does not survive a hard stop.** The desktop
  logged round 8's depth as recorded ("depths 2-3, 22 coins") two minutes
  before the app was killed; after a restart its record ended at round 7.
  The record lives in renderer storage (localStorage and the sql.js
  database), whose writes reach disk later. Open: the depth record in the
  runtime's encrypted checkpoint, written with the wallet state.
- **Desktop engine sessions, rechecked.** Each finding was reproduced
  before anything was changed:
  - "A secondary window never opens its wallet in the engine" was the test
    harness: it named its windows `send-...`, which the `desktop`
    capability (`main`, `wallet-*`) does not cover. With the app's own
    `wallet-*` label a second window's unlock opens its wallet in the
    engine. The engine holds one wallet per process, so that moves the
    session from the first window, whose sends are then refused with
    "Wallet session is unavailable or changed. Reopen this wallet before
    sending."
  - The failed first refresh was the chain stack still being built: for
    about half a minute after launch or an unlock every refresh failed with
    "Chain source is still connecting", shown as "Wallet refresh
    unavailable". Fixed below ("the first refresh waits for the chain
    stack").
  - `ReorgBeyondWindow { floor: 325540 }` was a one-block chipnet orphan
    sealed in a view with no reorg ring. Fixed below ("a view sealed
    without a reorg ring steps back one block").
  - The wallet whose receive branch reaches index 1,368 refreshed completely
    through the CLI (2,951 addresses, 87 s), and after that the desktop
    refused it every time: "retained wallet scripts are outside this HD
    account or scan cap". Fixed below ("a refresh covers what the last scan
    kept").
  - "Wallet changed or needs a refresh" after reopening the engine by hand
    is the unlock-epoch check doing its job.

### 2026-10-10: a view sealed without a reorg ring steps back one block

#75 (header verification). Found in the fleet run and traced to the block:
chipnet's 325,540 has two blocks, `00000000de317af8...` (06:47) and
`00000000179eff3b...` (06:44), and 325,541 builds on the second. Wallets
here had sealed the first, in a view written before reorg rings were kept.
Such a view restores with no ring and cannot step back even one block, so
every header pass since 2026-09-29 ended in `ReorgBeyondWindow` at its tip:
no header-proven evidence above 325,540, and no verified chain for BIP37
or Neutrino.

A ring is no longer needed for one block. The accumulator keeps only peaks,
but the tip's own proof lists every peak the tip was appended to:

- `MmrAccumulator::before_last_leaf` reads the previous peaks out of the
  last leaf's proof, and `before_append` rebuilds them from the leaves that
  append merged with. Each is accepted only if appending the leaf again
  reproduces the accumulator.
- `ShvMmrHeaderVerifier::parent` is the verifier one block back. The parent
  header is believed because its hash is the tip's previous-block hash, the
  2^m - 1 headers under it because together they reproduce the state the
  view already holds. For 325,539 that is three headers.
- `VerifiedHeaderView::seed_ring` gives a ring-less view that one block of
  ring. A header pass that meets a fork seeds it first, so the existing
  reorg path (more-work check, store rewind) runs unchanged. A fork deeper
  than the tip still refuses, as before.

Tests:
- every MMR shape from 0 to 300 leaves steps back both ways, and corrupt
  or wrong material is refused;
- the parent verifier equals the real one at every height 1 to 70 and
  persists like any other;
- a regtest view sealed without a ring follows a one-block orphan over
  Electrum and BIP37 and seals a ring afterwards, while a two-block orphan
  is refused.

Live: the stuck chipnet wallet followed the chain to 327,171 in one CLI
refresh, header-proven, and its sealed view now carries a ring.

### 2026-10-10: the first refresh waits for the chain stack

#75 / #71. The host rebuilds its chain stack on launch and when the
selection changes, and a refresh that ran meanwhile failed at once with
"Chain source is still connecting". Reproduced right after an unlock: the
manual refresh failed for 24 s, and the worker showed "Wallet refresh
unavailable; retained history remains stale" and backed off 5, 10, 20 s.

`sync_wallet_from` now waits up to two minutes for the build in progress.
Every rebuild wakes waiters however it ends (a drop guard, so cancellation
counts too), and the wait re-checks the installed service each time, so a
stale stack is never used. A build that never lands still fails as before.
Test: a refresh started with no stack waits, then proceeds the moment a
build installs one; with nothing building the wait gives up at its bound.

Live, desktop rebuilt with this: one wallet unlocked right after launch
waited for the stack, refreshed from +19 s and was fresh at +31 s, headers
at the tip.

### 2026-10-10: a refresh covers what the last scan kept

#75. Found in the fleet run: once `optn rescan --max-addresses 3000` had
reached used addresses past index 1,368, every desktop refresh of that
wallet refused "retained wallet scripts are outside this HD account or scan
cap", shown as "Wallet refresh unavailable". A refresh must cover the scope
the last accepted scan kept, and the desktop's discovery budget (200 per
branch, or the issued inventory plus a gap) was smaller than that scope.

The budget now also grows to the longest branch the last scan kept, plus
one gap so that branch can still grow, the same way it grows for issued
addresses. A provider can move it by at most one gap per accepted scan,
never past the 10,000 hard cap; a scan that needs more still fails as
incomplete. Tests: a scan on a larger budget that reaches index 9, then a
refresh on a six-address budget, is accepted with index 9 still in scope;
the cap-failure test pushes past the grown budget.

Live, desktop rebuilt with all three fixes: that wallet (its own sealed
view also at the orphaned 325,540) waited for the stack, refreshed from
+30 s and was fresh at +88 s with headers at the tip, 327,174.

### 2026-10-10: `optn fusion --auto` waits when no choice of coins can fund a tier

Found in the fleet run: a CLI wallet holding 2 x 60,000 sats asked the
server for a round every 10 s for as long as it ran (47 times), each ending
"Selected inputs cannot afford any fusion tier".

Whether a contribution funds a tier is partly chance (Electron Cash draws
the output count), so the CLI now tells two cases apart.
`optn_fusion::allocate::never_affordable` checks the floor every tier
shares: at least `11 - distinct keys` outputs of `MIN_OUTPUT` plus fee, out
of the inputs' value after their own fees and the server's minimum excess
fee. Taken over every eligible coin, it is a bound no subset can beat, so
when it fails the CLI says why and idles until the wallet changes,
re-asking the server each idle period. Above the floor, a miss is the draw,
and retries back off from 20 s, doubling to the 30 min idle wait. A round
that fuses, or a wallet that changes, resets both. `server_round::server_hello`
is the hello a round already fetched, now also callable on its own.

Test: for 1 to 6 keys at 5,000 to 400,000 sats each, whenever "never" is
claimed, forty different draws all fail to fund a tier; one 60,000 coin is
never affordable and two at two addresses are not.

### 2026-10-10: one Rust Nostr layer for P2P CashFusion and chat

#83. P2P CashFusion and chat reach Nostr only from the desktop renderer,
through nostr-tools, so the CLI and the docker runner cannot take part in a
P2P round, and every relay decision lives in TypeScript. `crates/optn-nostr`
is the Rust side both will use:

- `Relays` reaches a set of relays through `RelayRoute::Tor(socks)` (remote
  relays through the holder's verified Tor proxy, relays on this machine
  directly) or `RelayRoute::LocalOnly`, which refuses a remote relay rather
  than reach it without Tor. Publishing succeeds when at least one relay
  accepts and reports the rest; subscriptions stream each event once.
- `nip17::wrap` / `nip17::unwrap`: NIP-17 private messages (kind-14 rumor,
  sealed and gift-wrapped per NIP-59). Opening verifies the outer event and
  the seal, accepts only a kind-14 rumor, and refuses a rumor whose author is
  not the key that sealed it.

Built on rust-nostr's maintained 0.45 line (`nostr` 0.45.5, `nostr-sdk`
0.45.4). The research behind the choice: the "unmaintained" notice on
`nostr-relay-pool` (RUSTSEC-2026-0243) means it moved into `nostr-sdk` 0.45;
0.44.0-0.44.4 are yanked over 2026 advisories (signature cache, NIP-44 and
NIP-04 parsing, credentials in debug output) that 0.44.5+ and 0.45 fix. MDK
(Marmot's Rust MLS kit) stopped publishing a library after `mdk-core` 0.8.0
and pins git forks of openmls and rust-nostr, which `deny.toml` refuses, so
the chat port will use `mdk-core` 0.8.0 from crates.io and bridge events to
0.45 as JSON.

Tests: a local relay carries a published event to a subscriber; remote
relays are refused without Tor; an unreachable relay is reported; NIP-17
wraps open only for their receiver and refuse tampering and non-message
rumors. Interop: `test-vectors/nostr-nip17-interop.json` holds one wrap made
by nostr-tools and one by rust-nostr; Rust opens both, and a vitest beside
the TypeScript transport opens both with nostr-tools. cargo-deny passes.

### 2026-10-10: Marmot chat through MDK, beside ts-mls

#83, continuing the Rust Nostr layer. The holder asked to port the chat to
MDK, keeping the ts-mls engine as the fallback so nothing is lost, and to use
MDK as published. `crates/optn-chat` drives `mdk-core` 0.8.0 unmodified over
`optn-nostr`. The desktop runs it behind the `mdk-chat` build feature
(`src-tauri/src/chat_mdk.rs`), and the chat screen reaches both engines through
`mlsEngine.ts`. With "Marmot groups through MDK" on in the Nostr settings, new
open groups go to MDK. Every other group, private groups and Paytaca stay on
ts-mls, and both engines read the same inbox. `docs/chat-mdk.md` lists what
MDK does and does not do; each gap was checked against MDK's source.

- Store: MDK's SQLCipher store, keyed with HKDF-SHA256 of the chat identity's
  secret. MDK's in-memory store cannot be exported (its snapshot type has
  private fields), so it serves the tests only. On Windows, SQLCipher's
  OpenSSL is built from source and needs Strawberry Perl as `OPENSSL_SRC_PERL`;
  Git's Perl lacks `Locale::Maketext::Simple`, `IPC::Cmd` and others.
- Relays: `optn-nostr` gained `nip59` (gift wraps for any rumor; Marmot
  welcomes are kind 444), targeted publish, fetch and subscribe for a group's
  own relays, and `RelayRoute::Dialer`. Through the dialer the desktop's
  egress opens every relay stream (Tor switch, own hosts, public addresses
  only, plain `ws` only on this machine), and rust-nostr runs the WebSocket over
  it.
- Three faults found while testing, fixed in the engine:
  1. MDK returns a welcome it has already handled, and accepting it again
     rebuilt the group from the welcome's epoch. Only a pending welcome is
     accepted now.
  2. A member's post-join self-update could share a second with the commit
     that added them. Relays order by `created_at` only, and MDK never retries
     an event it failed to read, so a reader taking them in the wrong order
     fell an epoch behind for good. Nothing is now published in the second of
     the newest commit the engine made or read (or the welcome it joined by),
     waiting up to 3 s.
  3. A commit made from a stale epoch forked the group and lost under MIP-03.
     Each commit is now preceded by reading the group's latest events.
- The chat screen showed no group texts from others: MLS group messages are
  kind 9 (ts-mls's own `innerKind9` too), and the thread and inbox counted
  only kinds 14 and 15. Kind 9 counts now.
- Dependency policy: MDK's OpenMLS crypto brings `hpke-rs` 0.6.1, and with it
  `libcrux-sha3` 0.0.8 and `libcrux-secrets` 0.0.5. No hpke-rs 0.6 release
  takes the fixed libcrux, and their advisories (RUSTSEC-2026-0207, -0208,
  -0212) sit on paths ciphersuite 0x0001 never reaches (SHAKE only for X-Wing
  and ML-KEM keys, and only one-shot). `deny.toml` and
  `src-tauri/.cargo/audit.toml` hold each one with its reason and its removal
  condition. The audit file also holds the five advisories of hpke-rs's
  libcrux backend, which nothing enables and which appears only in
  `Cargo.lock`. `lru` 0.16.4 (RUSTSEC-2026-0253) comes with MDK's memory
  store, now a test-only dependency.

Tests:
- Three engines on a local relay take a group from invitation to leaving,
  in 10 runs out of 10: a member without a key package is refused before
  anything is made; then welcome, messages both ways (each read once however
  often caught up), a file with its type and name, rename, live listening,
  adding, removing (the removed member's group goes inactive), and a leave
  committed by the admin.
- With `sqlite`, a reopened store keeps its group, history and epoch and reads
  on. The file has no SQLite header and no plaintext, and another identity's
  key does not open it.
- `optn-nostr`: 12 tests. Frontend: the facade sends each call to its
  engine, and MDK events become chat messages and groups; the inbox counts
  kind 9. 224 chat, nostr, state and i18n tests pass.
- The desktop passes clippy with and without `mdk-chat`. cargo-deny passes
  for the root and the desktop, and cargo audit passes for the desktop.
- Live, opt-in (`tests/live_relays.rs`): two throwaway identities on
  relay.damus.io, nos.lol and relay.primal.net, through a local Tor. All
  three relays took the key package, the invitee joined 1.5 s after the group
  was made, and messages crossed both ways in about 1 s each.

### 2026-10-10: the fusion depth record is sealed with the wallet

#83, from the fleet runs: the CLI kept each wallet's CashFusion depth record
(`optn_core::fusion::depth`) in a plaintext file beside the wallet. The
desktop renderer kept it in localStorage, which WebView2 writes back lazily,
and a hard stop lost a recorded round.

- Runtime: the record is part of the wallet's state (`AppState::fusion_depth`).
  It is sealed in the encrypted checkpoint as one more field, written only
  once a round has been recorded. A wallet that never fused stays readable by
  earlier builds, and a build that does not know the field refuses a
  checkpoint that has it, as with every field added before. Restored on open,
  never taken from the wire.
  - `AppRuntime::record_fusion_round` saves a round with the checkpoint before
    it returns.
  - `AppRuntime::import_fusion_depth` merges a record kept elsewhere; the
    deeper entry wins.
  - Both ask only that the same wallet session is still open. A wallet
    operation's guard also refuses whenever coins are not fresh, and a
    finished round's result must be kept whatever a refresh does meanwhile.
- CLI: `optn fusion` reads and records through the runtime. The plaintext file
  an earlier build left is merged in once and removed (`depth_imported`
  event).
- Desktop renderer wallets (keys in the renderer's key database) have no
  runtime checkpoint. After each change their record is sealed with the
  wallet's password-derived key (the desktop's SecretCryptoService) and
  handed to the host (`fusion_depth_store.rs`), which writes it whole, flushed
  and renamed into place before answering. The host stores only `enc:v1:`
  ciphertext. On wallet open (`hydrateFusionLabels`) the sealed copy is merged
  back in, the deeper entry winning, and a book from before this build gets
  its first sealed copy. A record is sealed only while its own wallet's key is
  the unlocked one. Seals are chained per wallet, so the last write is the
  newest book.

Tests:
- A recorded round, and a second one on its output, survive a fresh runtime
  over the same storage (sealed bytes, opened again).
- A round whose save fails is not recorded. An import keeps deeper entries
  and adds txids, and a shallower copy lowers nothing.
- The checkpoint carries no `fusion_depth` until there is a record.
- CLI: an earlier build's file is sealed and removed, and reads back from a
  new runtime.
- Host: only ciphertext is stored, kept whole, with no partial file left.
- Renderer: a round a hard stop took from localStorage comes back from the
  sealed copy; nothing is sealed under another wallet's key; an old book gets
  its first sealed copy.
- Suites: optn-app 176, optn-runtime 419, optn-transport 26, the CLI's fusion
  tests, and the renderer's depth and fusion suites (68) pass. Clippy is
  strict for the workspace, the CLI and the desktop.

### 2026-10-10: BCH P2P nodes from the node implementations' DNS seeds

#75 §21.3 asks for BCH P2P discovery from BCHN, Flowee the Hub, bchd and
Knuth, with provenance kept where their lists overlap. The 2026-10-08 row for
the P2P side closes, and with it the last gap of row 1.

- Catalog: each project's DNS seeds, read from its source at a pinned commit
  (`bootstrap/p2p_seeds.json`; the bootstrap README records the commits and
  the review). A seed several projects list is one candidate credited to
  each: `seed.bchd.cash` to all four, `dnsseed.electroncash.de` to Knuth
  alone. Seeds rank after the Electrum servers, so under Auto wallet
  operations still go to a server first.
- A seed is an endpoint kind of its own (`p2p-seed`), not a peer. A seed name
  resolves to a different node on each lookup. The BIP37 adapter opens a
  connection per request, and under Tor each one takes a new circuit. A seed
  dialled as a peer would be a different node each time, and the capabilities
  probed on one would be claimed for the next. So the nodes a seed names are
  the peers, and the seed is how they are found:
  - Tor off: a DNS lookup, as a full node does.
  - Tor on: the name goes to Tor and is never looked up here (#75 §4.1). The
    node it leads to is asked for addresses (`getaddr`), then the connection
    is closed. This is Bitcoin Core's addrfetch, which BCHN's seed list
    relies on too.
- Only public addresses on the port the seed was asked for are dialled. A seed,
  or the node it led to, cannot point the wallet at this machine, its LAN or
  another service. Chipnet and testnet4 share a P2P magic; their ports keep
  their nodes apart.
- Nodes found become discovered sources (`bootstrap:p2p:<ip>:<port>`), by IP
  address only. They are listed, disabled or banned like discovered servers,
  and never selected under own-infrastructure-only. They are cached beside the
  servers, bounded apart from them; earlier builds skip them.
- Builder (`build_native_chain_stack_with_tor_status`): P2P nodes are the last
  resort of a public scope (#75 §5.2). They are dialled only while nothing
  else gave a wallet route, two at a time and eight at most; the rest are held
  back for failover. Known nodes come first. Seeds are asked only when none of
  those answers: three at once, with each answer used as it arrives, since
  through Tor a node may hold its `getaddr` reply for most of a minute. Under
  Auto with a working server, no seed is asked.
- A seed may name a node the holder banned. The cache now keeps every peer
  the holder set a disposition for, however long since anything named it. The
  ban is therefore in the catalog when the seed answers, and the node is not
  admitted.
- The BIP37, Neutrino and Electrum adapters now pass the SOCKS target as host
  and port. Formatted as one string, an IPv6 literal had no brackets, and the
  proxy was sent it as a name to resolve.
- A stack that may need to ask a seed through Tor now looks for Tor. Before
  this, Privacy, BIP37-only and Neutrino-only had nothing to connect to on a
  fresh install.

Tests:
- Runtime:
  - every list is the one its upstream file has (a script, recorded in the README);
  - provenance is merged across projects;
  - a seed is never a route, and ranks after the servers;
  - a node is listed by address only, and bounded apart from servers.
- BIP37: `addr` decoding; an addrfetch waits past a self-announcement; the deadline.
- Builder:
  - a P2P-only wallet with no node known asks a seed and connects;
  - a working server leaves seeds unasked and holds nodes back, and those
    nodes are dialled on failover;
  - a node the holder banned stays banned when a seed names it;
  - with Tor on and no Tor, a public seed is reported, not asked;
  - end to end through a SOCKS proxy, the seed is asked by name and its nodes
    by address, IPv6 included.
- Cache: nodes beside servers, earlier builds skip them, and peers with a
  disposition are kept.
- Live, opt-in (`optn-chain-bip37/tests/seed_live.rs`):
  - seed.flowee.cash, btccash-seeder.bitcoinunlimited.info,
    seed.bch.loping.net and seed.bchd.cash each named 25 to 51 nodes;
  - a node they named answered `getaddr` with 64 full nodes in 1.1 s. On an
    earlier attempt it sent its own address and held the rest past 20 s.
- Suites:
  - the root workspace passes (optn-runtime 422), as do the desktop (144) and
    the CLI; clippy is strict for all three;
  - `managed_spend_refuses_without_shared_runtime_coin_freshness` was failing
    on every OS, not only on Windows as first read. `b43c43e3` made `send`
    sync before spending, so with no route the refusal is "HD rescan
    incomplete", not the runtime's freshness message; the test now asserts
    that, against a server that hangs up at once (a refused loopback connect
    takes 2 s on Windows, past the test's 1 s timeout). cli-preview does not
    run on this PR, which is why CI did not show it.

### 2026-10-15: the P2P CashFusion protocol in Rust

The P2P round the desktop runs in TypeScript (`src/platform/desktop/nostr/`)
is now also in `crates/optn-fusion/src/p2p`, as pure state machines: messages
and the time in, messages and actions out. Ported rule for rule, each cited at
its definition:

- `wire`: the v4 round messages and the strict parser.
- `pool`: announcements, the live filter, group selection and the set-bound
  election.
- `onion`: the output onion (ECDH, AES-256-GCM, the fixed 384-byte block).
- `assemble`: the canonical CoinJoin, the signing gate, the final check.
- `credentials`: slots, blind requests, the one-shot issuer, Pedersen balance
  and output batches.
- `blame`: prove-or-don't-blame reports, created and verified.
- `allocation`: output planning.
- `rendezvous`: proposal, ACK, one shrink, ghost failover.
- `session`: the round as coordinator or participant.

Evidence:

- TypeScript to Rust: `scripts/generate-p2p-fusion-vectors.mts` writes
  `test-vectors/p2p-fusion.json` from the desktop's own code. Rust reproduces
  every value (`p2p::vectors`):
  - the elected coordinator and the group that forms;
  - the canonical order (`"…:10"` before `"…:9"`) and the fee gate's
    verdicts, reason strings included;
  - a libauth-signed transaction, finalized byte for byte and verified;
  - a TypeScript onion peeled;
  - the credential hashes;
  - all 35 parser verdicts and all 8 blame verdicts;
  - a byte-identical announcement and identical output plans.
- Rust to TypeScript: `cargo run -p optn-fusion --example p2p_fusion_vectors`
  writes `test-vectors/p2p-fusion-rust.json`, and
  `nostr/__tests__/p2pRustInterop.test.ts` passes it through the functions a
  live round uses:
  - every message kind through `parseRoundMessage`;
  - the onion through `onionPeel`;
  - Rust-issued credentials through the coordinator's checks;
  - the same assembly;
  - a Rust-signed CoinJoin through libauth's BCH VM.
- Whole rounds (`p2p::sim`): in-memory peers on a simulated clock, every
  message through JSON and the parser, every component from a throwaway key.
  - Four and six peers fuse one transaction that verifies.
  - Two silent peers shrink six to the ACKed four.
  - A peer whose inputs never arrive fails the round with no broadcast.
  - A coordinator that drops an output gets no signature from its owner.
  - An unbalanced Pedersen claim is blamed, and every peer verifies the
    report.
  - Wrapping the onion in the wrong order fails five of these tests, four of
    them whole rounds.
- optn-fusion: 167 tests, strict clippy and rustfmt.

Not yet: the host that carries these machines over Nostr and Tor, `optn fusion
--p2p`, the docker lab's P2P mode, and a live chipnet round mixing Rust and
TypeScript peers.

### 2026-10-15: the Rust P2P host, `optn fusion --p2p` and the lab's P2P mode

`crates/optn-fusion-native/src/p2p_round.rs` carries the `p2p` state machines
over Nostr and Tor, as `FusionP2pService.ts` does on the desktop:

- Relays through `optn-nostr`. A remote relay is dialled through the verified
  Tor proxy with fresh isolation credentials per connection; a loopback relay
  directly.
- The desktop's gather policy (`collectRolling`), then the rendezvous and the
  round. A transaction component goes under a throwaway key on a one-shot
  connection; the control plane under the round key.
- Keys and fresh outputs come from the wallet runtime. Signing goes through
  the native boundary (`p2p::signer`). The coordinator broadcasts through the
  round's own Electrum connections (`ChainInputLookups::broadcast`), and the
  host waits for a selected server to hold the transaction.
- Every publish is retried up to three times (400 ms, then 800 ms), and pool
  announcements need two relays when there are two, as
  `publishEventAtLeastOnce` does. A settled round lets its last publishes land
  before it withdraws its key and closes.

Found and fixed under the relay test:

- The coordinator's `final` was never sent. A broadcast's outcome queues
  `final` and settles the round in the same call, and the host returned on
  the outcome before taking those actions. Participants then waited out the
  whole round timeout, about six minutes for ten peers.
- The relays were closed under publishes still in flight.
- A publish a relay refused was dropped, with no retry.
- The host marked its own round key as a ghost when the round started, so
  peers in one process ignored each other. It now does this when the key is
  withdrawn (`retireRoundKey`).

Evidence:

- `tests/p2p_local_relay.rs`: ten hosts, each with its own relay connection
  and round key, through nostr-sdk's in-process relay. They gather, agree,
  take credentials, peel the onion, assemble, sign and broadcast in about 15
  s. Every peer returns the same txid. The transaction verifies against the
  template rebuilt from every peer's inputs and the outputs, and pays exactly
  the outputs the peers reserved. With either of the first two bugs above
  restored, the test fails.
- optn-fusion 168 tests, optn-fusion-native 13 plus the relay test, the CLI
  156; strict clippy for both crates and the CLI; rustfmt.
- `cargo deny` for the root, `src-tauri` and `optn-core`; `cargo audit` for
  `src-tauri`. The CLI's lock gains the `optn-nostr` tree at the root's
  versions and changes nothing it already locked; `src-tauri`'s gains only the
  new edges. All six locks pass `--locked`.

Relay budget (open): a ten-peer coordinator publishes about 220
control-plane events on its one connection in its first minute. Measured in
this test: 117 `onion_declare` attempts (nine peelers, sent once and resent
twelve times until assembly), 45 proposals, and params, responses,
`assembled` and `final`. nostr-sdk's local relay allows 60 per connection per
minute by default and refuses the rest with "rate-limited". Under that limit
the coordinator's credential responses were refused and the round failed. The
desktop coordinator keeps the same cadence (`fusionSession.ts`: declare to
the whole mix order every `P2P_ONION_DECLARE_RESEND_MS`, up to
`P2P_ONION_DECLARE_RESEND_MAX`, until assembled). Same-window desktop peers
also reach each other over `BroadcastChannel`, which no relay limits. The
test sets 1,200 per minute. Lowering the volume would change the protocol on
both sides, so that is left for review.

CLI and lab:

- `optn fusion --p2p [--relay URL]...` runs the same loop as server rounds:
  P2P coin selection (`FusionMode::P2p`), depth recording, Ctrl-C through the
  round. The desktop's six relays are used when none is named. Each relay host
  must be on Tor by the holder's transport, as a server host is. `--tier` is
  for server rounds only, since a P2P pool agrees its own tier.
- `packages/docker-dev/scripts/fusion-lab-headless.sh` runs
  `optn fusion --p2p --auto` for `OPTN_FUSION_MODE=p2p`, which is already the
  compose default (it used to refuse it and exit). `OPTN_FUSION_RELAYS` names
  relays; `OPTN_FUSION_TIER` is refused in P2P mode.

Not yet: a live chipnet round mixing Rust and TypeScript peers. It needs six
funded wallets online with Tor on public relays, where the relay budget above
applies.

### 2026-10-15: a live mixed P2P round does not fuse: the Rust host loses its anonymous components

Run on chipnet against `bd21524f`, with seven wallets on public relays (the
desktop's six unless a round says otherwise). The test-only pieces stay outside
the repository:

- Four Rust peers, each running `optn fusion --p2p --yes` (the CLI built from
  `bd21524f`) on a wallet in its own directory. Two are new wallets, funded
  with 140,000 sats each from the 2026-10-09 fleet's CLI w1
  (`7f9b3b30cafff31952c1ccc1cb31d412fba712606430b25d555be1efd434063f`,
  `41e44047b0d55ec05768734f9a4c185d8d061bb93208de77b7e6efeedfcb5cde`). The
  other two are that fleet's CLI w1 (135,967 sats left) and w2 (120,000).
- Three TypeScript peers: the desktop debug build from `bd21524f`, one window
  each for fleet wallets #7, #8 and #9 (about 1.2M sats each). Each window
  pressed Start P2P round with Auto off, driven over the WebView2 DevTools
  port.
- The CLI scans its wallet first (about 10 s), so the desktop was pressed when
  the first CLI reached its round.
- The CLI peers announced the 10,000 and 100,000 tiers, and the desktop
  peers 1,000,000 as well. Groups formed at 100,000.
- In rounds A to D one Tor daemon served all seven peers. In E and F each CLI
  had its own (`--network-config-dir` naming its own `trusted_socks_ports`),
  and the desktop kept one.

None of the six rounds fused. Nothing was broadcast and no coin moved. The CLI
balances read back unchanged afterwards, and so did the desktop's depth books,
read after round D.

| Round | CLI build, relays, Tor | Agreed | Coordinator | Furthest step | Ended with |
| --- | --- | --- | --- | --- | --- |
| A | stock, six, shared | 7 | Rust | onion: desktop hops 2, 3 and 5 saw 0/31 blobs | "fusion round timed out (coord: inputs signed 0/0, assembled=false)" |
| B | trace, six, shared | 5 | Rust | onion hop 1 peeled | the same |
| C | trace, six, shared | 7 | Rust | coordinator holds 3 of 23 inputs | the same |
| D | trace, primal and snort, shared | 7 | Rust | coordinator holds no inputs | "All 7 peers marked ready but outputs never arrived (batches=0, peelers=6)" |
| E | stock, primal and snort, one per CLI | 6 | desktop | onion hops 1-3 peeled (Rust, Rust, desktop) | "All 6 peers marked ready but outputs never arrived (outputSlots=0/1, anonBatches=0, pool=0, onion=on, peelers=5)" |
| F | stock, six, one per CLI | none | none | rendezvous | "round acknowledgments timed out (only 3/5 answered)"; two CLI peers never saw six |

"Stock" is the unmodified build. "Trace" is that build plus stderr
logging of each publish (relays accepted and refused), each gift wrap opened,
and each one-shot connection's outcome. It was built from a scratch worktree
and never committed.

What works live between the two implementations:

- Discovery: Rust and TypeScript announcements find each other on public
  relays, and all seven agreed in A, C and D.
- Credentials in both directions. TypeScript participants took blind
  credentials from a Rust coordinator (A to D), and Rust participants from a
  TypeScript coordinator (E).
- The onion across implementations. In E a Rust peeler fed a Rust peeler,
  which fed a desktop peeler; that one peeled 30/30 blobs and forwarded them.

Why the rounds failed: the Rust host loses anonymous components.

- Every anonymous component (`inputs`, `outputs`, `onion_output`, `signature`)
  leaves on a one-shot `Relays::connect`. `FusionRelayDialer` gives every relay
  stream fresh SOCKS credentials, so each component needs six new circuits,
  and each resend six more. A peer registering eight inputs asks Tor for 48
  circuits at once.
- Tor keeps at most 32 general-purpose circuits pending: "we already have 32
  general-purpose client circuits pending. Waiting until some finish." On the
  shared daemon that line was suppressed 751 times in the 14 minutes to 19:12
  and 7,052 times in the 14 minutes to 19:26. The same daemon logged 422
  "Giving up" connection failures over the run. In E, two of the per-CLI
  daemons hit the cap too, with only two relays.
- The one-shot connection then fails, with "Tor SOCKS5 connection failed:
  Proxy server unreachable" or "timed out connecting … over Tor" at the 25 s
  `CONNECT_TIMEOUT`. The host drops the component without a word
  (`if let Ok(one_shot) = …`).
- `inputs` is sent once, with no resend. In C all eight inputs from the old
  CLI w1 failed to connect; in D all 11 Rust inputs did. `onion_output` has a
  resend timer and got through later (in C, 61 of 189 one-shots connected). A
  coordinator missing inputs never assembles, so every round reached its
  timeout.
- None of the desktop's 12 inputs reached the Rust coordinator in C or D,
  although its onion blobs did reach Rust peelers (B and E). The desktop's
  Nostr sockets (`nostr_tor.rs`, `connect_stream`) also take a fresh circuit
  each, and in A to D the desktop shared the saturated Tor. (Corrected: an
  earlier version of this entry said the desktop isolates per relay host; that
  is its HTTP egress, `egress.rs`, not its Nostr sockets.) The renderer logs no
  per-relay publish result, so this part is not traced.

Relay refusals, from the trace build in B and C: the four CLI peers made 1,367
publish attempts to six relays.

- relay.damus.io: "rate-limited: you are noting too much" (14) after about
  five events, then "banned: too many rate-limit violations, try again later"
  (663).
- offchain.pub: "Policy violated and pubkey is not in our web of trust." (107),
  for throwaway keys. Otherwise it timed out (1,117).
- nostr.oxtr.dev: "rate limited" (3) and timeouts (900). nos.lol: timeouts
  (667).
- "invalid: event expired" (34) from primal, damus, nos.lol, oxtr and
  offchain. "replaced: have newer event" for pool re-announcements, from both
  implementations.
- Accepted: relay.snort.social 1,223, relay.primal.net 1,210, nos.lol 568,
  nostr.oxtr.dev 334, relay.damus.io 128, offchain.pub 15. Six relays are
  configured, but two carried the rounds.

Coordinator volume, measured live:

- In C the Rust coordinator made 307 publish attempts in its first minute,
  more than the relay test's 220: 158 `onion_declare`, 77
  `credential_params`, 30 `round_proposal`, 21 `onion_output` and 12
  `credential_response`.
- In B it made 260 `round_proposal` attempts while a seven-wallet proposal
  shrank to five.
- Protocol timing and resend volume were not changed. The relay budget is
  still for review.

The desktop's view of the pool was thinner than the CLI's on the same relays.
In B two windows gave up ("P2P Fusion needs at least 6 peers") after seeing at
most three peers, while the CLI peers saw seven. In E one window gave up with
"No peers left (peak was 3, now only you)".

Not yet:

- The Rust host needs to reuse circuits for one-shot connections: one circuit
  per component, or per relay host. It also needs to
  retry an `inputs` (and `signature`) send that never connected, and to report
  a dropped publish.
- After that, this round needs to be rerun. The four CLI wallets and the three
  desktop wallets above still hold their funding.

### 2026-10-15: one circuit per component, paced; a mixed round reaches a signed CoinJoin

The Rust host's half of "a live mixed P2P round does not fuse", in
`crates/optn-fusion-native/src/p2p_round.rs` (`15660a33`, `9e85a086`):

- A one-shot connection gives all of its relay streams one SOCKS credential of
  its own (`optn_fusion::connect_stream_isolated`). Each component therefore
  travels on one circuit instead of six, and still shares it with no other
  component. The shared connection keeps one circuit per relay stream.
- `inputs` and the last peeler's `outputs` are sent only once, so each gets up
  to three connections, every one on a fresh circuit. Onion blobs and
  signatures already have resend timers, so they are not retried here.
- A message no relay took now appears as a status line, one per wire type:
  "N inputs message(s) reached no relay: …".
- At most 16 one-shot connections open at once. Tor keeps at most 32 circuits
  pending, and the shared connection holds six.
- A resend is skipped while the same component, to the same recipient, is
  still queued or connecting. Once that copy settles, resends go out as
  before.
- A one-shot connection waits 10 s for its relays and then publishes on the
  ones it reached.
- Protocol timers and resend counts are unchanged.

Correction to the entry above: tokio-socks reports "Proxy server unreachable"
when it cannot open the TCP connection to Tor's SOCKS port at all. It is not a
circuit failure. In the first rerun below, a Rust peeler's own Tor refused
those connections while the peeler forwarded thirty blobs every two seconds;
the pacing above is the answer to that.

Tests (`p2p_round::tests`); each fails with its change reverted:

- A recording SOCKS5 proxy sees one username for all of a component's streams,
  a different one for the next component, and a fresh one for each
  shared-connection stream.
- `inputs` whose first connection is refused reach the relay on the second.
- A component no relay takes is reported, and only `inputs` and `outputs` are
  retried.
- Copies of a blob that is still connecting take one connection, and a resend
  after it settles takes another.
- Five components with two turns never have more than two connections open.

Checks run on the branch merged with `dbe3565d`:

- optn-fusion-native: 23 tests plus the ten-peer relay round.
- optn-fusion: 168 tests.
- Strict clippy and rustfmt for both crates.
- The CLI's 156 tests and strict clippy.
- `cargo check` for `src-tauri`.

The live rerun used the same wallets on the desktop's six relays, with the CLI
built from these commits and the desktop app from `15660a33`. Its TypeScript is
unchanged. Each CLI peer had its own Tor (`--network-config-dir` naming its own
`trusted_socks_ports`). The desktop windows were wallets #7, #8 and #9, then
#7, #8 and #10 once #9 refused to start.

| Round | CLI | Agreed | Coordinator | Furthest step | Ended with |
| --- | --- | --- | --- | --- | --- |
| G | `15660a33` | 7 | desktop | hops 1-3 (Rust, desktop, Rust) | "All 7 peers marked ready but outputs never arrived"; Rust peers reported 231 dropped messages ("Proxy server unreachable") |
| H | `9e85a086` | 7 | desktop | all six hops (four Rust, two desktop); assembled; all 24 inputs signed; broadcast `653e6c71c7f8c3645b5aac08ebebd727567588ff6021362fcedbedb8b1dc64e3` | the other peers' "fusion round timed out (after assemble/sign …)" 20 s before the broadcast returned; chipnet never had the transaction |
| I | `9e85a086` | 6 | Rust | hops 1-2 (desktop) | hop 3 (Rust) received nothing: "outputs never arrived (batches=0, peelers=5)" |
| J | `9e85a086` | 6 of 7 | Rust | onion: hop 1 (Rust) incomplete | "fusion round timed out (coord: inputs signed 0/0, assembled=false)" |
| K | `9e85a086` and receive trace | 6 of 7 | Rust | coordinator holds all 16 inputs and six of six ready; hop 1 (desktop) done | hop 2 (Rust) received none of the desktop's 20 blobs |
| L | `9e85a086` | 7 | Rust | hop 1 (desktop) done | the same at hop 2 (Rust) |

What is now fixed live:

- After the pacing change, Rust peers dropped 0, 0, 1 and 0 messages in rounds
  H to K, against 231 in G.
- The Rust coordinator received every input. In K it held all 16, six of them
  the desktop's. In the traced rounds before the fix (C and D) it held 3 of 23
  and 0 of 23.
- Hops worked in all three directions: Rust to Rust, Rust to desktop and
  desktop to Rust (G, H).

Round H, in detail:

- It went from announcement to a CoinJoin signed by all seven wallets.
- The participants' deadline is 35 s plus 36 s per peeler, so 251 s for six.
  The onion took about 190 s of it.
- The desktop coordinator's broadcast took 50 s and ended with "Broadcast was
  sent over Tor, but independent network visibility is still pending". It
  goes through `chipnet.bitjson.com:48333`, observed from
  `seed.cbch.loping.net:48333`. Both answer through Tor.
- Three chipnet Electrum servers still answer "No such mempool or blockchain
  transaction".
- The signed bytes stay sealed in the desktop, which now keeps wallet #9's
  coins reserved for them. #9 therefore refused later rounds: "A previous
  Fusion transaction is still awaiting …".

Not yet:

- Blobs a desktop peeler forwarded to a Rust peeler did not arrive in I, K or
  L, although the same direction worked in G and H.
  - In K the Rust peers kept receiving `onion_declare` and the coordinator's
    `abort` throughout, so their subscriptions were alive.
  - The renderer logs no per-relay publish result, so the desktop side is not
    traced.
  - One candidate, not verified: the desktop's one-shot pool returns on its
    first relay acknowledgement and closes `ONE_SHOT_POOL_LINGER_MS` later.
    The Rust peers mostly hear through relay.primal.net and relay.snort.social,
    because damus bans their exits and offchain.pub, oxtr and nos.lol time out.
- A six-hop onion leaves about 60 s for signing, broadcast and `final`, and a
  desktop coordinator's broadcast took 50 s.
- Both sit outside the Rust host (the desktop's transport and the protocol's
  timing), so they are left for review.
- Nothing was broadcast that chipnet holds. The four CLI wallets still hold
  their funding.

### 2026-10-15: the desktop's CashFusion runs on the shared Rust driver

For #71/#75/#83 (`98dfc78b`, `9212c1a7`, `1d619374`): the desktop now fuses
through `optn_fusion_native::driver`, the loop `optn fusion` and the docker lab
run. The renderer names a venue, starts or stops a run, and shows what the
driver reports.

- `optn_fusion_start`, `optn_fusion_stop` and `optn_fusion_running`
  (`src-tauri/src/fusion_driver.rs`) take a venue: CashFusion servers (the
  holder's choice, then the rest, tried in order) or P2P (the Rust host's
  relay set). Coins, keys, holds, the round, the depth record and Auto's timing
  stay in Rust. Progress reaches the renderer as `optn://fusion-event`, and the
  end of a run as `optn://fusion-finished`.
- A run fuses only the wallet session it was started for. The request names
  the wallet id and epoch, checked as a send checks them, and checked again
  before every round. A locked, closed or switched wallet ends the run. Every
  event names its wallet.
- The driver's `round` event lists the coins the round holds, and a `released`
  event follows the hold's drop. The renderer mirrors them into
  `fusionRoundState`, which the send screens read synchronously. The hold
  itself is the runtime's.
- `optn_fusion_depth` and `optn_fusion_depth_import` merge the renderer's older
  depth record into the runtime's sealed one, and bring the runtime's back for
  the badges, on wallet open and after each round.
- Renderer: `nativeFusion.ts` (the bridge), `FusionRunnerService` (a view of
  the events), `useAutoFusion` (Auto is one native run, restarted between
  rounds when its settings change) and the Settings start handlers.
- Removed: the TypeScript round runners (`ServerFusionRunner`,
  `FusionP2pService`, `FusionService`) and their coin selection,
  pre-consolidation, server failover, completion, depth recorder, execution
  safety and lease code, with their tests. Also removed: the Tauri commands
  only they called, among them `fusion_run`, which took private keys from the
  renderer, and `fusion_p2p_sign`. The `nostr/` TypeScript protocol stays as
  the interop parity oracle.

What changed in behaviour:

- A crowded address (more than three plain coins) now fuses its three
  largest coins, as the CLI does. The renderer no longer sends a consolidation
  transaction first; pre-consolidation in the runtime is open.
- Auto's cooldowns live in the run and do not survive a restart. Auto still
  needs an explicit start after a wallet opens.
- The P2P stepper follows the round again. `p2p_round` used to drop the
  engine's `Action::Phase`; it now forwards each step, and the driver reports
  it as a `phase` event with the same numbers the TypeScript session used.
  The ten-peer relay test checks that every peer reports registering (2) and
  finishing (7), and fails with the forwarding removed.
- A desktop built from these commits is a Rust peer in P2P rounds. A mixed
  round needs a desktop build from before `9212c1a7` for its TypeScript side.

Checks run on the merge with `fca7ff2c`:

- `test:core`: 1853 tests in 302 files, after the identity-isolation audit's
  file-walk check names `FusionRunnerService.ts` in place of the deleted
  `FusionP2pService.ts`. `test:ui`: 50 tests.
- `typecheck:core`, `lint:core`, `deps:check`, `security:test` and
  `addons:validate`. `format:check` fails locally on 91 files this change does
  not touch, because the Windows checkout has CRLF line endings.
- `FusionRunnerService`: 12 tests. The hold-mirror test fails with its
  reservation call removed.
- `src-tauri`: 145 tests and strict clippy without default features, including
  6 for `fusion_driver`.
- optn-fusion-native: 28 tests plus the ten-peer relay round. The CLI's tests
  and strict clippy.
- `xtask architecture`, rustfmt, and all six lock files with `--locked`.

Run live on 2026-10-16: see the next entry.

### 2026-10-16: the desktop on the shared driver, live on chipnet

The desktop build of `4ebcfa23` and later, against a local Electron Cash
fusion server, Tor daemons of the lab's own, and the CLI built from the same
commits. Each desktop wallet ran in an app instance of its own, because the
desktop's engine holds one wallet (below). Driven over the WebView2 DevTools
port, with the driver's raw events recorded in every window.

| Round | Who | Transaction | Chain |
| --- | --- | --- | --- |
| Server, manual | desktop #3, #4, #6 | `5121b20bfb72841f0e5a1690a211fd4b68d6d26c88331f3f41386d56601ecfaa` | block 328096, 29 in / 19 out |
| P2P, manual | six CLI peers, each on its own Tor | `6d245db58701fe742c766fbe5edf00c021031e62589a0571cfc30d62ef514883` | block 328105, 14 in / 25 out |
| P2P, manual | desktop #7 and six CLI peers | `ed20ff2dad56966cbcf792ab232cfdec0d06bb401a599785d99e8f6b703c450d` | block 328106, 28 in / 22 out |
| Server, manual, then Auto | desktop #3, #4 | `e303c566859a66600311866f16597cc8c19362bce5d19c257622cd7456c046d8`, then `1c80a2d2…`, `e41324af…`, `583a67b5…` | the first in the mempool when checked |

The explorer (`bch-explorer-inspect`, chipnet) confirmed the first three
blocks and saw `e303c566` in the mempool. Every desktop peer reported the
same txid as the others, and in the P2P round the steps 2, 3, 5, 6 and 7
(`4ebcfa23`). After the round the panel showed "Fused ✓" with the txid, the
renderer's depth view held it (`syncRuntimeFusionDepth`), and no coin stayed
held. Auto, armed by the manual round, kept fusing, rode out "could not
safely revalidate wallet inputs" and a server clock skew as retries, and
stopped at once when CashFusion was switched off between rounds.

Found and fixed here (`20cb86fb`, `338fe1e4`, `7ee16be1`), each with a test
that fails without it:

- Fuse failed at once with "A chain operation is already running" whenever
  a background sync held the chain. The host now waits that out, a second at
  a time for up to 90 s; a stop ends the wait and counts as a stop.
- The panel's leftover-run check ran on Start, before Rust listed the run,
  and showed every round cancelled while Rust went on fusing. A start Rust
  has not confirmed is never dropped. `optn_fusion_running` now names the
  run's wallet, mode and Auto, and the view adopts a lost run of its own
  wallet on open, so it can be seen and stopped.
- P2P rounds of Rust peers stalled with "outputs never arrived (batches=0,
  ...)", six CLI peers on idle Tors included: one `onion_output` whose one
  circuit reached no relay was lost, because the round's resend timers are
  coalesced while a copy is still connecting. Every component now gets up to
  three connections on fresh circuits. Before: five rounds, none fused. After:
  both rounds above fused.
- After a fuse the panel greyed Start, "No spendable (non-token) coins", from
  the renderer's lagging coin list, while the runtime held 1,197,820 sats. The
  driver decides what can fuse; the panel no longer pre-judges it.

Found, open:

- The desktop's engine holds one wallet. Opening a wallet in another window
  switches it, and a run of the first wallet ends at its next round (the
  session check). The renderer-run fusion fused every window's wallet; sends
  already needed the engine's wallet. One wallet per window needs the runtime
  to hold several sessions.
- Several desktop instances on one Tor starve it. Two instances whose sync
  kept failing held a Tor daemon at 100% of a core; the SOCKS handshake then
  took 4-10 s, past the fusion proxy check's 5 s, and one-shot relay
  connections timed out, so the onion missed its deadline (35 s plus 36 s per
  peeler). With one healthy instance the same daemon idled and the round
  fused. A holder runs one app; the lab ran nine.
- The desktop's chain stack did not recover when its Tor restarted: every
  refresh then answered "no wallet route is available under the current
  policy" or "Proxy server unreachable" until the app restarted. Two wallets
  (#10, #11, then #12) answered "no wallet route" from a fresh start too.
- Electrum's own fusion clock check ("server clock differs by more than 5
  seconds") failed against the local server now and then; Auto retried.

Checks on `7ee16be1`: `test:core` 1854 tests, `test:ui` 50, `typecheck:core`,
`lint:core`, `deps:check`, `security:test`, `addons:validate`; optn-fusion-native
30 tests and the ten-peer relay round; the CLI 114 and strict clippy;
`src-tauri` 146 and strict clippy without default features; `xtask
architecture`; rustfmt; all six lock files with `--locked`.

### 2026-10-16: a live round mixing Rust and TypeScript peers fuses

Five `optn fusion --p2p` peers (the CLI at `bbe7be74`) and one desktop
window running the TypeScript P2P code (the build of `15660a33`, before the
desktop moved to Rust) fused
`3e3b2c3f3c59a29af1c918f2bbd031f64a52c6c9525edd99c8b5ae3daa1936be` on
chipnet (19 inputs, 28 outputs; the explorer saw it in the mempool). The
TypeScript peer was the second of five peelers: it took Rust blobs, peeled
them and forwarded them to the next Rust peeler, and every peer reported the
same txid.

Larger mixed rounds ran out of time, not into faults. Eight peers (six CLI,
two TypeScript) went through six of seven hops, Rust to TypeScript and back,
and stopped before the last: Rust hops took 20-37 s and TypeScript hops 58-62
s, against 36 s per peeler (`round_timeout_ms`: 35 s plus 36 s a peeler).
A peeler gets its first blob within a second or two; the last of 34 takes
30-40 s, as resends find a relay the next peeler hears.

Tried and reverted: forwarding a hop's blobs on fewer one-shot connections.
The whole batch on one connection never arrived (public relays rate-limit a
connection after a few events); four to a connection arrived but hops were no
faster (40-52 s). Circuit setup is not what bounds a hop.

The TypeScript side exists only in builds before `9212c1a7`; a round with
them is bounded by their timing, which this repository no longer ships. A
longer onion budget would be a protocol change both sides must share.

### 2026-10-24: transaction preview assessment (not an implementation gate)

Reviewed the retained React regular Send, custom builder, watch-only/multisig,
WalletConnect, WizardConnect, CashConnect and built-in app transaction surfaces,
including Cauldron swap, merchant payment, pool create and withdrawal. Findings,
reproduction steps, source locations, severity, proposed common preview and
per-surface gaps are in the existing
[UX improvement plan](UX_IMPROVEMENT_PLAN.md#transaction-preview-review--2026-10-24).

Revision: `/home/lightswarm/projects/OPTNWallet`, branch
`codex/ux-basics-and-workflow`, HEAD
`ac2da1ceec73c8cd457e44fdfe02035cb034a173` plus uncommitted changes. SHA-256
hashes of 31 inspected source/reference files and the disposable diagnostic
fixture are recorded in
`/run/user/1000/optn-tx-preview-review-20261024/receipt.json` on verified tmpfs.
These identify the reviewed working files, not just HEAD. Temporary evidence may
disappear at logout/reboot; this ledger retains the findings and check summary.

Component diagnostics reproduced eight current faults: WalletConnect Chipnet
address prefix, enabled Sign/negative fee with missing sources, blank input
identifiers for a valid source-output shape, Wizard NFT authority/commitment
omission, drag-only Send confirmation, missing app-modal keyboard confirmation
and initial focus, multisig total including change, and generic mint summary
discarding token details. Diagnostics plus existing ReviewCard/ConnectionStatus
checks passed **3 files / 13 tests**. Passing current-bug assertions is evidence
of reproduction, not repair. A separate focused run passed **8 files / 41 tests**
covering the simple-send planner, WalletConnect/Wizard signing, CashConnect
lifecycle, Cauldron preflight/quote safety, Airdrops execution and multisig review.
The existing Vite UI-config extensionless-import warning remains.

Additional source findings include indistinct signature versus broadcast
semantics, incomplete custom/burn/Airdrops/sweep final summaries, gross merchant
funding presented as net wallet debit, transactions rebuilt after review,
unreachable regular-Send hardware progress inside ReviewCard, and Cauldron's
extra quote-details step while omitting fees in normal-swap final confirmation.
FundMe/AuthGuard/Paryon need separate per-action review integration; the SDK's
capability consent does not establish a verified transaction preview.

No new screenshots: browser inventory was empty and attempted in-app browser
creation returned `Browser is not available: iab`. Approved Send/Cauldron image
references were inspected. jsdom does not prove rendered dimensions, native
touch, keyboard behavior in a package, or live connector/hardware outcomes.
Fresh mobile/wide/compact screenshots, native platform behavior, real peer
round-trips and final plan/approval binding remain open. No live wallet keys,
approval, spending, broadcast, publishing, commit or push were used. Existing
synthetic signing tests use disposable fixtures only.

Assessment changes only the existing UX plan and this ledger. Its temporary
diagnostic file was removed from the repository; a copy remains on tmpfs for
reproduction. No application fix or production/release readiness is claimed;
build/typecheck/platform gates must be rerun when implementation changes land.
Documentation Prettier checks, `git diff --check`, and all 31 source/reference
fingerprints plus the diagnostic fixture checksum pass reconciliation.

### 2026-10-24: transaction-preview implementation follow-up

Checkout `/home/lightswarm/projects/OPTNWallet`, branch
`codex/ux-basics-and-workflow`. The preceding UX baseline was committed as
`05456aa669f678a13b7497059552e9bc13ae2355` without a push. The preview
source revision reviewed here is `6f7237e4f`. No mainnet signing,
spending, broadcast, publication or peer approval was exercised; all transaction
fixtures are disposable and synthetic.

Implemented preview corrections and explicit partial statuses are recorded in
[the existing UX plan](UX_IMPROVEMENT_PLAN.md#transaction-preview-implementation-follow-up--2026-10-24).
WalletConnect validates source/output shape before approval, uses the selected
network, and reports signed-only, hardware-not-broadcast, broadcasted,
submitted and failed-broadcast outcomes separately. Wizard review exposes NFT
authority/commitment. Multisig, Mint, custom builder, Airdrops, Paper Wallet
Sweep and CashConnect received verified-summary or feedback corrections.
The canonical UI/UX skill now calls for source-verified wallet effects,
review-to-sign binding and distinct signature/broadcast outcomes across
ordinary, connector and built-in-app actions.
Cauldron ordinary swaps now go from input to final review, include fees and
require a new quote if rebuilt signed bytes or amounts change. Pool withdrawal
prepares before approval and pool builds require another review after a changed
plan. Paryon's redeem path is explicitly preview-only; live borrow/stake
errors remain visible with history guidance.

Focused synthetic checks passed: WalletConnect signing/preview validation,
component Chipnet/invalid-request review, multisig total, custom-builder token
accounting, Airdrops rebuild binding/units, Cauldron plan binding, Mint token
summary, shared modal keyboard/preview-only action, Paper Wallet Sweep planner
and Arabic copy regression. Full app suite: **34 files / 148 tests passed**.
Full UI suite: **29 files / 75 tests passed**. Full core suite initially found
two untranslated Arabic transaction-copy strings; the focused reproduction
failed, the strings were added, and the rerun passed **310 files / 2,002 tests**
with 7 files / 10 tests skipped. Core TypeScript, standard React build, core
lint, repository formatting and `git diff --check` passed after the connector
outcome edit. The desktop React build and full UI suite also passed at the final
code revision. These are local/package checks,
not release evidence.

The browser inventory is empty in this session and `adb devices` reports no
attached device; no new rendered or packaged-native screenshots of this
revision are claimed. The 18 older, redacted Android/Chrome screenshots were
moved from the repository's untracked evidence directory to
`/run/user/1000/optn-ui-screenshots-20261024/` (tmpfs), so they disappear on
shutdown and are not part of the commit. Prior relative screenshot links in
historical entries refer to their original location; those images cover an
earlier revision and cannot validate these preview edits. Connector peer,
hardware, native touch/focus, changed chain liquidity, and real broadcast
outcomes remain unverified. FundMe/AuthGuard and exact wallet-effect summaries
needed further implementation at that revision, as marked in the UX plan.

### 2026-10-24: transaction-preview implementation continuation

Checkout `/home/lightswarm/projects/OPTNWallet`, branch
`codex/ux-basics-and-workflow`, Linux `7.0.0-38-generic` x86_64, Node
`v24.14.1`, npm `11.11.0`. This continuation added five review-boundary
commits after `6f7237e4f`: AuthGuard final reviews (`6125cdce6`), ordinary Send
CashToken authority and final-output checks (`0796e9dbb`), Cauldron merchant net
wallet effects (`a00f98516`), verified WalletConnect/WizardConnect effects
(`6b214d8bc`), and persistent hardware-send progress (`1352c861b`). FundMe
source and verification were excluded at the user's direction. No push was
performed.

AuthGuard now reviews the exact built inputs, final outputs and fee before each
broadcast and rejects wallet/network drift. Ordinary Send displays the selected
final CashToken output's full category, recipient, fungible amount, NFT
capability and commitment, and blocks authorization when that output is absent.
Cauldron merchant previews derive net BCH and token effects from wallet-owned
inputs and final change outputs rather than presenting gross funding as a
debit. WalletConnect and WizardConnect match validated source inputs and final
outputs against the wallet's stored public locking bytecodes to show net BCH,
token-atom and NFT-count changes separately from whole-transaction totals.
CashConnect still lacks source outputs; its balance changes are labelled as
request-reported and not independently verified.
Simple Send now keeps the authorized plan visible while a hardware wallet signs
and while the signed transaction is submitted; device/broadcast progress uses
an accessible live status instead of disappearing with the mode transition.

Focused checks passed for AuthGuard review data (**6 tests**), ordinary Send
review UI (**3 tests**), Cauldron wallet-effect derivation (**2 tests**) and
surrounding Cauldron paths (**3 files / 33 tests**), connector preview/effect
logic (**2 files / 6 tests**), and WalletConnect/WizardConnect UI
(**2 files / 6 tests**). At final connector revision `6b214d8bc`, the full app
suite passed **35 files / 154 tests**, full UI passed **29 files / 77 tests**,
and non-UI core passed **312 files / 2,008 tests**, with 7 files / 10 tests
skipped. `npm run typecheck:core`, `npm run lint:core`, `npm run format:check`,
explicit changed-file Prettier, `npm run build`,
`VITE_APP_SURFACE=desktop npm run build:web`, and `git diff --check` passed.
After `1352c861b`, the simple-send visibility/planner group passed **3 files /
12 tests**, full UI remained **29 files / 77 tests**, and core typecheck, lint,
standard production build, desktop React build, changed-file Prettier and diff
checks passed. The full app and non-UI core suites were not repeated because
the follow-up changes only the Simple Send render condition and status semantics.

These results prove local source/component behavior and React bundle creation.
No live connector peer, hardware signer, packaged Android/iOS/Tauri target,
native touch/focus, mainnet signing, spending or broadcast was exercised. The
browser inventory remained unavailable and no current-revision rendered
screenshots were captured. CashConnect source-output verification, real peer
result semantics, packaged hardware-wallet progress, and rendered/native
transaction-review evidence remain open in the UX plan.

### 2026-10-24: connector delivery outcome continuation

Revision `daa7a55e9` on `codex/ux-basics-and-workflow` aligned post-approval
copy with the actual adapter boundaries. WizardConnect now reports that the
signed transaction was returned to the app and may be broadcast later.
CashConnect reports that prepared transactions were returned to the app, keeps
its source-output verification limitation visible, guards repeated approval or
rejection, and reports success/failure through the shared native/browser
notification presenter. FundMe remains excluded.

The focused CashConnect approval regression passed **2 UI files / 5 tests**;
the translation-resource suite passed **11 tests**; the full UI suite passed
**30 files / 78 tests**; and `npm run typecheck:core`, `npm run lint:core`,
changed-file Prettier, `git diff --check`, and `npm run build` passed. These are
local source/component and React-bundle checks. No live peer, hardware signer,
native package, mainnet action, signing, spending, broadcast, or push was
performed.

### 2026-10-24: Paryon action-boundary continuation

Revision `6c0e4a4f5` clarified the Paryon transaction review boundary. Borrow
and Stake confirmations are disabled unless the live verified workspace is
writable, their action is labelled “Confirm and broadcast,” and a failed
readiness check stays in the review with an error. Redeem remains explicitly
preview-only with “Finish preview” and cannot build, sign, or send.

The Paryon action-semantics regression passed **2 files / 5 tests** and the
full built-in-app suite passed **36 files / 156 tests**. Core typecheck, lint,
changed-file Prettier, `git diff --check`, standard production build, and
`VITE_APP_SURFACE=desktop npm run build:web` passed. These are local
source/component and React-bundle checks; no live Paryon contract action,
mainnet signing, spending, or broadcast was performed.

### 2026-10-24: Paryon review binding continuation

Revision `efe6f7595` binds the Paryon confirmation modal to the exact current
action preview. Borrow, Stake, and Redeem confirmation is disabled when the
amount, metrics, details, warnings, readiness, or blocked reason changes while
the modal is open; the user is told to close the review and prepare it again.
The helper regression now passes **2 files / 6 tests**, and the full built-in-app
suite passes **36 files / 157 tests**. Core typecheck, lint, changed-file
Prettier, `git diff --check`, standard production build, and
`VITE_APP_SURFACE=desktop npm run build:web` pass on this revision. These are
local source/component and React-bundle checks; rendered, packaged, live
contract, hardware, mainnet signing, spending, broadcast, and push evidence
remain unavailable. FundMe remains excluded from this follow-up.

The broader regression pass on this revision also passed `npm run test:ui`
(**30 files / 78 tests**), `npm run test:core` (**313 passed / 7 skipped files;
2,010 passed / 10 skipped tests**), and `npm run security:test` (**2 files / 6
tests**). The UI run still emits the repository's existing Vite
`configLoader: 'native'` warning; it does not fail the suite.

Repository gates also passed on this revision: `npm run deps:check`,
`npm run format:check`, and `npm run addons:validate` (**1 file / 1 test**).

### 2026-10-24: Quantumroot recovery review continuation

Revision `c5b274b85` moves Quantumroot regular recovery, aggregate BCH sweep,
Quantum Lock recovery, and token-authorized recovery behind an exact prepared
transaction review. The modal now shows the destination, input total, recovery
amount, network fee, protected successor output when present, input outpoints,
and transaction byte length; confirmation broadcasts only the retained raw
transaction and guards repeated activation. A new pure review helper verifies
that selected-input totals equal the reviewed fee, recovery amount, and any
protected successor output.

The focused Quantumroot and recovery-service regression passed **3 files / 31
tests**; the built-in-app suite passed **36 files / 157 tests**; core typecheck,
lint, changed-file Prettier, `git diff --check`, standard production build,
and `VITE_APP_SURFACE=desktop npm run build:web` passed. These are local
source/component and React-bundle checks. Rendered mobile/native, live-chain,
hardware, and packaged evidence remain unavailable. FundMe remains excluded.

### 2026-10-24: Paryon exact transaction review and dev-cache follow-up

Revision `bc0456d91` prepares Paryon Borrow and Stake transactions before the
final confirmation. The review now retains the exact raw transaction and shows
the computed network fee, wallet-input total, output total, and byte length;
confirmation broadcasts those retained bytes. Preparation failures remain in
the review with an explicit “No transaction was sent” message. Redeem remains
preview-only. The pure prepared-transaction accounting regression passed **1
file / 2 tests**, the focused Paryon suite passed **5 files / 22 tests**, and
the built-in-app suite passed **36 files / 157 tests**.

`npm run typecheck:core`, `npm run lint:core`, targeted ESLint, Prettier,
`git diff --check`, `npm run build`, and the desktop web build passed. The dev
script now starts Vite with `--force` after the attached stale optimizer-cache
module failures; a fresh forced server returned HTTP 200 for the previously
failed source modules. The browser-extension listener/session warnings and
TokenIndex BCMR 404s remain external or expected unavailable-metadata states;
the BCMR service keeps cached metadata and falls back without treating those
404s as wallet failures. Rendered, packaged, live contract, hardware, and
native confirmation evidence remain unavailable. FundMe was intentionally
excluded.

The read-only RiftenLabs parity check was repeated against the deployed
endpoints: both `https://indexer.riften.net/health` and
`https://indexer-chipnet.riften.net/health` returned `status=healthy`,
`indexed_height=chain_tip`, and `version=0.2.0`. The local reference checkout
is already at the matching upstream `master` revision (`25bf5a2`); it was not
modified. No wallet-side Cauldron endpoint or schema upgrade is required by
this check.

### 2026-10-25: explorer policy and settings correction

Revision `bc5eb2682` makes transaction explorer links obey the selected Rust
chain policy for both transaction and address URLs. A transaction detail popup
now shows the selected-network explorer action, or explains why access is
blocked and links to the dedicated Settings → Explorer panel. Explorer choice
has been removed from the confusing mobile Server panel and is available as a
separate settings destination; the existing preset list remains intact.

The focused standard regression passed **8 files / 38 tests**; the targeted
explorer/detail run passed **3 files / 14 tests**; and the latest desktop UI
settings run passed **2 files / 3 tests**. These cover policy refusal, settings
navigation, selected-network history details, retry, transaction-ID copy, and
the blocked-access Settings link. Core typecheck, lint, Prettier and diff checks
passed. Native browser-open behavior and a packaged settings render remain
unverified. FundMe was not touched.

The follow-up full suites also passed `npm run test:ui` (**30 files / 79
tests**) and `npm run test:apps` (**36 files / 157 tests**); the standard and
desktop web builds passed on the same checkout.

### 2026-10-25: connector, Cauldron and history preview tightening

Revision `1b7d7949d` on `codex/ux-basics-and-workflow` keeps FundMe out of scope
and tightens the remaining transaction-preview surfaces. WizardConnect now uses
one collapsed technical-details disclosure for inputs, outputs, scripts and
CashToken identity, matching WalletConnect's progressive disclosure while
leaving the verified wallet effect and whole-transaction totals visible. The
review still distinguishes sign-and-return from broadcast behavior.

Cauldron's separate quote-details overlay was removed from the normal path so a
fresh quote leads directly to one final review. The review retains pay/receive,
minimum receive, network fee, LP fee, route/risk warnings and the existing
rebuild/stale-liquidity checks. Technical route and market-depth details remain
available without another navigation step.

History cards now lazily hydrate visible transactions from the existing
Electrum verbose-details cache/in-flight requests and show a signed wallet BCH
effect only when owned inputs or outputs can be matched. Unknown ownership is
left blank. A pure helper regression covers outgoing change, incoming value and
unknown ownership.

Focused checks passed **3 files / 10 tests** for the new helper and connector /
history UI paths. `npm run typecheck:core`, `npm run lint:core`, Prettier and
`git diff --check` passed. No live connector, packaged native, hardware,
mainnet signing/spending/broadcast, or push evidence was produced. The browser
Vite config warning remains the repository's existing non-fatal warning.

### 2026-10-25: preview localization and full verification

Revision `ff7f87434` adds Arabic translations for the new transaction-preview,
explorer-settings and history-effect labels, preserving the `{bytes}`
interpolation used by Quantumroot recovery details. FundMe remained untouched.

The full post-change gates passed: `npm run test:core` (**317 passed / 7 skipped
files; 2,020 passed / 10 skipped tests**), `npm run test:ui` (**30 files / 79
tests**), `npm run test:apps` (**36 files / 157 tests**),
`npm run typecheck:core`, `npm run lint:core`, `npm run format:check`,
`npm run deps:check`, `npm run addons:validate` (**1 test**),
`npm run security:test` (**2 files / 6 tests**), standard `npm run build`,
`VITE_APP_SURFACE=desktop npm run build:web`, and `git diff --check`. The
existing Vite native-config-loader warning remains non-fatal. No live connector,
packaged native, hardware or mainnet signing/spending/broadcast evidence was
produced.

### 2026-10-25: executable preview inventory continuation

The in-scope app preview inventory was rechecked at the current branch head.
Airdrops now presents one final confirmation sheet with recipient count,
formatted total, fee, and an expandable exact input/output review instead of a
separate duplicate transaction popup. Paper-wallet sweep, AuthGuard, the
regular builder, WalletConnect/WizardConnect, and Cauldron were source-reviewed
against the same preview contract: prepare exact bytes, show wallet-relevant
effects and costs, keep technical identity available on demand, and require a
deliberate confirmation before an authorized broadcast boundary.

`npm run test:apps` passed **36 files / 157 tests** on this revision;
`npm run typecheck:core`, `npm run lint:core -- --no-cache`, changed-file
Prettier, and `git diff --check` also passed. Rendered mobile/desktop review,
packaged native behavior, hardware approval, and live peer evidence remain
open. No signing, spending, or broadcast was performed.

### 2026-10-25: iOS startup configuration reconciliation

`npm run capacitor:sync:ios` regenerated the ignored iOS Capacitor config from
the canonical `capacitor.config.ts`: the splash now uses `#0d2a1fff`, has no
fixed-duration auto-hide, and remains visible until the React startup path
mounts. The same sync added the installed `CapacitorApp` pod entry to the
tracked iOS Podfile. Sync completed successfully; CocoaPods and Xcode were not
available, so native compilation and device launch timing remain unverified.

The shared explorer action was also tightened: blocked policy explanations now
include a Settings → Explorer recovery link anywhere the reusable component is
used, while available links still use the selected network and preset. The
focused `ExplorerLink` UI regression passed **1 file / 2 tests**. Browser/mobile
popup failures now use the wallet status presenter; the focused external-link
regression passed **1 file / 2 tests**. Tauri continues through its existing
system-browser adapter.

Transaction details now show the same verified wallet-owned BCH effect as the
history card, with unknown ownership remaining explicit. The detail regression
passed **1 file / 4 tests**.

Visible history hydration now catches each verbose Electrum lookup separately;
one failed transaction no longer rejects the page-wide effect hydration or
surfaces an unhandled rejection.

WalletConnect and WizardConnect now use the shared connector request summary:
network, actual sign/broadcast behavior, and complete-request fee are visible
first; whole-transaction totals and output rows are progressively disclosed.
The verified wallet-owned effect remains prominent and exact preview validation
and approval boundaries are unchanged. The focused WalletConnect UI regression
was updated and passed **1 file / 2 tests**.

The shared connector-summary labels also have Arabic translations so the
resource fallback check remains clean. The full core suite passed **318 files /
2,022 tests** (7 files and 10 tests skipped).

### 2026-10-25: connector preview consistency verification

Revision `23903a961` on `codex/ux-basics-and-workflow` is the current source
fingerprint. `npm run test:ui` passed **31 files / 82 tests**; `npm run
test:apps` passed **36 files / 157 tests**; `npm run typecheck:core`,
`npm run lint:core -- --no-cache`, `npm run format:check`, `npm run deps:check`,
`npm run addons:validate`, `npm run security:test`, `npm run build`, and
`VITE_APP_SURFACE=desktop npm run build:web` passed. The UI Vite
`configLoader: 'native'` extension warning remains non-fatal.

The focused WalletConnect review passed **1 file / 2 tests** after the shared
summary was introduced. No connector peer, hardware approval, native toast,
browser external-link, or live-chain transaction was exercised; those remain
explicit evidence gaps. FundMe remains excluded by user direction.

The console-log BCMR icon issue is also covered in this revision: IPFS gateway
icons now flow through the configured gateway/data-URI path instead of being
handed directly to a browser image element that can be blocked by CORP/CORS.
`src/services/__tests__/BcmrService.test.ts` passed **1 file / 9 tests** for
the service regression. The log's extension transport warnings and historical
Vite module-load failures are external/stale-environment evidence, not wallet
runtime failures established by the current production build.

### 2026-10-25: BCMR icon regression verification

Revision `e89d66a2a` is the current source fingerprint. After routing gateway
form IPFS icons through the configured gateway/data-URI path,
`src/services/__tests__/BcmrService.test.ts` passed **1 file / 9 tests** and
the full core suite passed **318 files / 2,023 tests** (7 files and 10 tests
skipped). Typecheck, lint and diff checks remained green. The previously
recorded UI/apps suites and both production build configurations are unchanged
by this service-only fix; both `npm run build` and
`VITE_APP_SURFACE=desktop npm run build:web` were rerun successfully after the
fix.

### 2026-10-25: WalletConnect Cauldron/PUSD review

The WalletConnect approval sheet was reviewed against a Cauldron BCH-to-PUSD
request. The decision-critical area now leads with the app-described action
(`Cauldron swap … BCH → PUSD`) and the verified wallet-owned effect. BCH and
token changes are presented as explicit spend/receive cards; the full token
category remains available under a token-identity disclosure. Network, action,
and complete-request fee remain visible, while raw inputs, outputs, scripts,
and addresses are grouped under one collapsed technical-details disclosure.
The approval and cancellation actions remain in a safe-area-aware footer while
the request body scrolls.

Focused WalletConnect, WizardConnect, request-description, and localization
regressions passed (**3 files / 10 tests**, plus **2 resource tests / 14
tests**). The Cauldron fixture verifies `0.00999962 BCH → PUSD`, the `PUSD`
label, and the collapsed technical disclosure. Live WalletConnect peer,
native-device rendering, and BCMR decimal-display evidence remain open; the
app-supplied prompt is context only and does not replace wallet-verified
transaction effects. FundMe remains excluded.

### 2026-10-25: UX workflow integration

The existing `.claude/skills/ui-ux-product/SKILL.md` is now the explicit
workflow entry point for user-facing changes. It maps scope, journey-first
planning, shared-layer architecture, development, rendered verification,
state/error testing, dedicated UX review, and documentation sync without adding
a competing skill or tracker. Its twelve-item acceptance checklist covers
new-user clarity, primary action, progressive disclosure, recovery, truthful
wallet effects, security/privacy boundaries, touch and keyboard behavior,
visual consistency and proportional evidence. `AGENTS.md` points to the same
normative checklist, and the pull-request template requests the corresponding
evidence and explicit gaps.

The workflow was checked against a hypothetical Cauldron BCH-to-PUSD approval:
scope the user decision, map quote → review → cancel/retry → approval →
uncertain broadcast, preserve verified wallet effects above raw transaction
details, bind approval to exact reviewed bytes, exercise responsive dialog
states, and record live-peer or packaged-native gaps in this ledger. No code,
wallet authority, transaction behavior or third-party analytics were changed
by this documentation update.

Validation: skill discovery path, referenced repository documents and PR
template links were inspected; `git diff --check` and the repository formatting
check passed after the documentation edits. Runtime/native/connector evidence
remains governed by the existing surface-specific entries above.

### 2026-10-25: connector BCMR identity and approval hierarchy

WalletConnect approval now uses the shared wallet popup shell for focus
containment, Escape/cancel behavior, safe-area-aware action placement, and a
scrolling request body. The first view presents the requester context, selected
network, actual sign/return or sign/broadcast operation, complete-request fee,
and the wallet-owned BCH/token/NFT effect. Raw inputs, outputs, addresses,
scripts, and token categories remain available under one technical disclosure.

`ConnectorWalletEffectSummary` now consumes the existing shared BCMR resolver
(`useSharedTokenMetadata`) for connector token categories. A verified BCMR name
and symbol replace the category as the primary user-facing identity; BCMR
decimals format fungible amounts while atomic amounts remain visible. When BCMR
is unavailable, the UI says so and keeps any dApp label explicitly secondary;
the app prompt never determines wallet effect or token identity. WizardConnect
uses the same effect/technical summary and retains sign-and-return semantics.

Verification on the current working tree: focused WalletConnect/WizardConnect
UI checks passed (**2 files / 7 tests**), the full UI suite passed (**31 files /
83 tests**), the app suite passed (**36 files / 157 tests**), core typecheck and
core lint passed, and Prettier was applied to changed files. The UI Vite
`configLoader: 'native'` extension warning is non-fatal. Live connector peers,
remote BCMR failure/recovery, decimal-bearing token fixtures, hardware approval,
and packaged mobile/native rendering remain open evidence gaps. No signing,
spending, broadcast, or FundMe work was performed.

### 2026-10-26: Simple Send blank broadcast error recovery

The supplied v1.7.4 Android capture showed a red error panel containing only
`Error sending transaction:`. Source review traced this to blank provider or
engine exception messages reaching `useSimpleSend` and `toErrorMessage` without
a fallback. The shared error formatter now rejects blank `Error.message`
values, provider-like `{ message }` objects are normalized, and broadcast
classification/transaction results provide an actionable fallback instead of
an empty string. Desktop engine responses also reject blank refusal messages.

Regression coverage passed for `TransactionManager`, `TransactionService`,
shared error/classification helpers, and the Simple Send hook. The reviewed
transaction remains available for retry after a failed send; success/clear
behavior is unchanged. This is source/component evidence only: no live
provider, device, signing, mempool, or confirmation evidence was produced.

### 2026-10-28: Full-flow visual capture

Revision: current working tree on `codex/ux-basics-and-workflow`. Environment:
local Vite development server at `127.0.0.1:5173`, disposable generated wallet,
headless Chrome capture at mobile 411×843 and desktop 1280×900. Temporary
screenshots are stored under `screenshots/` for visual analysis and are not
part of the source deliverable. Rendered routes and panels include onboarding,
wallet navigation, transaction/send/custom-send/history/outbox, receive
progressive disclosure, settings panels, built-in apps and Cauldron, plus
WalletConnect/WizardConnect/CashConnect approval sheets. Connector sheets use
synthetic local fixtures; history card/detail uses a synthetic txid fixture.

Evidence status: rendered browser screenshots pass for the listed surfaces.
Native notification behavior, packaged Android/iOS rendering, live connector
peers, live Fulcrum/indexer data, hardware signing, broadcast, mempool and
confirmation remain unverified. Images contain no unmasked private key or seed.

### 2026-10-28: Send/Receive newcomer pass

Source revision: current uncommitted `codex/ux-basics-and-workflow` checkout.
Receive keeps the intentional ten-PubKey-tap private-key disclosure gate and
resets it on every route entry. The public receive card now explains the
purpose of the address and provides labelled Copy address and Share address
actions. Sharing uses the same safe-area-aware native/browser notification
path as copy; cancellation is silent, while unsupported or failed sharing is
actionable. The Send page keeps BCH default, token/NFT/Airdrops, coin control,
change address, and custom builder paths. Its review card now puts network and
wallet-effect context before technical inputs/outputs, and recipient copying
uses contextual address feedback.

Focused evidence: `src/utils/__tests__/copyWithFeedback.test.ts` covers share
success, unavailable share, and cancellation. Remaining gaps are packaged
native share-sheet rendering, live provider/indexer data, hardware approval,
signing, broadcast, mempool and confirmation. No funds were signed or spent.

Validation continuation: focused Send/Receive/feedback checks passed (**3 files /
15 tests**); core passed (**319 files / 2,032 tests**, 7 skipped files and 10
skipped tests); UI passed (**31 files / 84 tests**); apps passed (**36 files /
157 tests**); security passed (**2 files / 6 tests**); add-on validation passed
(**1 test**); dependency policy, typecheck, lint, formatting, `git diff
--check`, the web build, and the desktop-surface build all passed. The Vite
`configLoader: 'native'` message remains a non-fatal warning.

### 2026-10-29: Frontend redesign safety and comprehension pass

Revision: existing checkout branch `codex/frontend-redesign`, with unrelated
user-owned `screenshots/` preserved. The retained React surfaces now share an
explicit Mainnet/Chipnet context banner across core wallet destinations;
Home/Assets/Send use BCH/USD segmented controls; Send keeps Max under Advanced
options and reports spendable balance in the selected unit; incoming funds can
remain visible as a dismissible portfolio flag; and transaction IDs and
participant addresses, including the successful Send state, are masked with
long-press/context-menu disclosure for the full value.

Network settings now requires an explicit target-network confirmation sheet,
repeats the real-funds/test-funds warning, explains record clearing and
resynchronization, and exposes reload/switch failures as retryable user-facing
states. A failed switch reopens the confirmation sheet rather than retrying a
network mutation implicitly. Unknown Simple Send failures now use a plain
language fallback instead of displaying transaction-builder diagnostics.
Outbox status and release/clear-lock states now have plain-language labels and
touch/keyboard-accessible explanations, and transaction-detail lookup failures
show a friendly retry state while technical causes stay in the application log.
Recoverable Send failures retain the entered form and expose an explicit Edit
payment action that returns focus to the recipient field.
Onboarding Help is now a step-by-step walkthrough with explicit progress,
reversible Back/Next controls and a Done action that closes the popup, matching
the guided-pop-up interaction standard used for this redesign. Create/import
onboarding now repeats the explicit LIVE/TEST network banner before the network
toggle and derivation controls.

Source/component evidence added in this continuation includes the Network
settings UI suite (confirmation/cancel, failed-switch recovery and successful
reload), masking utility coverage, onboarding coverage, connector review
coverage, and the affected Send/History regressions. Packaged desktop/mobile,
native notification,
live-provider, signing, broadcast, mempool and confirmation evidence remain
separate open gaps. A disposable local headless render covered onboarding at
390×844 and 1440×1000; Firefox WebDriver exercised the Help walkthrough
through all four steps and closed it with Done, and verified the create-wallet
LIVE Mainnet banner. This continuation changed no transaction authority or
signing path.

The connector follow-up also moved wallet-effect loading/unavailable/BCMR
identity copy and CashConnect/WizardConnect approval labels into the shared
translation catalog, with Arabic overrides. Focused WalletConnect and
CashConnect review tests remained green after this copy-only UI change. The
same network and masked-disclosure treatment now covers the watch-only/multisig
send, custom transaction summary/error surfaces, and paper-wallet sweep. The
watch-only Back action now returns from confirmation/error/proposal states to
the correction point before leaving the route; no transaction authority
changed. Ordinary and multisig Send review now uses the same masked address
disclosure for recipient, stealth, input and output values. Custom transaction
source-selection, selected-UTXO and pending-outbound rows now use the same
masked disclosure pattern with keyboard selection preserved. The dedicated
desktop Home renderer now mirrors the same network context, BCH/USD,
incoming-funds attention and masked recent-activity behavior while retaining
desktop-only sync progress and connector popup behavior. The Apps directory,
marketplace host, Contracts, Quantumroot and CashFusion entry points now repeat
the active network context; Merchant Pay and Cauldron result/history cards use
masked transaction IDs with on-demand full disclosure.
The remaining direct wallet-adjacent routes now follow the same boundary:
Nostr Chat, the standalone CashTokens mint flow, and the legacy FundMe campaign
detail route repeat the active network context. Mint's broadcast result masks
its transaction ID while retaining copy and long-press disclosure.
Transaction History rows now expose status help without nesting an info control
inside the row action and use the shared localized waiting/confirmed vocabulary.
WalletConnect and WizardConnect place network context at the modal boundary, so
unsupported and broadcast-locked requests are labeled too. CashTokens mint
failures now lead with the shared plain-language error panel, with raw exception
text behind Technical details.
Cauldron's merchant auto-prepare effect now invokes the latest quote workflow
through a stable ref, preserving the guided review path without a per-render
effect dependency.
Home now exposes Assets and Apps as a secondary wallet-tools tier beneath the
primary Receive/Send actions, with return context preserved on web/mobile and
desktop renderers.
Home portfolio money cards also repeat the active network with a semantic
Mainnet/Chipnet border and tint on both mobile and desktop, in addition to the
centered context banner.
The primary Send heading now uses the shorter localized `Send` label so it
remains legible beside the wallet mark at mobile widths.

Validation for this revision: UI **33 files / 87 tests** passed; core **320
files / 2,037 tests**, 7 skipped files and 10 skipped tests, passed; focused
route/redesign checks passed (**5 files / 15 tests**); security
passed (**2 files / 6 tests**); add-on validation passed (**1 test**);
dependency policy, TypeScript, lint, formatting, web build and `git diff
--check` passed. The Vite native-config message remains a non-fatal warning.
The bounded local preview returned `200 OK` with `Content-Type: text/html` and
5,118 bytes. The connected browser surface was unavailable; local headless
Chrome/Firefox evidence is recorded separately above.

### 2026-10-29: Advanced address and transaction disclosure continuation

The remaining user-visible raw-value audit found three advanced gaps: multisig
receive token-aware/BCH address cards, the multisig cosigner unsigned
transaction hash, and Quantumroot receive/quantum-lock address cards. Each now
uses the shared masked-value interaction with click-to-copy and
long-press/context-menu full disclosure while preserving QR and explicit Copy
actions. Technical input fields and transient diagnostics remain exact where
editing or debugging requires them. No address reservation, PSBT validation,
signing, or transaction behavior changed.

Current focused verification: UI **34 files / 88 tests** passed; TypeScript,
core lint, Prettier, `git diff --check`, the web build, and the desktop-surface
build passed. An isolated Chrome/CDP fixture rendered the revised Home at
390×844 in Mainnet and Chipnet states and the revised Send screen at 390×844;
the shortened Send heading, network banner, and money-card color distinction
were visually confirmed. Advanced-screen rendered re-capture, packaged native
behavior, live providers, signing, broadcast, mempool, and confirmation remain
explicit evidence gaps.

### 2026-10-30: Address disclosure continuation

Contract View and Merchant Pay had remaining active address displays that were
shortened but did not provide the approved full-value disclosure path. They now
use the shared masked-value control with copy feedback and
long-press/context-menu disclosure. Contract input and signing values remain
exact where they are editable or technical. Merchant Pay tests passed **7/7**;
core typecheck, lint, formatting, and `git diff --check` passed. Packaged and
live-provider evidence remains separate and open.
Quantumroot recovery destinations/outpoints and Cauldron merchant-review
address displays received the same shared disclosure treatment. The focused
Cauldron and Merchant Pay app suites passed **43/43** tests combined.
Paryon broadcast success now keeps the status copy plain and renders the
returned transaction ID as a masked, copyable disclosure. Memo Cash Reader
activity rows apply the same boundary to author addresses and transaction IDs.
The complete app suite passed **36 files / 157 tests** after these changes.
The same boundary now covers the add-on Paper Wallet Sweep result, CashFusion
result banners, UTXO cards, watch-only address previews, and the address
selection popup. Exact transaction values remain available through the shared
copy and long-press/context-menu disclosure. A documented desktop build
attempt reached Rust compilation but stopped before producing a binary because
the host lacks `glib-2.0`/`gobject-2.0` development metadata; WebKitWebDriver
is also not installed, so packaged desktop evidence remains unavailable.
Quantumroot vault lists and Coin Control outpoint rows now use the same
interactive disclosure for their visible wallet identifiers. Core verification
after this continuation passed **320 files / 2,037 tests** and UI verification
passed **34 files / 88 tests**.
AuthGuard mint/broadcast status and error strings now split visible transaction
IDs into the same masked, copyable disclosure without changing its reviewed
transaction or broadcast authority.
Cauldron broadcast status sentences and result-modal copy now use the same
masked transaction-ID disclosure as their standalone result row.
Receive’s secondary address chooser now uses the same embedded masked address
control while retaining its tap-to-select action.
Token details now apply the same disclosure to the visible token ID and
authority-head transaction hash; technical contract inputs remain exact.
The persistent pending-outbound panel now explains each send state beside its
label, including the difference between submission, network visibility, and
confirmation, without changing release or clear behavior.
Paryon thread freshness now has an adjacent explanation, and preferred
contract outpoints use the same copy/long-press disclosure as other visible
wallet identifiers; write gating remains unchanged.
The persistent incoming-funds flag now renders structured amount, address, and
Transaction ID fields in both mobile and desktop Home, so the notification
does not lose its copy/full-value path when the toast is missed.
Quantumroot recovery broadcasts now keep a persistent result notice in the
vault popup with a masked, copyable Transaction ID; the native toast is reduced
to a plain awaiting-confirmation message.
Transient UTXO and server notification cards now use the same interactive
address and Transaction ID disclosures. Simple Send recipient previews,
CashToken review recipients, custom-builder output recipients, and contract
function address selections now preserve the full-value copy/long-press path.
The enlarged Receive QR preview now uses the same interactive disclosure for
address and BIP21 payload values instead of rendering a shortened-only label.
The Receive Quantumroot status popup now applies the same disclosure to its
receive and Quantum Lock addresses.
Core typecheck, the core suite (**324 files / 2,041 tests**), UI verification
(**34 files / 88 tests**), app verification (**36 files / 157 tests**), the web
build, lint, and Prettier passed after this continuation.

### 2026-10-29: pending-send interaction and rendered layout continuation

The blocking `PendingOutboundPanel` now uses the same user-facing state labels
as `/outbox`: broadcasting, submitted, sent to network and seen by network.
Tor-only Fusion records that still lack independent visibility are labelled as
awaiting verification and show the reason their inputs remain locked. Outbox,
Sync, Dismiss, release and clear controls in the sheet now have 44px minimum
targets. A focused static-render regression covers the lock explanation and
target sizing. This is source/component evidence; it does not prove a packaged
native dialog.

The full Outbox labels the masked value as `Transaction ID` and wraps the
masked transaction/address values on narrow screens so the first and last
characters remain visible. Send Advanced now scrolls its newly opened options
into the form viewport after expansion. A clean disposable generated-wallet
Chrome/CDP run rendered Home, Send, expanded Send Advanced, empty Outbox and a
synthetic submitted Outbox record at 390x844, with submitted Outbox also at
1280x900; the network-switch confirmation sheet was rendered at 390x844. The
synthetic outbox record was local-only and no signing, spending, broadcast,
mempool or confirmation occurred. Capture files were temporary and contained
masked identifiers only.

Current validation: core **324 files / 2,043 tests** with 7 skipped files and
10 skipped tests; UI **34 files / 89 tests**; apps **36 files / 157 tests**;
focused pending-panel tests **3/3**; core typecheck, web build, lint, Prettier
and `git diff --check` passed. Packaged desktop/mobile, live-provider,
hardware, signing and chain-state evidence remain open.

The Home visual pass also moved `PriceFeed` below the primary wallet task
surfaces in both `Home.tsx` and `DesktopHome.tsx`. A source regression asserts
the intended order, and a clean Chrome/CDP render at 390x844 confirmed
Portfolio is the first card after the network banner. This is browser/source
evidence for hierarchy only, not packaged desktop or native evidence.

### 2026-10-29: send recovery and review accessibility continuation

Simple Send error recovery now keeps the entered payment mounted and focuses
the correction point: recipient for invalid-address errors and the amount field
for insufficient-funds errors. The friendly English message now explicitly
identifies the wallet as the source of the insufficient balance. The Review
card Technical details disclosure has an explicit 44px target; existing focus
containment and masked full-value disclosure remain intact.

Focused Send/Review verification passed **3 files / 18 tests**. Full current
validation passed: core **324 files / 2,044 tests** with 7 skipped files and 10
skipped tests; UI **34 files / 89 tests**; apps **36 files / 157 tests**;
TypeScript/build, lint, dependency policy, security (**6/6**), add-on
validation (**1/1**), Prettier and `git diff --check` all passed. The Vite
native-config extension message remains non-fatal. Packaged native, hardware,
live-provider, signing, broadcast, mempool and confirmation evidence remains
open.

### 2026-10-29: Outbox state matrix continuation

The Outbox UI now has focused coverage for all four supported tracker states:
broadcasting, submitted, sent to network, and seen by network. Each state is
paired with its explanatory info control. Stale release and unknown-broadcast
recovery remain guarded release conditions rather than separate tracker enum
values; no release timing or transaction authority changed.

The full UI lane now passes **34 files / 92 tests**. Core remains **324 files /
2,044 tests** with 7 skipped files and 10 skipped tests; apps remains **36
files / 157 tests**. The Vite native-config message remains non-fatal.
Packaged native, hardware, live-provider, signing, broadcast, mempool and
confirmation evidence remains open.

### 2026-10-29: Home parity and Outbox diagnostic continuation

Desktop Home now mirrors mobile stale/unverified balance guidance with an
explanatory info control, Server settings recovery link and announced refresh
failure. Both Home renderers explain recent pending/confirmed activity states,
and Home QR/utility plus Send mode/Advanced/Airdrops controls meet the 44px
target rule.

Outbox classifies common provider diagnostics into friendly balance/network
copy and keeps the raw message behind Technical details. Send insufficient-
funds recovery can focus BCH, fungible-token, or NFT correction fields without
clearing the entered payment.

Final current validation passed **324 core files / 2,049 tests** with 7 skipped
files and 10 skipped tests; UI **34 files / 93 tests**; apps **36 files / 157
tests**. Build/typecheck, lint, dependency policy, security (**6/6**), add-on
validation (**1/1**), formatting and `git diff --check` passed. Native
packaged, hardware, live-provider, signing, broadcast, mempool and confirmation
evidence remains open.

The final Home status-help correction keeps recent-activity navigation and the
status explanation as sibling controls, avoiding nested buttons. Connector
technical-detail disclosures now use explicit 44px summary targets. Focused
Home, connector and Outbox checks remain green after the structural correction.

### 2026-10-29: custom builder error disclosure continuation

Custom transaction-builder failures now show actionable wallet-language by
default for insufficient funds, network problems, and generic build/broadcast
failures. Raw provider/builder diagnostics are retained behind a
keyboard-reachable Technical details disclosure. The builder's existing review
dialog remains the confirmation boundary: it shows masked IDs/addresses,
input/output totals, fee information, and token-accounting validation before
the drag-to-send action. Back/Try again remains local to the builder; no
transaction construction, signing, broadcast, release, or clear authority
changed.

Focused builder disclosure/popup/transaction-summary UI checks passed **3/3**.
Final validation passed **324 core files / 2,049 tests** with 7 skipped files
and 10 skipped tests; UI **35 files / 94 tests**; apps **36 files / 157 tests**.
Core typecheck, web build, core lint, dependency policy, security (**6/6**),
add-on validation (**1/1**), Prettier and `git diff --check` passed. The Vite
native-config extension message remains non-fatal. Packaged native, hardware,
live-provider, signing, broadcast, mempool, confirmation, and latest custom
builder browser-render evidence remain open.

### 2026-10-29: add-on identifier disclosure continuation

AuthGuard selectable UTXO rows and Paryon execution-plan targets now use the
shared masked transaction-ID interaction with copy feedback and
long-press/context-menu full-value disclosure. No add-on transaction
preparation, signing, broadcast, or protocol authority changed.

The app suite passed **37 files / 159 tests** after this change; the production
web build and targeted Prettier/diff checks also passed. Packaged add-on/native,
live-provider, hardware, signing, broadcast, mempool and confirmation
evidence remain open.

### 2026-10-30: shared destructive-action target continuation

The shared `wallet-btn-danger` CSS rule now enforces the same 44px minimum
touch target as primary and secondary wallet actions, covering clear, release,
retry, and other destructive/recovery controls without changing behavior. A
focused UI regression protects the rule.

Final current UI validation passed **36 files / 95 tests**; the production web
build, core lint, targeted formatting, and `git diff --check` passed. Core and
apps remain **324 files / 2,049 tests** (10 skipped) and **37 files / 159
tests**. Packaged desktop/mobile, screen-reader, hardware, live-provider,
signing, broadcast, mempool, confirmation, and full route fixture evidence
remain open.

### 2026-10-30: error disclosure, network context, and app-surface continuation

Watch-only send, paper-wallet sweep, custom-builder, and multisig failures now
show actionable wallet language by default with the exact diagnostic retained
behind a keyboard-reachable Technical details disclosure. The paper-wallet
classifier lives in a pure helper module so the component remains compatible
with the repository's Fast Refresh lint rule. Existing retry/back behavior and
transaction authority were preserved.

Multisig Home, Receive, Policy, and Cosigner Workspace now render known policy
network context. Paryon, Cauldron, Merchant Pay, Paper Wallet Sweep, and
Airdrops render the current network at their app boundary; nullable provider
context is omitted rather than guessed. AuthGuard and Paryon execution-plan
transaction IDs now use the shared masked copy/long-press disclosure. Outbox
diagnostic details and the shared destructive-action style now meet the 44px
touch-target rule.

Post-fix validation passed **324 core files / 2,050 tests** with 7 skipped
files and 10 skipped tests, **38 UI files / 97 tests**, and **38 app files /
160 tests**. Typecheck, production web build, core lint, dependency policy,
security (**6/6**), add-on validation (**1/1**), Prettier, and
`git diff --check` passed. The Vite native-config extension message remains
non-fatal. Packaged desktop/mobile, screen-reader, hardware, live-provider,
signing, broadcast, mempool, confirmation, and full route-fixture evidence
remain open.

### 2026-10-30: multisig setup and Home currency continuation

Multisig setup and QR-import failures now use the shared friendly-error panel
with Technical details disclosure. The setup network banner follows the policy
network being created rather than only the standard wallet's network, keeping a
Chipnet policy visibly distinct when the open mnemonic wallet is on Mainnet.

Home and Desktop Home now show the spendable/stealth balance breakdown in the
selected BCH or USD unit. If USD pricing is unavailable, USD mode states that
instead of silently showing BCH values. English and Arabic labels are covered,
and a source regression protects both renderers.

Final validation passed **326 core files / 2,052 tests** with 7 skipped files
and 10 skipped tests, **38 UI files / 97 tests**, and **38 app files / 160
tests**. Typecheck, production web build, core lint, dependency policy,
security (**6/6**), add-on validation (**1/1**), Prettier, and
`git diff --check` passed. The Vite native-config extension message remains
non-fatal. Packaged desktop/mobile, screen-reader, hardware, live-provider,
signing, broadcast, mempool, confirmation, and full route-fixture evidence
remain open.

### 2026-10-30: connector and app error-disclosure continuation

CashConnect pending-approval and connection-failure states now expose
wallet-owned explanatory info buttons. WalletConnect and WizardConnect session
status rows and the WizardConnect sign request status use the same contextual
help pattern. Connector status copy now has Arabic overrides.

Contract loading and add-on registry failures now show a user-facing recovery
message first, with provider/registry diagnostics behind a 44px Technical
details disclosure. Existing retry and navigation behavior remains unchanged.
The local headless preview rendered the current onboarding shell at 390x844 and
1280x900 after startup, with Create Wallet, Import Wallet, and Create Watch-Only
Wallet present in the DOM. This is browser evidence only; connected browser,
packaged native, screen-reader, live-provider, signing, broadcast, mempool,
confirmation, and full route-fixture evidence remain open.

Final validation passed **327 core files / 2,053 tests** with 7 skipped files
and 10 skipped tests, **38 UI files / 97 tests**, and **38 app files / 160
tests**. Typecheck, production web build, core lint, dependency policy,
security (**6/6**), add-on validation (**1/1**), Prettier, and
`git diff --check` passed. The Vite native-config extension message remains
non-fatal.

### 2026-10-30: fixture-harness boundary audit

The deterministic desktop E2E specs cover launch and onboarding validation
without persisting wallet data. Create/lock/reopen is explicitly
mutation-gated and requires the native Tauri/WebDriver path with an isolated
profile. There is not yet a non-mutating authenticated fixture that mounts
Home, Send, Receive, History, or Outbox with disposable balances and
transaction-state variants. Browser onboarding captures are therefore layout
evidence only; authenticated route interactions remain an explicit evidence
gap. This audit used no wallet credentials, seed phrases, signing, broadcast,
or live-chain state.

### 2026-10-30: disposable authenticated fixture harness

Added a development-only `VITE_UI_FIXTURE=1` entry point gated by the
`ui-fixture` query parameter. It mounts the real LandingPage, Home, Send,
Receive, History, Outbox, Apps, and Settings screens against a fixture-owned,
non-persisted screen store seeded with synthetic Chipnet balances,
confirmed/pending history, an incoming notification and an unresolved outbox
record. The fixture screen store is non-persisted and
contains no mnemonic or private key. The Receive, Send and Outbox data
boundaries short-circuit to public fixture values; no signing, tracker
operation, or live provider is accessed.

The local entry point is `VITE_UI_FIXTURE=1 npm run dev -- --host
127.0.0.1` with `/?ui-fixture&screen=home#/fixture/home`; the screen value can
be changed to `onboarding`, `watch-only`, `send`, `receive`, `history`,
`outbox`, `apps`, `settings`, `walletconnect`, `wizardconnect`, `cashconnect`,
or `builder`;
`send-review` and `builder-review` open display-only review states;
`wizardconnect-invalid`, `cashconnect-empty`, `cashconnect-multi`, and
`builder-token-error` cover guarded/error variants.

Local headless Chrome rendered the core authenticated fixtures at 390x844 and
visually confirmed the persistent incoming flag, Chipnet context banner,
BCH/USD balance control, masked identifiers, pending/confirmed history and
verification-pending Outbox disclosure. This closes the prior authenticated
route-render boundary only. Native touch, screen-reader, packaged-platform,
live-provider, signing, broadcast, mempool and confirmation evidence remain
open.

### 2026-10-30: fixture interaction exercise

Chrome DevTools Protocol exercised the real fixture routes. Receive long-press
opened the full public address, clipboard success announced `Address copied`,
and Home → Receive → Back returned to fixture Home when entered through the
fixture navigation state. Send with 2 BCH against the 1 BCH fixture preserved
the entered fields and showed “Not enough funds in your wallet.” History kept
pending and confirmed records visible, and Outbox kept the verification-pending
record visible with masked identifiers.

This closes the core fixture interaction slice for the feedback review. Native
touch/screen-reader, packaged-platform, live-provider, signing, broadcast,
mempool, confirmation and broader route-state matrices remain separate
evidence requirements.

### 2026-10-30: wide desktop fixture render

The five fixture routes were also rendered at 1280×900. The centered wallet
column stayed readable, and the shared PageHeader now wraps `Transaction
History` instead of truncating it. Network context, persistent incoming
disclosure, masked identifiers and Outbox verification state remained visible.
This is browser layout evidence only; packaged desktop and native touch
evidence remain open.

### 2026-10-30: fixture state-matrix exercise

The fixture now supports Home stale/unavailable, History empty/error, and
Outbox stale, unknown-network, empty and seen variants through the real route
components. Headless Chrome confirmed the stale Home explanation and Server
settings link, History empty and retryable error states, Outbox `Release if
stale` and network-error/Technical-details states, and the empty Outbox state.
The populated History fixture leads with pending/confirmed status before
masked identifiers and shows synthetic wallet-owned BCH effects.
The mobile Outbox render confirmed that the in-flow Back action no longer
covers the first transaction card. This is browser fixture evidence only.

The Apps fixture route also confirmed the grouped Wallet, Token, Utils and
Advanced sections, localized “best for” subtitles, and the wrapped mobile
filter row. These are browser fixture renders, not packaged native evidence.

### 2026-10-30: final web validation boundary

`npm run test:core` passed 328 files / 2,060 tests with 7 skipped files and 10
skipped tests; `npm run test:ui` passed 38 files / 98 tests; `npm run test:apps`
passed 38 files / 161 tests. Typecheck, web build, core lint, formatting,
dependency policy, security (6/6), add-on validation (1/1), and
`git diff --check` also passed. The Tauri debug no-bundle build reached Rust
compilation but failed because this host lacks `glib-2.0` and `gobject-2.0`
pkg-config metadata, and `WebKitWebDriver` is not installed. This records a
host/tooling gap, not a frontend regression or packaged-native success claim.

### 2026-10-30: Home recent-activity hierarchy continuation

Home and Desktop Home recent-activity cards now lead with a Pending or
Confirmed status chip, followed by block or pending-confirmation context and a
masked `Transaction ID`. Navigation and contextual help remain sibling
controls, avoiding nested interactive elements. A disposable 390x844 Chrome
fixture render confirmed the pending and confirmed cards remain readable below
the network banner.

This verifies the source and browser hierarchy only. Native touch,
screen-reader, packaged-platform, live-provider, signing, broadcast, mempool,
and confirmation evidence remain open. The current UI lane remains **38 files
/ 98 tests**, and the production build passes.

### 2026-10-30: Settings hierarchy fixture continuation

The disposable authenticated fixture now mounts the real Settings root. A
390x844 browser render confirms the active Chipnet banner, Quick access, and
the grouped Wallet & security, Connections & features, and About & support
destinations. Entering Wallet & security shows Wallet info, Derivation Path,
Recovery Phrase, and an in-flow Back action. This is non-persisted browser
evidence only; native touch, screen-reader, packaged-platform, and
live-provider behavior remain open.

### 2026-10-30: onboarding fixture continuation

The disposable fixture now mounts the real LandingPage and Watch-Only page as
well as the authenticated routes. A 390x844 Chrome render keeps Create Wallet,
Import Wallet, and Create Watch-Only Wallet visible beneath the branded hero.
Chrome exercised Help through all four walkthrough steps and closed it with
Done. The Watch-Only route is a public-only form fixture and does not create a
wallet or persist xPub data. Native touch, screen-reader, packaged-platform,
and create/import persistence flows remain open.

### 2026-10-30: Send review fixture continuation

The fixture now supports `screen=send-review`, mounting the production Simple
Send and ReviewCard with a deterministic display-only BCH review. A 390x844
Chrome exercise confirmed the Review Transaction dialog leads with Chipnet
context and wallet effect, shows amount and fee, masks the recipient, expands
Technical details, and retains the slide-to-confirm affordance. Long-press
revealed the full public recipient; closing the review returned to the form
with the recipient and `0.1` BCH amount retained.

The fixture branch blocks signing and broadcast and reaches no provider or
wallet authority. Native touch, screen-reader, packaged-platform, hardware,
live-provider, signing, broadcast, mempool, and confirmation evidence remain
open.

### 2026-10-30: WalletConnect review fixture continuation

The fixture mounts the production WalletConnect sign-request modal with a
public-only request. A 390x844 Chrome render confirmed the app-provided
description, Chipnet banner, wallet-owned fee effect, sign/return action, and
collapsed technical totals. Expanding the technical section showed masked
transaction IDs and addresses; long-press revealed the full transaction ID.
No peer, signing key, or broadcast authority is available in this fixture.

### 2026-10-30: WizardConnect and CashConnect review fixtures

The disposable fixture now mounts the production WizardConnect sign-request
modal and CashConnect execute-action modal. At 390x844, WizardConnect showed
the dApp status, Chipnet network context, sign-and-return operation,
whole-request fee, wallet effect, and technical-details disclosure. CashConnect
showed the dApp description, request action, prepared transaction count, and
request-reported BCH/PUSD balance changes, including the explicit warning that
source outputs are unavailable for independent ownership verification.

Both fixtures use public-only synthetic data and do not provide signing keys,
live peers, or broadcast authority. Their approval and rejection handlers
explicitly no-op while the fixture flag is active. The browser render is
layout and interaction evidence only; native touch, screen-reader,
packaged-platform, hardware, live-peer, signing, broadcast, mempool, and
confirmation evidence remain open.

The browser exercise clicked the visible approval controls on the WalletConnect,
WizardConnect, and CashConnect fixture routes. Each modal remained open with
the fixture banner, confirming that the fixture guard prevented live thunks,
signing keys, peers, and broadcasts from being reached. Current validation is
328 core files / 2,060 tests with 7 skipped files and 10 skipped tests, plus 38
UI files / 99 tests; build, typecheck, core lint, Prettier, and
`git diff --check` pass.

The fixture data also supports `wizardconnect-invalid`, `cashconnect-empty`,
and `cashconnect-multi`. Chrome confirmed that the invalid WizardConnect state
disables approval while retaining Cancel, the empty CashConnect state explains
that no balance change was reported, and the multi-transaction state surfaces
the multiple-transaction warning.

### 2026-10-30: custom builder review fixture

The fixture now wraps the production `TransactionActions` component at
`screen=builder-review`. Chrome opened the real Send TX → Confirm Transaction
path at 390x844 and showed masked input/output identifiers, input/output
totals, fee, fee rate, transaction size, warning copy, and drag confirmation.
The `builder-token-error` variant shows the unaccounted-token warning and
disables the accessible Confirm and send transaction control.

The fixture callbacks are display-only and do not build, sign, or broadcast.
Native touch, screen-reader, packaged-platform, live UTXO, signing, broadcast,
mempool, and confirmation evidence remain open.

### 2026-10-30: watch-only onboarding contextual help

Watch-Only onboarding and the desktop Watch-Only preview now expose
keyboard/touch-accessible help for the network, account xPub, and optional
master-fingerprint fields. The xPub copy explains that it is public derivation data and cannot spend funds by itself;
the fingerprint copy identifies it as optional public metadata. English,
Spanish, Chinese, and Arabic catalog entries are present. The focused
`WatchOnlyWalletPage` regression opens the xPub note, and the shared tooltip
regression covers the collapsed/expanded accessible state.

This is source/component evidence only. It does not prove persisted
watch-only creation, native touch, screen-reader output, packaged-platform
behavior, signing, broadcast, mempool, or confirmation.

### 2026-10-30: inline recovery-safety guidance

Create Wallet now renders the recovery-safety instruction inline beside the
generated phrase instead of relying only on the optional info control. The
copy explains that the phrase controls spending, must be written down and
kept safe, and must not be shared or stored digitally. The focused
`CreateWalletPage` regression verifies the visible note after phrase
generation. No backup gate or wallet-creation behavior changed; packaged and
screen-reader onboarding evidence remain open.

### 2026-10-30: contextual-help dismissal

Shared info controls now support Escape dismissal while keeping focus on the
trigger, and associate the open note with that trigger through
`aria-describedby`. Focused UI regressions cover both the general `InfoButton`
and the onboarding tooltip variant. This is source/component evidence;
packaged keyboard, touch, and screen-reader behavior remain separate.

Current validation after this pass is 330 core files / 2,062 tests with 7
skipped files and 10 skipped tests, plus 39 UI files / 100 tests. Typecheck,
build, core lint, focused desktop onboarding coverage, Prettier, and
`git diff --check` pass. The Vite native-config extension warning remains
non-fatal.

### 2026-10-30: Outbox release confirmation

Eligible Outbox clear/release actions now require the existing wallet
confirmation sheet before removing the local pending record. Tracker timing
and eligibility remain authoritative; Cancel leaves the record and its input
lock untouched. The compact pending-send panel in the shared layout uses the
same confirmation path, so Home/Send recovery cannot bypass it. The focused
Outbox UI regression verifies the confirmation dialog, duplicate-click guard,
and confirmed release path. This is source/component evidence only.

### 2026-10-30: pending-lock release parity

The inline pending-outgoing card on Simple Send and the multisig workspace
panel now use the same wallet confirmation boundary as Outbox and the shared
compact panel. Eligible records remain governed by the existing tracker; a
cancelled confirmation leaves the record and its input lock untouched, and
duplicate clicks are ignored while confirmation/release is in flight. The
shared compact panel now waits for the release promise before reopening the
action guard. This is source/component evidence only; no signing, broadcast,
mempool, confirmation, packaged-platform, native touch, or screen-reader
claim is made.

Final validation after this continuation is **330 core files / 2,062 tests**
with 7 skipped files and 10 skipped tests, **39 UI files / 100 tests**, and
**38 app files / 161 tests**. Typecheck, production build, core lint,
dependency policy, security (**6/6**), add-on validation (**1/1**), Prettier,
and `git diff --check` passed. The non-fatal Vite native-config warning
remains; the earlier native no-bundle build is still blocked by missing
`glib-2.0`/`gobject-2.0` pkg-config metadata and `WebKitWebDriver`.

### 2026-10-30: Send recovery fixture

The disposable UI fixture now supports `screen=send-error`. It preloads a
public Chipnet recipient and an oversized BCH amount on the real Simple Send
route. Review enters the existing user-facing insufficient-funds state, while
the form remains mounted for the Edit payment focus/recovery action. The
fixture branch is display-only and does not build, sign, broadcast, or contact
a provider. The source regression verifies the fixture guard and friendly
error string; this is not native touch, screen-reader, packaged-platform,
hardware, live-provider, signing, broadcast, mempool, or confirmation
evidence.

### 2026-10-30: connector uncertainty disclosure

Connector wallet-effect loading and unavailable states now include the shared
contextual help control. The copy explains that wallet-owned inputs/change are
still being verified or could not be verified from the request, preserving the
whole-transaction review warning before signing. A focused source regression
covers both state-specific controls. This is source/component evidence only.

Current core validation is **331 files / 2,064 tests** with 7 skipped files and
10 skipped tests; typecheck, core lint, and the focused connector test pass.

### 2026-10-30: source validation refresh

After the pending-popup disclosure and Send recovery-fixture additions,
`npm run test:core` passes **331 files / 2,064 tests** with 7 skipped files and
10 skipped tests. The UI suite remains **39 files / 100 tests** and the app
suite remains **38 files / 161 tests**. Typecheck, production build, core lint,
dependency policy, security, add-on validation, Prettier, and
`git diff --check` pass. Headless Chrome rendered the `send-error` fixture
route with Chipnet context and the prefilled public recipient/amount; no
connected browser, packaged/native, signing, broadcast, mempool, or
confirmation claim is made.

### 2026-10-30: FundMe broadcast disclosure

FundMe campaign action results now keep the human broadcast status separate
from the transaction identifier and render that identifier with the shared
masked/copyable disclosure. A focused app regression covers the `actionTxid`
handoff and masked modal rendering. The FundMe action/broadcast authority is
unchanged; this is source/app evidence only.

Current app validation is **39 files / 162 tests**.

### 2026-10-30: paper-wallet UTXO disclosure

The app-hosted paper-wallet sweep UTXO list now renders source transaction IDs
with the shared masked/copyable disclosure rather than exposing the raw hash in
the list. A focused app regression covers the value, label, and copy contract;
transaction authority is unchanged.

Current app validation is **40 files / 163 tests**.

### 2026-10-30: custom builder identifier disclosure

CashToken and NFT genesis-input selectors now mask transaction IDs in their
visible labels while preserving the full hash as the raw option value used by
the builder. A focused source regression covers both views; transaction
selection and signing authority are unchanged.

Current core validation is **332 files / 2,065 tests** with 7 skipped files and
10 skipped tests.

The production web build, core lint, Prettier, and `git diff --check` also pass
after this builder disclosure change. Packaged/native, hardware,
screen-reader, touch, and live-chain evidence remain separate.

### 2026-10-30: mint-result identifier disclosure

The CashToken mint result now uses the localized `Transaction ID` label,
shared masked/long-press disclosure, and localized copy-success feedback. A
focused app regression covers the label, value, and copy contract; minting
authority and broadcast behavior are unchanged.

Current app validation is **41 files / 164 tests**.

### 2026-10-30: legacy FundMe toast identifier disclosure

The compatibility FundMe campaign screen now masks transaction IDs in
Capacitor toast messages rather than exposing raw hashes. The underlying value
and broadcast behavior are unchanged; this is a presentation/privacy fix.

Current app validation is **41 files / 165 tests**. Production build,
formatting, and `git diff --check` pass. Packaged/native, screen-reader,
touch, hardware, and live-chain evidence remain open.

### 2026-10-30: Cauldron broadcast-message disclosure

Cauldron swap, merchant-payment, pool-deposit, and pool-withdraw status copy
now masks transaction IDs before interpolation. Raw IDs remain available to
the dedicated masked result card and explorer action; broadcast and
confirmation behavior are unchanged.

App validation remains **41 files / 165 tests** and the production build passes.

### 2026-10-30: AuthGuard broadcast-status disclosure

AuthGuard genesis, AuthKey, and token-mint progress/error messages now mask
transaction IDs while preserving raw IDs for UTXO matching and state handling.
This is a presentation-only privacy fix. The identifier-disclosure regression,
production build, formatting, and diff checks pass.

### 2026-10-30: contextual-help long-press behavior

The shared `InfoButton` opens after a 500 ms touch hold as well as a tap, with
pointer cancellation and synthesized-click suppression. A focused UI
regression covers the touch behavior and the existing test covers Escape
dismissal.

### 2026-10-30: full regression consolidation

Complete current suites pass: UI **39 files / 101 tests**, apps **41 files /
165 tests**, and core **332 files / 2,065 tests**, with 7 skipped files and 10
skipped tests. Core lint, formatting, and `git diff --check` pass.

### 2026-10-30: header network badge and Settings theme control

The shared `PageHeader` now carries a compact localized Mainnet/Chipnet badge
beside the OPTN logo. Legacy full-width banners are hidden when the shared
header is present to avoid duplication. Settings moves the smaller light/dark
toggle to the right side of the Quick access header. Focused UI tests,
typecheck, production build, and diff checks pass.

### 2026-10-30: Android unit-test evidence

`JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 npm run android:test` passes with
all configured app/plugin unit-test tasks. No Android emulator or device is
connected, so instrumented touch and packaged visual evidence remain open. A
Java 25 attempt failed during Gradle task creation because the project targets
Java 21; this is an environment mismatch rather than a product test failure.

### 2026-10-30: repository gate refresh

Dependency policy, security (**2 files / 6 tests**), and built-in add-on
manifest validation (**1 file / 1 test**) pass on the redesign branch. These
are repository gates only; packaged-device and live-provider evidence remain
separate.

### 2026-10-30: Android debug package evidence

`JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 npm run android:apk:dev` succeeds
and produces both F-Droid and Play debug APKs under
`android/app/build/outputs/apk/`. This proves packaging of the current web
bundle, not device rendering or instrumented interaction; `adb devices` has no
connected target.

### 2026-10-31: connected Android render evidence

The rebuilt Play debug APK was installed on the authorized Samsung SM-A205W.
Device screenshots confirmed the compact Mainnet badge beside the OPTN logo on
Home and Settings, removal of the duplicate full-width banner, and the smaller
theme toggle on the right side of Quick access. `uiautomator` exposed the
network label and `Toggle theme` control. No live-chain transaction was
performed.

### 2026-10-31: live connector review harness evidence

The development-only connector lab now opens real Chipnet WalletConnect,
WizardConnect, and CashConnect requester sessions and exposes a normalized
review summary through its local status endpoint. Its preflight derives the
wallet receive address from `OPTN_E2E_MNEMONIC`, decodes live parent
transactions, identifies BCH-only versus CashToken UTXOs, and checks disjoint
funding candidates. A WalletConnect smoke run produced a real request using a
live Chipnet outpoint, returning `0.14631733 BCH` to the derived receive
address with `broadcast: false`. No connector peer approval, signing, or
broadcast was performed; Android/desktop review capture remains pending.

The same lab reached the WizardConnect public relay, emitted a `wiz://` pairing
URI, and waited for wallet key exchange without sending a request before
pairing. This confirms the relay lifecycle and preserves the approval boundary;
the wallet-side WizardConnect review remains unexercised until a peer is
available.

The authorized Samsung SM-A205W later became available over ADB. After switching
the installed debug wallet to Chipnet, the live WalletConnect URI produced by
the connector lab opened the production session proposal and was approved on
device. The saved session reached `Waiting for session acknowledgement`, but
the requester process ended before the transaction-review modal appeared. This
proves the live Chipnet session-proposal surface, not transaction approval or
broadcast; the stale test session must be disconnected before another run.

### 2026-10-31: live WalletConnect transaction-review capture

Using the Android WalletConnect text field directly (without the camera), a
fresh live Chipnet URI reached the production transaction-review modal. The
rendered review showed the requester identity and URL, app-provided description,
wallet effect (`You spend`), matched wallet input/output count, exact
`0.00000250 BCH` fee, technical transaction disclosure, and separate Reject and
Sign-and-return controls. The request remained `broadcast: false`; no signing or
broadcast was performed.

The same text-field method was used for a live Chipnet WizardConnect URI on the
authorized Android device. The production approval modal displayed the full
`wiz://` connection URI and explicit Approve/Cancel controls; approval moved the
wallet to `Connecting…` with `Relay available — dApp connection not verified`.
The requester did not receive key exchange before the observation window ended,
so no WizardConnect sign request, signing, or broadcast occurred.

CashConnect was then exercised on the same Chipnet Android wallet by pasting the
`bch-cc-v1:` invite into its text field. The production proposal and action
review rendered successfully. The review showed `Action: sweep`, the prepared
transaction count, request-reported balance change (`-0.00501185 BCH`), and the
explicit warning that CashConnect did not provide source outputs for independent
ownership/change verification. The action was rejected; no transaction was
returned or submitted.

# PR #63 requirement ledger — #71 and #75

Built from current source, not from docs. Where a document and the code
disagree, the code wins and the document is the thing that is wrong.

Read the status column strictly:

| Status | Means |
| --- | --- |
| **PROVEN** | Implemented, and exercised against something real |
| **INTEGRATION** | Implemented and tested, but not yet reached by the running application |
| **DEVICE EVIDENCE** | Implemented and tested; needs a packaged artifact or hardware to finish |
| **PARTIAL** | Some of it exists; the gap is named |
| **MISSING** | Not implemented |
| **BLOCKED** | Needs something this environment does not have |

"Implemented" never means a type exists. Every row names an entry point a
reader can open and, where there is one, the test that holds it up.

---

## #75 — chain, sources, verification

### Definition of done

| # | Requirement | Status | Entry point / evidence | Gap |
| --- | --- | --- | --- | --- |
| 1 | Auto is the default and operation-aware | **PARTIAL** | `optn-runtime/src/bootstrap.rs::shipped_bootstrap_catalog`, wired in `src-tauri/src/chain_runtime.rs::catalog_and_policy_from_app_state`; `a_fresh_install_starts_from_the_shipped_catalog` | The catalog is no longer empty on a fresh install. Operation-aware selection exists in `build_selection_plan`; the shipped set is one endpoint per network, not the upstream feeds §21.3 lists |
| 2 | Users can pin policies/providers | **INTEGRATION** | `optn-runtime/src/network_config.rs`, `UserNetworkOverlay` | Durable model exists; the UI exposes one Electrum + one peer + one explorer rather than the full model (§21.7) |
| 3 | Privacy / own-infrastructure fail closed | **INTEGRATION** | `ConnectionPolicy`, `optn-chain-native::build_native_chain_stack`; `remote_full_node_adapters_remain_fail_closed_even_with_tor` | Enforced at stack build. Not yet exercised end to end against a live policy change |
| 4 | Tor modelled as transport policy, not a provider | **PROVEN** | `Bip37Transport` / `NeutrinoTransport` / `TorStatus`; `verified_tor_route_is_used_for_remote_electrum`, `plain_tcp_listener_is_not_a_tor_socks_proxy` | — |
| 5 | Tor-required routes ineligible, no direct/DNS fallback | **INTEGRATION** | `needs_default_tor_proxy`, `endpoint_can_use_native_tor` | Unit-level. No test drives a Tor-required policy against a live route change |
| 6 | Electrum and BIP37 preserved behind provider interfaces | **PROVEN** | `optn-chain-electrum`, `optn-chain-bip37`; live BCHD run in `docs/chain-interop-evidence.md` | — |
| 7 | Neutrino capability-gated, does not block Auto startup | **PROVEN** | `optn-chain-neutrino::connect` records `CompactFilters` only after the genesis-filter probe commits; `a_regtest_node_does_not_answer_for_mainnet` | — |
| 8 | BCHN RPC and ZMQ modelled separately from SPV | **PROVEN** | `crates/optn-chain-bchn`, `crates/optn-chain-zmq` | — |
| 9 | ZMQ is event/wake-up, never proof | **INTEGRATION** | `optn-chain-zmq`, `optn-runtime/src/event_recovery.rs` | Not driven against a live BCHN ZMQ socket here |
| 10 | Observations reconcile into one authoritative Rust state | **PROVEN** | `optn-runtime/src/reconciliation.rs`, `sync_worker.rs` | — |
| 11 | No 2-of-3 provider voting | **PROVEN** | `reconciliation.rs` ranks evidence; no vote count exists | — |
| 12 | SHV/MMR passes reference vectors | **PROVEN** | `optn-core/src/header_mmr.rs::reference_vectors` against bitcoincashautist's published vectors, byte-identical to BCHN's | — |
| 13 | Pruning preserves historical verification and reorg recovery | **INTEGRATION** | `header_store.rs::prune_below`/`rewind_to`, `header_recovery.rs` | Unit-level; not driven against a live reorg |
| 14 | CashFusion uses the shared chain observation layer | **PARTIAL** | `src-tauri/src/fusion/` (9,014 lines, 24 Tauri commands) and `optn-core/src/fusion/` (956 lines); 138 Rust tests. Server protocol in `server_plan.rs`, P2P in `p2p_component.rs`/`p2p_sign.rs`, covert transport in `covert.rs`, blame in `blame.rs` | The protocol is Rust, not TypeScript — an earlier revision of this row said otherwise and was wrong. What remains is that its chain observation still goes through `src/platform/desktop/Fusion*.ts` and `electrum_input.rs` rather than the shared provider/capability layer |
| 15 | Explorer routing independent of consensus | **INTEGRATION** | `optn-runtime/src/explorer.rs::route_url` | Routing exists; own-infrastructure-only behaviour is not yet asserted end to end |
| 16 | No renderer/shell owns networking or chain truth | **PROVEN** | `cargo run -p xtask -- architecture` → PASS | — |

### Architecture and verification

| Requirement | Status | Entry point / evidence | Gap |
| --- | --- | --- | --- |
| One accepted block-header authority | **PROVEN** | `header_store::SharedHeaders` + `header_view::VerifiedHeaderView`; BIP37 and Neutrino both read `BlockHeaderSource`; the host owns it across stack rebuilds (`chain_runtime::AcceptedChain`) | — |
| Worker publishes accepted headers | **PROVEN** | `sync_worker::publish_headers`; `a_header_pass_advances_the_view_and_the_store_together`, `a_rejected_header_pass_publishes_nothing` | — |
| Neutrino off private block-header state | **PROVEN** | `optn-chain-neutrino` holds `Arc<dyn BlockHeaderSource>`; filter hashes/headers remain its own | — |
| Duplicate network maps audited | **PROVEN** | Three copies now cross-check: `bip37_and_neutrino_agree_about_every_network`, `this_copy_agrees_with_the_accepted_header_store` | — |
| BIP37 merkle proofs bound to the accepted chain | **PROVEN** | `optn-chain-bip37/src/lib.rs` merkle-binding tests; a forged block is refused | — |
| Authenticated historical replay | **PROVEN** | `optn-runtime/src/header_recovery.rs`; 11 tests incl. forged resume material and same-length fork | Not yet called by the running application |
| SHV P2P root/peak proofs | **PROVEN** | `optn-chain-bip37/src/shv.rs`; live against BCHN `e6d380373` with `-mmrindex=1`, proof accepted only against OPTN's own root | — |
| BCHD-correct compact filters | **PROVEN** | `optn-chain-neutrino/src/filter.rs`; live BCHD scan agrees with the Bloom path on the same coins | Independent BCHD-produced filter fixtures not yet vendored |
| Sequential receive → spend lifecycle | **PROVEN** | `a_spend_is_found_through_an_outpoint_the_receive_scan_discovered`; spend invisible to a script-only scan | CashTokens/NFT/OP_RETURN/reorg/restart cases not covered |
| Wallet birthday and manual rescan | **PARTIAL** | `wallet_birthday.rs`, `RefreshScope`, `AppAction::RequestRescanFrom`, Settings row, `rescan_wallet_from` | Path is complete end to end; `WalletRestoreState` has no durable persistence yet, so a birthday does not survive restart |
| Local BCMR / authchain | **INTEGRATION** | `optn-core/src/bcmr.rs`, `optn-runtime/src/authchain.rs`, `token_metadata.rs`; 37 tests | Nothing calls them yet — no capability execution wires a resolver to a provider |
| Token capability execution | **INTEGRATION** | `optn-runtime/src/token_capability.rs`; refuses global totals from partial data | Planner and executor exist; no provider adapter routes through them |
| Broadcast lifecycle | **PARTIAL** | `optn-runtime/src/tx_broadcast.rs` | Uncertain-broadcast reconciliation exists; Send/PSBT/hardware/Fusion are not yet on one lifecycle |

---

## #71 — product UI

| Requirement | Status | Entry point / evidence | Gap |
| --- | --- | --- | --- |
| Web build produces a shipping bundle | **PROVEN** | `npm run build` → `dist/` (50 MB, typecheck clean) on Vitest 5 / Vite 8 | — |
| Four theme modes | **PROVEN** | `optn_app::ThemeMode` — Light, Gray, Green, Dark | — |
| Default / Cyberpunk skins | **PROVEN** | `optn_app::UiSkin` | — |
| Theme/skin persist without touching keys | **INTEGRATION** | `AppAction::SetTheme` / `SetSkin` | Persistence across restart not asserted |
| Landing: Create / Import / Watch Only | **PROVEN** (desktop) / **DEVICE EVIDENCE** (mobile) | `optn-ui/src/onboarding.rs`; matrix `watch_only` is `e2e` on Windows and Linux, `e2e-declared` on Android | iOS and F-Droid have no packaged assertion |
| Watch Only never gains signing authority | **PROVEN** | `WalletKind::WatchOnly`; `optn-core/src/watch_only.rs` | — |
| Master fingerprint asked once, persisted | **INTEGRATION** | `OpenedWallet::master_fingerprint` | Matrix evidence is `unit` on every surface except Android `e2e-declared` |
| Home / portfolio | **PARTIAL** | `AppRoute::WalletHome` | Exists; not audited against `docs/ui-overhaul` |
| Assets | **INTEGRATION** | `optn_app::assets_view_model`; `categories_total_across_every_coin_that_carries_them` | Leads with held categories rather than outpoints. Category is still raw hex until BCMR resolution is wired to it |
| **My NFTs** | **INTEGRATION** | `AppRoute::Nfts` → `#/nfts`, `optn_app::nfts_view_model`, `optn-ui/src/tools.rs::NftsPage`; `my_nfts_is_a_wallet_destination` | Screen exists in both renderers and opens from Assets. Identity still unresolved hex |
| Send / Receive | **PARTIAL** | `AppRoute::Send` / `Receive` | Screens exist; end-to-end spend from the Leptos UI not demonstrated |
| History / tx details | **PARTIAL** | `AppRoute::History` | Details view not separately routed |
| Owned CashToken/NFT state without a global indexer | **PROVEN** | `optn_app::assets_view_model` / `nfts_view_model`, derived from `state.coins` alone; consumed by both renderers | — |
| BCMR identity in Assets / My NFTs | **INTEGRATION** | `token_metadata::IdentityMetadata` keeps current / stale / unpublished / unresolved distinct | Not consumed by any screen |
| PSBT / SeedCash / UR | **INTEGRATION** | `optn-core/src/psbt.rs`, `airgap.rs`, `optn-ui/src/airgap.rs` | Matrix `unit` on all surfaces |
| RPA / Cash Code | **INTEGRATION** | `optn-core/src/rpa.rs` | Matrix `unit` |
| Hardware | **PARTIAL** | `optn-ui/src/hardware.rs`, `HardwareVendor` | Vendor-by-surface audit not done; no device evidence |
| CashFusion | **PARTIAL** | Rust protocol in `src-tauri/src/fusion/` + `optn-core/src/fusion/`; driven from `src/platform/desktop/Fusion*.ts` | Implemented and released; reported working on chipnet and mainnet. The remaining gap is the renderer/driver layer, not the protocol |
| 44px targets, safe areas, contrast | **PARTIAL** | `optn-ui` stylesheet | Not measured |
| Capacitor/React retained until Leptos is proven | **PROVEN** | Both trees present | — |

---

## What is genuinely blocked here

| Blocker | Needs |
| --- | --- |
| Packaged Android Play / F-Droid APK and iOS app asserting Watch Only on landing | Android SDK + signing config, and an Apple developer environment with a device or simulator. Nothing in this environment can produce or run them |
| Hardware wallet signing evidence | Physical Ledger / Trezor / Keystone devices |
| Mainnet header verification | A reviewed mainnet checkpoint to ship. `shipped_header_verifier` refuses mainnet rather than trusting whatever a peer serves first — deliberate, and a data decision rather than a code one |
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

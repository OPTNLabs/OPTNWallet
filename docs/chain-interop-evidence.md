# Chain interoperability evidence

What has actually been run against real nodes, with enough detail to repeat it.
Recorded because "the tests pass" and "this wallet works against the software
people run" are different claims, and only the second one is worth anything to
a holder.

Evidence is separated by kind, deliberately. Anything in the first table proves
a rule; nothing in it proves interoperability.

| Kind | What it establishes |
| --- | --- |
| Unit / synthetic | A rule holds against fixtures this repository wrote |
| Real local node | OPTN and a real implementation agree, on a private chain |
| Production-network rule | Mainnet/chipnet constants and difficulty rules, tested separately and never against regtest fixtures |
| Packaged app / device | Behaviour of a shipped artifact on a real target |

## Live shared wallet workflow — 2026-09-19

The opt-in `chipnet_wallet_runtime` test passed in 76.28 seconds against live
Chipnet at height 324131 through an isolated, runner-owned Tor process on
localhost port 19050. The test used the published BIP39 public HD fixture and
observed two transactions and one output; no signing or broadcast was attempted.

It exercised runtime HD sync, encrypted watch-only storage and restart, resumed
sync, `DirectTransport` state parity, retained stale observations after an outage,
lock clearing, the actual CLI `rescan --from-height 1`, and the saved-wallet CLI
stdio open/sync/history sequence. Partial-height scans report incomplete coverage.
This is Electrum **ServerAssertion** evidence, not an SHV/MMR or packaged GUI run.

The first run exposed a removed `--from-height` option. The repair restored its
runtime/persistence forwarding and partial-coverage reporting. All native CLI
chain operations now forward saved proxy confirmations through
`network_settings::build_stack`, including the persistent wallet console.

Repeat with a Tor process you own (the port is explicit authorization in the test
harness, never inferred from a listener):

```powershell
$env:OPTN_CHIPNET_TEST_TOR_PORT = '<owned Tor SOCKS port>'
cargo test --locked --manifest-path crates/optn-cli/Cargo.toml --test chipnet_wallet_runtime -- --ignored --nocapture
```

The same changes passed all 14 CLI wallet process tests and strict CLI Clippy.
Local run logs remain outside Git under `artifacts/issue75-live-20260919`.

## Environment

### Corrected Android server-override behavior — 2026-09-12

Actions run `34695691936`, artifact `10299220620`, built the Rust Leptos debug
APK from PR head `0e7da05811bdf4e9365ff4c4a70c3fd5720364a5` and merge
`47bec4e17b38ec126e624713c881536e44257079`.
SHA-256: `27c2a981aac6c49ac90def165be7800ff8444869079ed0c48ff39b7a10e562d7`.

The isolated Android 36 emulator required replacement installation because CI
debug signing keys differ between runs. Only its public-fixture encrypted
wallet/checkpoint and Chipnet settings were copied across; this is a persisted
data compatibility check, not proof of an in-place signed Android upgrade.
The saved wallet opened with its test password and restored 39,774 sats, one
output, two transactions and the same allocated receive address as stale.

With the host Tor bridge available, the old saved `127.0.0.1:1` override now
caused refresh to report no permitted wallet route and retain stale data. It
did not become up to date through the public source, as the earlier APK did.
Settings still displayed the selected local server. Explicitly changing the
field to `chipnet.imaginary.cash:50002` persisted an `explicit` source-ID scope
with no fallback. GUI refresh then reported `host:chipnet.imaginary.cash`, tip
323133 and the same 39,774-sat balance. The native file and rendered controls
agreed on the selected source.

A second force-stop/restart retained that explicit live-server selection and
the encrypted observations as stale. Refresh resumed successfully through the
same source without re-entering it. The Android-generated encrypted wallet,
checkpoint and settings were also copied into an isolated Windows fixture
directory and opened by the standalone CLI built at `df197b38`:

`optn --network chipnet --network-config-dir <fixture> --timeout 180 wallet --directory <fixture>/wallets --stdio`

Status, open, history, sync and history replies restored 39,774 sats and two
transactions at tip 323133, first stale and then fresh. The selected source
remained `host:chipnet.imaginary.cash`; observed process connections used
localhost Tor 9150. This exercises the real portable storage and CLI process,
not a separately constructed wallet. CLI stdio does not expose the UTXO count;
the one-output observation belongs to the GUI and earlier runtime tests.

The macOS ARM64 Rust Leptos debug DMG at the same PR head was built by fork
workflow run `34695691021`; its checksum and build metadata were verified.
SHA-256: `d88af1ae6ef6a2e463ce14829ab4bb747c59d40a429ba3f3400fd93249c34fef`.
This is macOS build/package evidence, not a macOS launch or signing test.

The Android result closes the specific server-override fallback regression.
It remains read-only `ServerAssertion` evidence using an authorized host Tor
bridge, not bundled Android Tor startup, SPV/MMR or SeedCash signing.

### Packaged Android watch-only restart and source-selection regression — 2026-09-12

Rust Leptos debug APK from Actions run `34693926047`, artifact `10297522988`:
PR head `a7af43d9d01cf1852f515f47ce0c25edacc7adad`, compiled merge
`3a84faa04e5453286e746b9dedac3952e69ad06e`, target `aarch64-linux-android`.
SHA-256: `359ff38efec1acb144b37636da36bdfbeaa675d8bdbfeb022a1506c97a87c34a`.

Installed on an isolated Android 36 x86_64 emulator using its ARM64 translation.
All wallet actions used the rendered controls. The public BIP39 account at
`m/44'/1'/0'` was validated, saved with a test password, and opened. The guest
stayed in airplane mode; an ADB reverse mapping connected guest localhost 9150
to the explicitly authorized host Tor service only while a Chipnet wallet was
open. No signing, broadcast, user wallet, or mainnet operation was involved.

The GUI synchronized against `chipnet.imaginary.cash:50002`: 39,774 sats,
one unspent output, two history entries, tip 323130, `ServerAssertion` evidence.
History showed a 50,000-sat receipt and a 10,226-sat debit including fees,
matching the CLI fixture. Removing the bridge and force-stopping/restarting the
app preserved the saved-wallet listing. A wrong password was rejected; the
correct password restored the same address allocation, balance and history
offline, explicitly labelled as saved data requiring refresh.

**This APK also exposed a privacy regression:** selecting `127.0.0.1:1` in
Servers saved the field but synchronization silently selected the public
bootstrap Electrum source. The legacy overlay writer used unrestricted Auto;
the shared reader merged public defaults into that selection. The accompanying
Rust repair restricts legacy overrides to their configured source IDs and
applies the same compatibility rule when GUI/CLI reopen old saved settings.
Its component/native/CLI checks do not replace retesting a rebuilt APK.

This proves packaged watch-only persistence and stale-state restoration. It
does not establish correct source isolation in the named APK, native Android
Tor startup, SPV/MMR verification, SeedCash signing, or complete #71/#75 parity.

### Managed watch-only import, persistence and CLI resume — 2026-09-12

Windows/Rust 1.98, `34ade590` plus the accompanying runtime, GUI/CLI and live-test
changes: the public BIP39 HD fixture at `m/44'/1'/0'` used the exact Chipnet
Electrum selection through Tor. The revised `chipnet_wallet_runtime` test
passed at height 323126 with two transactions and one output (72.38 seconds;
93.11 seconds after making the child-process pipe draining robust).

Unlike the earlier manually restored public checkpoint test, this run imports
through `WalletSecurityRequest::ImportWatchOnly`, writes the encrypted account
and checkpoint using the production native storage adapters, then syncs.
After locking and creating a new runtime, the saved-wallet list discovers the
record; opening it restores identical history, coins and partial scan coverage
as stale. Live sync restores freshness. A separate real CLI process then opens
the same saved wallet and resumes using the same persisted source selection.
Both CLI paths and the typed GUI transport agree on totals. Route failure
retains stale observations; lock clears the runtime view. Account xpub and
password do not appear in CLI replies or the stored account ciphertext.

`cargo test --locked --manifest-path crates/optn-cli/Cargo.toml --test chipnet_wallet_runtime -- --ignored --nocapture`

Evidence remains `ServerAssertion`, not SPV. This is managed-runtime/CLI live
evidence, not a packaged GUI test or a SeedCash signing round trip. The Rust
GUI's typed and scanned-account save controls compile against this same
request; the separate APK evidence above covers the typed-account restart flow.

### Chipnet manual rescan and restart — 2026-09-12

Windows, `a9b5d6f4` plus the accompanying shared rescan changes. The same
read-only public HD fixture and Tor source completed at height 323122, with
two transactions and one output. `rescan --from-height 1` reported partial
history coverage instead of claiming full history; CLI and typed transport
totals agreed. Encrypted checkpoint restore retained that coverage and the
default runtime refresh resumed from it. One attempt timed out at the source
during resync; the unchanged test passed on retry in 77.33 seconds.

This command exercises public-account checkpoint restore and the real CLI.
The private-wallet open path is separately covered by
`private_hd_manual_rescan_persists_floor_across_failure_restart_and_cancellation`,
which uses the actual encrypted checkpoint codec and wallet security actor.
Neither test proves a packaged GUI launch or signing.

### Chipnet shared-runtime restart verification — 2026-09-12

Executed on Windows against PR63 code at `61b11bc3` plus the accompanying
`chipnet_wallet_runtime` test extension. The test uses a published public HD
account, the exact persisted Chipnet Electrum selection, and a verified local
Tor SOCKS route. It does not sign or broadcast transactions.

`cargo test --locked --manifest-path crates/optn-cli/Cargo.toml --test chipnet_wallet_runtime -- --ignored --nocapture`

Result: PASS in 77.80 seconds; height 323116, two transactions, one unspent output.
The test verifies receive/change/DeFi HD discovery, matching CLI and typed
transport totals, stale retention after route failure, lock clearing, atomic
encrypted checkpoint storage, a new runtime restoring identical coins/history
as stale, and a live resync restoring freshness. The actual CLI `rescan` command
uses the same durable source policy. Evidence remains `ServerAssertion`; this
run does not establish SPV verification, packaged GUI behavior, or SeedCash
signing. Earlier local-node results below remain separate evidence.

Build note: use separate Cargo target directories for the workspace and the
excluded CLI workspace. A reused shared target produced an inconsistent cached
ECDSA type error; a fresh CLI target compiled and passed without a code change.

Recorded at OPTN commit `a69a055a` on `agent/rpa-shared-vectors` (PR #63).

### BCHD — BIP37 and compact filters

| | |
| --- | --- |
| Source | `github.com/gcash/bchd` at `d9c009aa` |
| Version string | `/bchd:0.22.2(EB32.0)/` |
| Services advertised | `0x0000000000000125` — NODE_NETWORK, NODE_BLOOM, SFNodeCF |
| Flags | `--regtest --addrindex --txindex --notls --nodnsseed` |
| P2P | `127.0.0.1:18444` (loopback only) |
| RPC | `127.0.0.1:18443` (loopback only, test credentials) |
| Data directory | isolated, discarded between runs |

Compact filters are on by default; `--nocfilters` would disable them.

### Route eligibility, against a public host and a private one

`live_route_eligibility_follows_ownership_not_address_shape`, in
`crates/optn-chain-native/src/lib.rs`. Opt-in; it reaches real hosts.

    OPTN_LIVE_PUBLIC_ELECTRUM=chipnet.imaginary.cash:50002     OPTN_LIVE_OWN_ELECTRUM=<your node>:50001     cargo test --manifest-path crates/optn-chain-native/Cargo.toml       -- --ignored --nocapture live_route

Run against `dperson/torproxy` on `127.0.0.1:9050` — one of
`AUTODETECT_SOCKS_PORTS` — and then again with that container stopped. The
same policy and the same sources both times; only Tor changed.

| Tor | Public `chipnet.imaginary.cash:50002` | Declared own node, private mesh |
| --- | --- | --- |
| verified on 9050 | eligible; served 10 headers, ASERT and MMR verified | eligible |
| stopped | refused: *"remote native chain route requires a verified Tor SOCKS proxy"* | eligible |

The bottom-left cell is the one that matters: no direct fallback, no DNS
attempt, nothing. The bottom-right is the other half of the same rule — Tor
is there to stop a third-party server learning which addresses this IP asks
about, and the holder's own node is not a third party. Requiring it there is
what had made own-infrastructure-only unable to reach any own infrastructure
that was not on `127.0.0.0/8`.

The test asserts both rows, choosing which by probing Tor itself, so it says
something whichever way the host happens to be configured rather than only
passing in a convenient environment.

### A real reorg, against BCHD regtest

`a_reorg_is_refused_then_rewound_and_pruning_keeps_the_commitment`, in
`crates/optn-chain-neutrino/tests/regtest_live.rs`. Run it with the node
below listening, `--ignored`.

| | |
| --- | --- |
| Node | `zquestz/bchd:latest`, bchd 0.22.2 |
| Flags | `--regtest --regtestanyhost --txindex --notls --listen=0.0.0.0:18444 --rpclisten=0.0.0.0:18443` |
| Genesis | `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`, which is the value `REGTEST_GENESIS_HEADER_HEX` hashes to |
| The reorg | a block the wallet had already verified, dropped with `invalidateblock`, then six mined over it |

Three things it establishes, none of which had been driven against a node
that reorganised:

- **Pruning does not move the commitment.** Headers below a floor are
  dropped and `VerifiedHeaderView::checkpoint()` is unchanged. Pruning is a
  storage decision; if it moved the root, a pruned wallet could no longer say
  which chain it had verified.
- **A forked branch is refused, not extended onto.** After the reorg the node
  serves a different branch from the fork point, and `extend` returns an
  error. A verifier that accepted it would carry a chain the node has
  abandoned.
- **Recovery is a rebuild, not a rewind.** `rewind_to` is the index half only
  — the accumulator is append-only, as `header_view.rs` says in place — so
  the test pins that rewinding alone still refuses the new branch, and that
  building again from the shipped anchor reaches the node's longer branch with
  a commitment that differs from the pre-reorg one.

What it does not establish: re-proving a *pruned* range needs an SHV peer, and
BCHD does not serve `getshv`. That half is covered separately below, against
BCHN.

### ZMQ notifications, against Bitcoin Cash Node

`crates/optn-chain-zmq/tests/bchn_live.rs`, three tests, run with `--ignored`
against the node below.

| | |
| --- | --- |
| Node | `zquestz/bitcoin-cash-node:latest`, BCHN 29.1.0 (`v29.1.0-b31ed10b4`) |
| Flags | `-regtest -server -listen=0 -zmqpubrawtx/-zmqpubhashtx/-zmqpubrawblock/-zmqpubhashblock=tcp://0.0.0.0:28332` |
| Confirmed by | `getzmqnotifications` listing all four publishers on one socket |
| Services | `0000000000000425` — NODE_NETWORK, NODE_BLOOM, NODE_BITCOIN_CASH; bit 9 clear, so this build advertises no SHV |

What it establishes:

- **The two block topics agree, and the node holds the block.** The hash this
  crate computes from the first 80 bytes of a `rawblock` is the same hash
  `hashblock` reports, and `getblockheader` on it succeeds. The event
  identifies a block. It does not prove one.
- **The two transaction topics agree on one txid**, so a consumer woken by
  `hashtx` can match what `rawtx` would have reported.
- **Sequence numbers advance by one per topic**, which is what makes a
  dropped notification detectable rather than silent. BCHN does send the
  frame; without it a gap would be indistinguishable from a quiet node.

**A bug this found.** BCHN publishes the `hash*` topics with the uint256
reversed — `data[31 - i] = hash.begin()[i]` in the publisher — so those frames
carry display order while `sha256d` over a `rawtx` or `rawblock` body yields
internal order. `parse_hash` took the frame as it arrived, so the same
transaction reached the runtime under two byte-reversed txids depending on
which topic reported it, and the one from `hashtx` matched nothing the wallet
held: a wake-up about a payment, reversed into a payment that does not exist.

It survived unit testing because the fixture was 32 equal bytes, which is its
own reversal. Only a real node could produce a hash that is not a palindrome.
Fixed in `parse_hash`, with the byte order now stated on `ChainEventKind`
itself, where the next provider author will look.

What it does not establish: double-spend proofs. `rawds`/`hashds` are
subscribed and parsed, but regtest with one node produces none, so that topic
is still component evidence only.

### Bitcoin Cash Node — SHV

| | |
| --- | --- |
| Source | `mmr-squashed` work at `e6d380373` ("proof-to-peak refinement") |
| Version string | `/Bitcoin Cash Node:29.0.1(EB32.0)/` |
| Services advertised | `0x0000000000000625` — includes NODE_SHV (bit 9) |
| Flags | `-regtest -mmrindex=1 -listen=1 -dnsseed=0` |
| P2P | `127.0.0.1:19444` (loopback only) |
| RPC | `127.0.0.1:19443` (loopback only, test credentials) |
| Build | cmake/ninja, Release, Qt/wallet/ZMQ/seeder off |

Without `-mmrindex=1` this node still advertises NODE_SHV and then has nothing
to prove from, which is a different failure to not supporting it.

Two build notes worth keeping. The source needs GMP and zlib beyond the obvious
dependencies. And because the checkout lives on a Windows filesystem, its shell
scripts — and the `.sh.in` templates cmake expands into more shell scripts —
carry CRLF, whose shebangs then name an interpreter that does not exist; the
build normalises a copy inside the container rather than touching the checkout.

## Wallet under test

A published BIP39 test vector, first receive address at `m/44'/1'/0'/0/0`
(regtest shares testnet's SLIP-44 coin type):
`bchreg:qqaz6s295ncfs53m86qj0uw6sl8u2kuw0ypvash69n`.

Coins on a private chain, worth nothing anywhere. No user funds, no user
wallet files, and no key material is written to any file, log or environment
variable by any of this.

## Real local-node results

### Headers and Bloom discovery — BCHD

`cargo test --manifest-path crates/optn-chain-bip37/Cargo.toml --test regtest_live -- --ignored`

- Genesis computed by OPTN matched the node's `getblockhash 0`:
  `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`.
- 155 headers synced over `getheaders`, verified through the runtime
  (linkage, declared proof-of-work, the network's difficulty rule) and written
  to the accepted store. The accumulator's height agreed with the store's,
  which is what catches headers accepted but mis-attributed.
- A Bloom scan for the wallet's script matched 160 transactions.
- A birth height behaved as an inclusive floor in both directions.

### Compact filters — BCHD

`cargo test --manifest-path crates/optn-chain-neutrino/Cargo.toml --test regtest_live -- --ignored`

- The genesis filter probe committed, so the capability was verified rather
  than merely advertised.
- The same wallet found the same coins as the Bloom path over the same chain —
  120 transactions and 600000000000 sats when both were run against an
  unspent chain. Two independent discovery mechanisms agreeing on the money is
  the check that OPTN's filter entry set matches what BCHD actually produces.
- A regtest node asked to speak for mainnet reported a wrong chain rather than
  a missing capability.

### Receive, then spend, from wallet knowledge alone — BCHD

The sequential lifecycle §6 asks for, with nothing preloaded:

1. The wallet knows one script.
2. A compact-filter scan finds its coins, and a mature coinbase outpoint is
   taken from that scan — the only way a restoring wallet could learn it.
3. A spend of that outpoint is built and signed with `optn-core`, paying a
   script this wallet does not watch.
4. The node accepts the transaction and mines it.
5. A scan carrying the discovered outpoint finds the spend at height 153.

The step that makes it evidence: a scan for the script **alone** does not see
that spend, so the match came from the serialized spent outpoint in BCHD's
filter and not from an output script. Broadcast was also driven through OPTN's
own BIP37 relay path in a scratch run, so a signature this wallet produced is
one a node accepted.

### SHV proofs — Bitcoin Cash Node

`OPTN_BCHN_SHV_P2P=127.0.0.1:19444 cargo test --manifest-path crates/optn-chain-bip37/Cargo.toml --test regtest_live -- --ignored`

- OPTN's own client completed the handshake; the node advertised NODE_SHV.
- OPTN synced 20 headers and computed its own root,
  `c83a776889fd893c030f980c17649ded0bc8d2325cc9d1f29b7ceeea8f2e4640`.
- The node's `getshv` proof for height 5 named **that same root**, and OPTN
  accepted it as `HeaderMmrProven`.
- A target the node picked for itself was refused.

The advertisement is not the evidence. Bit 9 is also BCHD's historical
XThinner assignment, so the proof is what settles it.

## What is not covered here

Recorded so the gap is not mistaken for a pass.

- **Packaged app and device behaviour.** Nothing here says anything about the
  Android, F-Droid or iOS artifacts. That needs the artifacts and the devices.
- **Production-network rules.** These runs are regtest. Mainnet and chipnet
  constants and difficulty behaviour are covered by separate tests and are
  deliberately not exercised by any regtest fixture.
- **Mainnet header verification.** No reviewed mainnet checkpoint ships in this
  build, so `shipped_header_verifier` refuses mainnet rather than anchoring
  trust on whatever a peer served first. Routes that do not need verified
  headers keep working; BIP37 and Neutrino decline.
- **Tor.** Every run above is loopback. The Tor route has its own timeouts and
  has not been exercised against these nodes.
- **Reorg and restart.** The header store and the replay module have unit
  coverage for both, but neither has been driven against a live node here.

## 2026-09-19: native Leptos GUI live Chipnet and offline reopen

An isolated Windows Tauri/Leptos debug executable (identifier `com.optilabs.wallet.issue75test`, SHA-256 `0d9b2ca31d5291ec0b29f158276713152ed2a1bab134169adfd17ffdbb5d6b8e`) imported the public BIP39 fixture as a watch-only HD account at `m/44'/1'/0'`. Through visible GUI controls, a runner-owned Tor SOCKS port 19050 was explicitly confirmed, the Electrum policy selected, and Refresh wallet invoked. At height 324136 the GUI displayed 39,774 sats, one output, and two history entries (received 50,000 sats and sent 10,226 sats). The UI explicitly labelled the evidence Server assertion.

The runner stopped that Tor process and restarted the same executable. Opening the encrypted watch-only wallet displayed the same 39,774 sats, receive address and both history entries, labelled `Saved balance · refresh needed`, with the network offline. This verifies the actual packaged Windows UI and native encrypted restart path; it does not establish SHV/MMR proof, live P2P resume, transaction signing/broadcast, Android/macOS packaging or all-renderer parity. Public screenshots and logs remain outside Git under `artifacts/issue75-live-20260919`.

An attempted refresh while Tor was stopped refused the unavailable route and retained the same stale balance/history. After restarting the owned Tor process, Retry connections and Refresh wallet returned the same account to `Up to date`. This proves saved-state recovery and a subsequent live refresh, not a suffix-only network download: ordinary HD refresh currently rechecks account history from its configured scan floor.

## 2026-09-19: durable restore settings through GUI and CLI

The shared Rust `SetBirthday` request now seals imported height/date/unknown
provenance with wallet restart state before acknowledging success. HD sync
resolves that state inside the same actor turn that issues its sync lease.
The connected runtime regression cancels an in-flight scan after a changed
hint, reopens the encrypted wallet, and observes the saved floor in every HD
provider round. An unresolved date makes no provider request with a guessed
floor. Legacy manual floors survive migration separately from birthdays.

The real CLI process suite passed all 15 tests, including height/date/unknown
updates across process restarts and stale-epoch rejection. The runtime suite
passed 278 tests, including storage failure, imported-hint correction, legacy
migration and the connected HD sequence. These are local deterministic tests.

An isolated Windows Tauri/Leptos debug executable (SHA-256
`417e5aed41aa518985a3f9d80cffb9057b12bfacd0c39e60e021abf358f16a78`,
base `29b3434f` plus the restore-settings worktree changes) used visible settings
controls to save height zero, restart, save 2020-01-01 UTC, and restart again.
Both choices reappeared, with the existing 39,774-sat cached balance retained
and labelled stale. The test reset the hint to Unknown and stopped its own
process. Evidence is outside Git in `artifacts/issue75-live-20260919`.

This GUI run was offline: it does not prove live date-based P2P recovery,
automatic header acquisition, signing, broadcast or other packaged platforms.
Trusted fresh-wallet creation anchors are not inferred from caller-supplied
mnemonics. An outstanding manual rescan takes precedence until explicitly cleared.

The follow-up `ClearRescan` command uses the same durable storage/session guard
and leaves birthday provenance intact. Its connected runtime test restores the
birthday's floor after an override; the CLI process test clears and reopens
without resurrecting the override. A Windows GUI build (SHA-256
`0e454f6b9407339e890a382e3bb6aa2adb395040c265103598b3f7455d93e8cd`,
base `66204fa8` plus this follow-up) visibly requested a height-zero manual
rescan while offline, displayed the override without reopening the settings
pane, and cleared it through the confirmation control. The cached 39,774 sats
remained visible and stale. This is offline control/persistence evidence,
not a successful network rescan.
# 2026-09-19: imported-date header acquisition (runtime integration)

`sync_hd_wallet_from_floor` now catches a typed unresolved-history-start result
and performs the existing bounded verified-header pass on a permitted wallet
route before asking the actor to resolve the saved date again. The original
runtime generation travels with `BeginHd`; changing the wallet or restore intent
during I/O cannot obtain a lease for the replacement context. Source revocation
is checked before retry. No wallet query uses a guessed floor.

The existing durable-birthday actor regression now starts with no time anchors,
acquires synthetic proof-of-work/ASERT-valid headers on its selected provider,
resolves block 20, verifies that every HD round uses that floor, and cancels a
held header request after a birthday change without another wallet query.
These synthetic parameters are test-only and are never installed by production.
All 278 runtime tests pass; strict runtime Clippy, CLI check, native GUI
library/test check and rustfmt pass. This is connected integration evidence,
not a new live Chipnet or packaged-device run. An unavailable verifier, missing
route, failed pass, or still-unresolved historical date remains fail-closed;
one bounded pass does not claim exhaustive historical recovery.

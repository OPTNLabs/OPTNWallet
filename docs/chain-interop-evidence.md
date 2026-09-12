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

## Environment

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

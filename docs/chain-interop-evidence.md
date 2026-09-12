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

## PR #89 CashCode validation — 2026-09-12

This section is separate from the historical PR #63 regtest evidence above.
The designated Chipnet test profile was loaded through Windows Credential
Manager; no recovery phrase or private key was exported. All destinations are
test-wallet addresses. The new receipt discovery and sweep use `optn-runtime`
and `optn-core`; desktop TypeScript only adapts IPC, UI, and existing persistence.

### Fulcrum: live discovery and signed sweep preview

With a saved exact-source policy selecting `chipnet.bch.ninja:50002` (TLS),
`optn --network chipnet --profile <test-profile> --network-config-dir <fulcrum-config>
--json --timeout 600 rpa discover --from-height 323041` returned:

- Complete requested scope through height **323130**, including mempool.
- Receipt `7658fbe1cf34f6c1393ab017e92f36e186a199e8b512a1786bff547b0a8d2680:0`,
  **50,002 satoshis**, confirmed at height **323041**, unspent, no tokens.
- Stealth address `bchtest:qqa2np3npedy36s8kdj7glpndwr4ap0hkyhd6fa7h4` and its
  public input-origin recipe. No known-transaction hint was supplied to discovery.
- Evidence remains `ServerAssertion`; an index response is not a consensus proof.

On the same saved route, `rpa sweep
bchtest:qqs3eeafad6hv2d8g7tzc9xhl5p72xtzjcfyv70a96 --from-height 323041 --dry-run`
returned one input, **49,809 satoshis** back to the test wallet, and a **193-satoshi**
fee. Its transaction ID was
`43947112df64d86a11d870c1f6e4f46048769dbc0707a7bfce109a39bd092982`.
The signed bytes passed an independent libauth BCH VM check against the real
receipt's value and locking script. This preview was **not broadcast**.

The new selected-source `rpa pay <self-cashcode> 50003 --gap 1 --dry-run`
also completed on that Fulcrum policy. It discovered the real **18,778,868-satoshi**
HD change output, built a **50,003-satoshi** payment plus **18,728,639-satoshi**
change and a **226-satoshi** fee, and ground the input prefix in 3,206 attempts.
The resulting transaction
`a5ffbf8de6152ce45e630182464c5f612015a7ccf5d7b48c37074a6c4b61eb99`
passed the independent BCH VM against its freshly fetched parent transaction.
It was not broadcast. Funding discovery and submission share the selected source
and endpoint; the existing Rust payment builder is reused across providers.

### BIP37: scope and verification boundary

Live Chipnet discovery is not yet established by the evidence recorded here.
Earlier attempts failed during cold header synchronization; they did not publish
partial receipts. Consecutive public-header batches now reuse the selected-node
connection, with one bounded same-node reconnect on transport interruption.

Discovery uses an all-match filter and scans complete blocks locally from the
inclusive birthday. It never uploads candidate outpoints or derived stealth
scripts to another provider. Accepted headers, complete merkle matches, and
transaction identities are checked before publication. A late failure rejects
the pass rather than reporting partial history as complete.

BIP37 block discovery is **confirmed-chain-only**: it cannot establish absence
of unconfirmed spends. Both UI and CLI expose this limitation. A source or Tor
policy change invalidates publication. Mainnet P2P remains gated on a reviewed
checkpoint; these Chipnet checks do not establish mainnet or packaged-device parity.

### Local checks and unrelated emulator boundary

- Full TypeScript suite (`npm test -- --maxWorkers=1`): **1,927 passed,
  10 skipped** across 327 files, against the regenerated Rust WASM.
- Desktop production bundle (`npx vite build --config vite.desktop.config.ts`),
  core TypeScript check, and generated-WASM freshness check passed.
- Rust core, runtime receipt/sweep, accepted-header continuation, BIP37, and
  native locator/network regression tests passed; native and WASM checks passed
  using Rust **1.98.1**.
- The review-summary SeedCash fixture now uses distinct parent-output values.
  Its optional live signer test was attempted against the existing external
  SeedCash checkout, but that checkout lacks the compatible signer API and its
  signer references a missing `Bip44.derive_private_child_key`. This is not a
  successful emulator-signing result and is not required by CashCode discovery.
- Packaged desktop interaction, mainnet spending, and reorg/restart live tests
  are not established by these results.

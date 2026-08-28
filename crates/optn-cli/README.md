# optn — OPTN Wallet CLI

A headless interface to OPTN Wallet, built to be driven by scripts and agents
as readily as by people.

## Install

Download the binary for your platform from a release and put it on your `PATH`.
Binaries are published for:

| Platform | Architectures |
| -------- | ------------- |
| Linux    | `x64`, `arm64`, `riscv64`, `armv7` |
| macOS    | `arm64`, `x64` |
| Windows  | `x64` |

To build from source you need Rust 1.77.2 or newer:

```bash
cargo build --release --manifest-path crates/optn-cli/Cargo.toml
```

RISC-V and 32-bit ARM are cross-compiled from x86_64 and need only a linker:

```bash
sudo apt-get install -y gcc-riscv64-linux-gnu
rustup target add riscv64gc-unknown-linux-gnu
CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_GNU_LINKER=riscv64-linux-gnu-gcc \
  cargo build --release --target riscv64gc-unknown-linux-gnu
```

This works because the CLI has no Tauri dependency. The desktop app links
webkit2gtk and therefore has to be built on the target architecture; the CLI
does not, so any target Rust supports is reachable from any host.

## First commands

```bash
optn ping                                     # is the server reachable
optn balance bitcoincash:qpm2qsz...           # confirmed + unconfirmed
optn utxos bitcoincash:qpm2qsz...             # unspent outputs
optn tx <txid> --verbose                      # fetch a transaction
optn broadcast <signed-hex>                   # publish a signed transaction
```

With a recovery phrase in `OPTN_MNEMONIC`, the wallet commands work on your own
addresses rather than one you name:

```bash
optn rescan                                   # rebuild the view from the chain
optn history --limit 25                       # transactions across your addresses
optn tokens                                   # CashToken balances
optn send <address> <sats> --yes              # spend BCH
optn token-send <token-address> <amount> --category <id> --yes
optn send-nft <token-address> --category <id> --commitment <hex> --yes
optn decode <raw-hex>                         # inspect a transaction, tokens included
```

Every spending command refuses to run without `--yes`, and `--dry-run` builds
and signs without broadcasting so you can inspect the result first.

## Networks

`--network mainnet` (default) or `--network chipnet`. The network selects the
default Electrum server and is checked against the address prefix.

That check matters more than it looks. Querying mainnet for a `bchtest:`
address does not fail — the server simply reports no history, which reads
exactly like an address that has never been used. The CLI refuses the
combination instead:

```
$ optn --network chipnet balance bitcoincash:qpm2qsz...
error: 'bitcoincash:qpm2qsz...' is a bitcoincash address but --network is
chipnet; querying the wrong chain returns an empty result, not an error
```

## Recovery phrases and addresses

```bash
optn new --words 12                    # 12, 15, 18, 21 or 24
echo "$PHRASE" | optn address          # m/44'/145'/0'/0/0 on mainnet
echo "$PHRASE" | optn address --account 1 --index 5 --change
echo "$PHRASE" | optn discover         # which paths actually have history
```

**The phrase is never a command-line argument.** It is read from
`OPTN_MNEMONIC`, or from stdin if that is unset. Arguments appear in shell
history and in `ps` output to every other user on the machine, and a recovery
phrase is the whole wallet. `OPTN_PASSPHRASE` supplies BIP39's optional 25th
word.

All five BIP39 lengths are accepted on import — 12, 15, 18, 21 and 24 words.

### Derivation paths

| Network | Account path          | Prefix         |
| ------- | --------------------- | -------------- |
| mainnet | `m/44'/145'/account'` | `bitcoincash:` |
| chipnet | `m/44'/1'/account'`   | `bchtest:`     |

`optn discover` scans wider than the default, because a seed restored from
other BCH tooling may sit under a coin type this wallet would not pick:

- mainnet — coin types `145`, `0`
- chipnet — coin types `1`, `145`, `0`

each across accounts `0` and `1`. That set comes from
`docs/bch-derivation-paths.md`, not from guesswork. `--gap` controls how many
addresses per chain are checked before an account is considered empty.

## Paying for HTTP with x402

x402 makes HTTP 402 a working status code. A server answers a request with what
it charges, the client pays on-chain, and the request is repeated carrying
proof of payment. The x402-bch variant settles on Bitcoin Cash and, unlike the
original, the Facilitator holds no wallet — clients pay servers directly and
the Facilitator only verifies.

Ask what something costs. This reads only; it never spends:

```bash
optn x402 check https://api.example.com/forecast
```

```
status    402  payment required
price     1000 sats
pay to    bitcoincash:qqlrzp23w08434twmvr4fxw672whkjy0py26r63g3d
chain     bip122:000000000019d6689c085ae1
scheme    utxo
```

Payment is **batched**, which is what makes this usable by an agent. You fund a
server once and every later call debits that credit without touching the chain,
so a few hundred API calls cost one transaction rather than a few hundred:

```bash
optn x402 pay https://api.example.com/forecast --fund 100000 --yes   # once
optn x402 pay https://api.example.com/forecast                       # and after
```

The first form broadcasts a funding transaction and authorises against it. The
second signs an authorisation against the credit the server already holds and
spends nothing, which is why only the first needs `--yes`.

`--dry-run` prints the exact header that would be sent without funding or
requesting anything. To debit a funding output you created elsewhere, name it
in full with `--txid`, `--vout` and `--funded`.

A few things the command will refuse, and why:

- **Plain HTTP anywhere but localhost.** The payment header carries a signed
  authorisation to debit your credit; anyone who reads it in transit can spend
  that credit on their own requests.
- **A server with no BCH option.** Servers may advertise several chains. Paying
  an EVM requirement with a BCH signature fails at the Facilitator with an
  error that says nothing about the real cause, so the option is picked by
  scheme rather than by position.
- **A `payTo` on the other chain.** It is decoded under `--network` first, so a
  mainnet address is never paid while you believe you are on chipnet.
- **`PAYMENT-SIGNATURE` passed as `--header`.** That header is built from your
  key; supplying it by hand would send an authorisation this wallet did not
  sign.

The authorisation is signed as a Bitcoin Signed Message — the same construction
wallets have used for years, whose magic prefix is what stops a message
signature being replayed as a signature over a transaction.

## Using it from a script or an agent

- `--json` on any command emits a stable object on **stdout**. Errors are also
  JSON when `--json` is set, shaped `{ "ok": false, "error": ..., "message": ... }`.
- Without `--json`, diagnostics go to **stderr** and data to stdout, so piping
  is safe.
- Nothing prompts. There is no interactive mode to get stuck in.
- Exit codes distinguish causes, so a caller does not have to parse English:

| Code | Meaning |
| ---- | ------- |
| `0`  | success |
| `2`  | usage — malformed address, bad flag, wrong network |
| `3`  | network — could not reach the server |
| `4`  | protocol — the server answered with something unusable |
| `5`  | server — the server returned an explicit error |
| `70` | internal — a defect in this program, please report it |

```bash
optn --json balance "$ADDR" > out.json || case $? in
  2) echo "check the address"   ;;
  3) echo "server unreachable"  ;;
  *) echo "unexpected failure"  ;;
esac
```

## Debugging

**A balance of zero that you did not expect.** Run `optn inspect <address>`.
It performs no network call and shows the scripthash the server is being asked
about. An address with no history and an address whose scripthash was derived
incorrectly both return zero; this is what separates them.

```bash
$ optn inspect bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a
address     bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a
network     mainnet
kind        P2pkh
hash160     76a04053bda0a88bda5177b86a15c3b29f559873
script      76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac
scripthash  71b6a00546326a622c2a484e88a81909706a0cce15009aa87fd9a6569ca84c93
```

**Timeouts.** `--timeout` is 30 seconds. A server that accepts the connection
and never answers produces exit code 3 with the endpoint named.

**A specific server.** `--host` and `--port` override the network default.
`--no-tls` exists for a local server on a plaintext port; do not use it across
a network.

**Exit code 4.** The server replied with something that is not valid JSON or
lacked a `result`. Usually a wrong port — a plaintext request to a TLS port
tends to land here rather than at exit 3.

## Scope

Covered today: Electrum-backed queries and broadcast, recovery-phrase
generation, address derivation and derivation-path discovery, rescan and
history, transaction construction and signing, CashTokens — fungible and NFT —
and x402 payments.

Spending always requires `--yes`. This binary is meant to be run by automation,
so a spend is never reachable by accident, and `--dry-run` exists so a caller
can inspect a signed transaction before committing to it.

Not here yet: covenant spending, the local RPC server and console, and
Quantumroot. See the tracking issue.

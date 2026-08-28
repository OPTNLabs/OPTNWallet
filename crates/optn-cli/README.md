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

Today this covers Electrum-backed queries and broadcast. Key management,
derivation-path discovery and transaction construction are not implemented yet;
see the tracking issue for the planned surface.

Signing commands, when they land, will require an explicit opt-in rather than
being reachable by default, because this binary is designed to be run by
automation.

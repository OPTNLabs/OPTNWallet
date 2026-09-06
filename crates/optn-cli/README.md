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

RISC-V and 32-bit ARM are cross-compiled from x86_64:

```bash
sudo apt-get install -y gcc-riscv64-linux-gnu libc6-dev-riscv64-cross
rustup target add riscv64gc-unknown-linux-gnu
CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_GNU_LINKER=riscv64-linux-gnu-gcc \
  cargo build --release --target riscv64gc-unknown-linux-gnu
```

Both packages, not just the compiler. `ring` — reached through rustls, which is
how Electrum TLS and x402 both talk HTTPS — compiles C for curve25519, and
`gcc-*-cross` ships no target headers. Without `libc6-dev-riscv64-cross` the
build falls back to the host `/usr/include` and fails on a missing
`bits/libc-header-start.h`: an error naming a host header, which points away
from the actual cause. 32-bit ARM needs `libc6-dev-armhf-cross` for the same
reason.

This works because the CLI has no Tauri dependency. The desktop app links
webkit2gtk and therefore has to be built on the target architecture; the CLI
does not, so any target Rust supports is reachable from any host given a cross
toolchain.

The property that matters is not "no C" — `ring` has some — but that nothing in
the graph needs a build system that will not cross: no CMake, no OpenSSL, no
pkg-config hunting for a host library. `tokio-rustls` is pinned to `ring`
rather than the default `aws-lc-sys` for exactly that reason, and the keychain
uses the Linux kernel keyring rather than Secret Service so no dbus enters the
tree.

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
selected Electrum server and is checked against the address prefix. With no
`--host`, `--port`, or `--no-tls` override, the CLI reads the same network-
scoped settings file as the desktop wallet. It uses the normal app-config
directory plus `com.optilabs.wallet`, or an explicit `--network-config-dir`
or `OPTN_NETWORK_CONFIG_DIR` for scripts and portable profiles.

If that shared file contains a richer source policy the current direct-Electrum
CLI cannot enforce, it refuses the command instead of silently falling back to
a public server. Explicit endpoint flags remain a deliberate override.

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

## Covenants

The wallet ships nine compiled CashScript artifacts, built into this binary, so
a contract address can be derived on a machine with no checkout:

```bash
optn contract list
optn contract info TransferWithTimeout
optn contract address TransferWithTimeout --arg <pubkey> --arg <pubkey> --arg 1000
```

Addresses are pinned to eighteen vectors generated with the `cashscript`
library itself, across both networks. That is not ceremony: an address from a
plausible-looking reimplementation is worse than none, because funds sent to it
are locked under a script for which nobody holds a spending path, and nothing
about the address looks wrong. The vectors caught exactly that — the CashAddr
size bits index 160/192/224/256, so 256 bits is `3` and not `4`, and the wrong
value produced a well-formed address with a valid checksum that was not the
contract's.

Constructor arguments are parsed against the type the artifact declares rather
than guessed from how they look, and pushed in reverse declaration order,
because that is what puts them on the stack in the order the compiled code
expects.

## Quantumroot

[Quantumroot](https://github.com/bitjson/quantumroot) is a post-quantum vault
implemented in CashAssembly. Its signing scheme is Leighton-Micali One-Time
Signatures — RFC 8554, parameter set `LMOTS_SHA256_N32_W4` — resting on SHA-256
alone, with no lattices and nothing whose security estimate moves year to year.

```bash
echo "$SEED" | optn quantumroot keygen --id <16-byte-hex>
echo "$SEED" | optn quantumroot sign <message-hex> --id <16-byte-hex> --yes
optn quantumroot verify <message-hex> --signature <C||elements> \
  --public-key <hex> --id <16-byte-hex>
```

**One-time is the security model, not a caveat.** A key signs exactly one
message; signing twice exposes enough hash-chain points that a third party can
forge a signature on a message neither party chose. So `sign` requires `--yes`
the way spending does, and in the library the signing method consumes the key
rather than leaving that to a caller to remember.

The implementation is pinned to Quantumroot's own reference implementation and
its published vector, not to a reading of the RFC — private chains, public key
and signature all match byte for byte. The two agree here, but a signature
scheme that is merely plausible is worthless, and the difference would not
surface until a real vault refused to open.

## A local RPC endpoint

An agent that shells out pays process startup on every call:

```bash
optn serve --port 8787
# optn serving on http://127.0.0.1:8787
#   token      3f9a...        (generated)
#   spending   refused
```

Requests name a command and give its arguments exactly as the command line
takes them, so the same parser, policy and output apply. What it refuses:

- **Off-loopback binds**, unless asked for in as many words — and
  `--allow-remote` additionally requires `--token`, because a token printed to
  a terminal is not a credential anyone remote has.
- **Requests without the bearer token.** Localhost is not a boundary: every
  process on the machine can reach it, and so can any web page that can make a
  cross-origin request. Responses carry `access-control-allow-origin: null` so
  such a page cannot read the answer.
- **Anything that moves funds**, unless `--allow-spend`. An HTTP endpoint that
  can spend outlives the decision to start it in a way a single command does
  not, and `GET /skills` reports the restriction so an agent sees `send` marked
  unavailable rather than discovering it.

## The console

```bash
optn --network chipnet console
optn> balance bchtest:qq...
optn> contract info TransferWithTimeout
optn> quit
```

The same commands, keeping the phrase and the connection between them. `help`
is generated from the skill manifest, so it cannot list a command the gate
would refuse or omit one it allows — refused ones are marked rather than
hidden. Quoted arguments survive, a backslash is literal inside single quotes
as in a shell, and an unterminated quote is refused rather than closed for you:
silently completing it would run a command with an argument nobody typed.

## Keeping the phrase in the OS keychain

The phrase has to reach the process somehow, and the obvious ways are both bad.
An argument lands in shell history and in `ps` output, where any other user on
the machine can read it. An environment variable is inherited by every child
process and is readable from `/proc/<pid>/environ`. Stdin is safe, but it
cannot be automated without putting the phrase in a file.

The keychain is the platform's own answer:

```bash
echo "$PHRASE" | optn --network chipnet keychain store
optn --network chipnet keychain status     # presence only, never the phrase
optn --network chipnet keychain remove
```

After that, commands needing the wallet find it themselves:

```bash
optn --network chipnet balance             # no OPTN_MNEMONIC, no stdin
```

Entries are keyed by network *and* `--profile`, so a mainnet and a chipnet
wallet may share a profile name without one overwriting the other. `store`
refuses to replace an existing entry without `--force`, and validates the
phrase before writing it — an unusable phrase stored now fails later, at the
moment someone is trying to spend.

Sources are consulted in order: `OPTN_MNEMONIC`, then the keychain, then stdin.
The environment wins so a scripted run can override without clearing what is
stored. Stdin is last because reaching it means blocking on input, which for a
binary driven by automation is a hang rather than a prompt.

| Platform | Store | Survives a reboot |
| --- | --- | --- |
| Windows | Credential Manager | yes |
| macOS | Keychain | yes |
| Linux | kernel keyring | **no** |

Linux uses the kernel keyring rather than Secret Service, because Secret
Service means dbus, dbus means C, and C means the cross-builds to riscv64 and
armv7 stop working. The consequence is that a stored phrase there lives in
kernel memory for the session and is gone after a reboot. `keychain status`
reports this rather than leaving it to be discovered.

## Driving it from an agent

`--help` is prose, and parsing prose to decide whether a command spends money
is not a safety mechanism. `optn skills` publishes the same table the binary
enforces:

```bash
optn --json skills
```

Every command comes with a capability — `read`, `secret`, `sign` or `spend` —
along with whether it needs the wallet, whether it touches the network, and
whether it demands `--yes`.

The second half is a policy, so whoever runs the agent can say what it may do
and have the binary enforce it rather than trusting the agent's restraint:

```bash
OPTN_POLICY=read optn --json balance "$ADDR"   # fine
OPTN_POLICY=read optn --json send "$ADDR" 1000 --yes
# error: policy 'read' does not permit 'send' (moves funds, or authorises a
# debit). Raise OPTN_POLICY to 'spend' to allow it.
```

Each level admits everything below it: `read` ⊂ `secret` ⊂ `sign` ⊂ `spend`.
Note that `read` does not include `address` or `history` — those derive keys
from the recovery phrase, and reading a secret is not a read-only act.

The check runs before the command does anything, so a refusal opens no
connection and reveals nothing. A command the manifest does not classify is
refused rather than allowed: a missing entry is a hole in the manifest, and
failing closed is what makes it visible. The default policy is `spend`, because
spending is already gated behind `--yes` and a default that broke every
existing invocation would be switched off rather than used — the policy is the
second lock, not the first.

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
x402 payments, OS-keychain storage, the agent skill manifest with its policy
gate, CashScript covenant addresses, Quantumroot LM-OTS signatures, a local
JSON-RPC endpoint and an interactive console.

Spending always requires `--yes`. This binary is meant to be run by automation,
so a spend is never reachable by accident, and `--dry-run` exists so a caller
can inspect a signed transaction before committing to it.

Not here yet: spending *from* a covenant. Addresses derive and contracts are
inspectable, but building and signing a spend against one needs the unlocking
script and the scriptCode substitution in the sighash, which is the next piece.
See the tracking issue.

# BCH derivation paths, network defaults, and legacy recovery

## Canonical rule

The BIP44 account path is **per wallet**, stored in `wallets.derivation_path`. The network
default only pre-fills the field on create and import — it never overrides a stored path.

| Network | Default account path | Extended key | Address prefix |
|---------|---------------------|--------------|----------------|
| mainnet | `m/44'/145'/account'` | `xpub` | `bitcoincash:` |
| chipnet | `m/44'/1'/account'` | `tpub` | `bchtest:` |

`145` is BCH's registered SLIP-44 coin type. `1` is SLIP-44's "Testnet (all coins)", so it
covers any test network this wallet gains later without needing a new coin type.

The network changes extended-key and CashAddr encoding. It does not, by itself, change the
account path — the stored value does.

## Both numbers stay valid everywhere

Coin type is not policy. `normalizeBchAccountPath` (`src/services/HdWalletService.ts`) accepts
`m/44'/<coinType>'/<account>'` for any hardened 31-bit coin type, and the user can set one:

- create / import — the derivation path field (`DerivationPathField`, `Bip44AccountPathFields`)
- after the fact — Settings → derivation path (`DerivationPathSettings.tsx`), which reconfigures
  and resyncs through `reconfigureActiveWallet`

So `m/44'/145'/0'` remains a first-class chipnet path for restoring a seed created by BCH
tooling that uses the mainnet coin type on test nets, and `m/44'/1'/0'` remains a first-class
mainnet path for a seed that came from Bitcoin-origin tooling.

## Mainnet is the special case in code

`getBchCoinType` and `candidateAccountPaths` (`src/services/DerivationPathDiscovery.ts`) both
branch on `Network.MAINNET`, not on chipnet. Keep it that way: if they branch in opposite
directions, a network added later inherits `145` from one and the test-net candidate list from
the other, and the two disagree silently.

## Quantumroot follows the wallet, always

Quantumroot never derives its own coin type. `getQuantumrootComponentPath` and
`deriveQuantumrootVaultArtifacts` build every path from `getBchAccountPath` and thread the
wallet's `accountPath` through to each component, recording it on the artifacts. A wallet on a
custom path gets vaults on that same path. `QuantumrootService.test.ts` asserts this against
`getBchAccountPath` rather than a literal, so a future change to the default cannot make the
two diverge without the test noticing.

## Existing wallets are never re-derived

A wallet created before derivation paths became configurable has its path materialized by the
migration in `src/apis/DatabaseManager/DatabaseService.ts`, using **frozen literals**
(`PRE_CONFIGURABLE_CHIPNET_ACCOUNT_PATH` / `PRE_CONFIGURABLE_MAINNET_ACCOUNT_PATH`), not the
current default. That is deliberate: the migration records the path a wallet was *already*
using. Asking `getBchAccountPath()` instead would rewrite history every time the default moves —
and the chipnet default has now moved twice (`1` → `145` → `1`) — silently re-deriving every
address of any wallet not yet migrated.

Consequences that must hold:

1. Upgrading never deletes or rewrites persisted key, address, or UTXO rows.
2. Encrypted private keys stay spendable regardless of which coin type they were derived under.
3. Chipnet wallets created during the `145` period keep working on `145`.
4. v1.6.2 chipnet wallets keep working on `1`.

## Finding a seed's real path

`discoverDerivationPath` (`src/services/DerivationPathDiscovery.ts`) probes the paths BCH
tooling actually uses and reports which one holds coins:

- mainnet: coin types `[145, 0]` × accounts `[0, 1]`
- chipnet: coin types `[1, 145, 0]` × accounts `[0, 1]`

It selects by highest balance, then by most used addresses — probe order only breaks exact ties.
When more than one path is funded it sets `ambiguous` and **must not** be auto-resolved: silently
picking one hides the other's money. A path with history but no balance is still the right one to
adopt; the wallet was used and spent down, and new addresses must continue from there.

A failed probe records nothing rather than a false zero, so a caller has to distinguish "every
path is empty" from "the servers were unreachable" by comparing `probed.length` against
`candidateAccountPaths(network).length`. Reporting the second as the first is the exact failure
this whole mechanism exists to prevent.

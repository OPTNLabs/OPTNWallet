# SeedCash CashTokens PSBT interoperability

`test-vectors/seedcash-cashtokens.json` contains raw unsigned PSBTs, full parent
transactions, captured signed returns, expected acceptance, and finalized bytes.
These are **unfunded, offline templates using a published BIP39 test mnemonic**.
They are not live UTXOs. Never fund this mnemonic. No transaction was broadcast.

The Rust generator creates 64 cases: 55 valid and 9 consensus-invalid token
transitions. Coverage includes mixed FT/NFT categories, multiple genesis
categories, unused vout-zero inputs, mutable downgrades, NFT minting, authority
splitting/destruction, selective burns, maximum amounts/commitments, interleaved
OP_RETURN, 100-input consolidation, and 100-output distribution. The 55 valid
cases were freshly signed by SeedCash and verified by Rust and libauth's BCH VM.
Seven of the 9 invalid cases carry real signatures too: signatures do not make
an invalid token transition valid. Both token validators reject them. SeedCash
refuses to sign the other two (`reject-wrong-category`,
`reject-genesis-without-vout-zero`), recorded as `seedcash_refused`.

The source workbook's 69 rows are requirements, not 69 completed tests. Related
row IDs describe coverage, not full row completion. P2SH/multisig, CSV/CLTV,
multi-party signing, and hardware display/camera tests are outside this patch.
Rows 38/39 requesting new fungible supply from a minting NFT are invalid under
the [CashTokens specification](https://cashtokens.org/docs/spec/chip/).

## Audit of the supplied JSON

The eight supplied PSBTs are also retained, unchanged, with the attachment's
SHA-256 recorded. Their old row-coverage claims are not copied.

| Cases           | Result with the existing public SeedCash harness                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| M02             | Fresh signing, Rust finalization, independent BCH VM pass                                                                           |
| M01             | Offline structural review passes; the harness adds no signature. Requires matching signer/key-origin investigation.                 |
| M03 through M08 | Refused: an input's committed public key does not match its parent P2PKH output. M03/M07 also return no signature from the harness. |

The generated cases were signed by canonical SeedCash commit
`30c5ba609e97649f50603cfc447644b99c461047`, including its original parser,
which refuses a PSBT version field that is not 4 bytes and a parent output
script it cannot classify. Only the existing hardware import shim was used;
cryptography was not patched. The supplied cases keep the returns captured at
`4e1016637edf12bc478fc01bff354a5e384563ca`. This is software signing evidence,
**not physical-device approval/display proof**.

## Reproduce or give the files to a signer

```text
cargo run --locked --manifest-path crates/optn-core/Cargo.toml --example seedcash_cashtokens -- export PATH_TO_NEW_TEST_DIRECTORY
```

This writes `.psbt` bytes, hex files and `manifest.json`, including token review
inventories and rejection reasons. For the existing SeedCash harness, set
`SEEDCASH_SRC` to the pinned source's `src` directory, then:

```text
python -B scripts/seedcash/sign_psbt.py sign ORIGINAL.hex SIGNED.hex
cargo run --locked --manifest-path crates/optn-core/Cargo.toml --example seedcash_cashtokens -- finalize ORIGINAL.hex SIGNED.hex RAW.hex
```

It uses BIP39 `abandon` eleven times followed by `about`, empty passphrase,
account `m/44'/145'/0'`. This account is explicit despite the Chipnet test scope.

## Shared wallet functionality

- `psbt::encode_unsigned` now includes token prefixes in the actual unsigned
  transaction as well as v145 metadata, rejecting malformed/double prefixes.
- `psbt::review_p2pkh` authenticates supplied parent bytes against outpoints,
  validates token conservation/authority, and exposes FT burns and complete NFT
  input/output inventories. An eligible vout-zero input is not automatically a
  genesis. NFT counts alone do not establish NFT identity or absence of burns.
- `psbt::finalize_cash_tokens_p2pkh` binds every retained map and verifies BCH
  Schnorr/low-S ECDSA using token-aware 0x41 preimages. Returned scripts are built
  locally. Existing `finalize_p2pkh` and ordinary wallet sends still reject tokens.
- Native CLI: `optn --network chipnet --json psbt ORIGINAL.hex`, optionally
  `--signed SIGNED.hex`. Offline, no wallet opening, approval, or broadcast.
- WASM: `psbtReviewP2pkh` and `psbtFinalizeCashTokensP2pkh` call the same Rust.
  FT amounts cross the review JSON boundary as decimal strings.
- `coin_control` labels each coin as BCH, FT, NFT or FT + NFT, named by the
  wallet's verified or last-known BCMR identity (ticker, name, scaled amount)
  and always with its category, since tickers are not unique. Token coins carry
  a BCH-send refusal. WASM: `coinControlLabel`, and `spentOutputLabel`, which
  reads the coin from its complete parent transaction.
- The watch-only send screen shows token coins by these labels and does not let
  them be selected for a BCH send. `buildWatchOnlyPsbt` refuses any input whose
  parent output carries tokens not declared for it: before this, a token coin
  selected there was built into a PSBT whose outputs dropped its tokens.

- Token sends are planned once, in the shared spend path
  (`optn_core::spend::tokens`), for every wallet kind. A `Payment` is BCH, an
  FT amount of one category, every FT of one category, or one NFT exactly as it
  is; `CoinChoice::Exactly` is coin control (those coins or a refusal, never an
  added one). Tokens the send spends but does not send return to the wallet's
  token-aware change address: FT change as one output per category, each NFT on
  its own output, unchanged. BCH for token outputs (1,000 sats each) and the fee
  comes from the spent coins, then from BCH-only coins, never from coins of
  another category. Every plan is checked before it is returned: its outputs
  carry exactly the tokens its inputs do.
- `airgap_spend::prepare_token_psbt` turns a plan into the PSBT SeedCash signs.
  Each input is bound to its complete parent transaction, and a parent that
  disagrees with the plan about a coin's value, script or tokens refuses the
  PSBT; the PSBT is then reviewed with `psbt::review_p2pkh`, and must say exactly
  what the plan says. WASM: `planTokenSpend`, `tokenSpendPsbt`.
- The watch-only (SeedCash) send screen has a "What to send" choice: BCH, a
  fungible category (an amount typed with the token's decimals, or every unit),
  or one NFT. Rust plans the send (`planTokenSpend`), builds the PSBT from the
  complete parents (`tokenSpendPsbt`) and the screen shows Rust's review of
  those bytes per category (in, out, nothing burned). Ticked coins are coin
  control; token coins may be ticked for a token send. SeedCash's signed return
  is verified and assembled by `psbtFinalizeCashTokensP2pkh` against the
  approved bytes, not by the BCH-only TypeScript path. Single-signer P2PKH
  wallets only; multisig wallets keep BCH sends.
- The CLI's `token-send` and `send-nft` plan through the same shared planner
  and sign with `Transaction::sign_spending_tokens`. Before, they selected
  coins inline and signed token inputs as if they carried no tokens, which
  nodes reject, and `token-send` dropped an NFT riding on a fungible coin it
  spent. `send-nft` now returns fungible units on the NFT's coin to the wallet
  instead of sending them along.
- Not yet: the hot wallet's Simple Send on this planner (with the PR #63 Rust
  migration), and evidence of what a physical SeedCash shows for a token PSBT.

These APIs do not prove parent chain inclusion/unspentness or authorize a spend.
The GUI token selection/approval flow is not enabled by this patch. A caller must
show the exact review, obtain approval (including intentional burns/authority
changes), and preserve the original bytes. P2PKH inputs, full parents, Chipnet,
and explicit `SIGHASH_ALL|FORKID` remain the supported finalization scope.

## On the SeedCash emulator (2026-10-16)

SeedCash `main` at `7defc55` (which reworked the token review screens since
`30c5ba6`) with the official emulator (`SeedCashOrg/seedcash-emulator`,
`9d789cd`), driven by `scripts/seedcash/emulator/`. Everything below is
SeedCash's own code; the harness only adds a scriptable camera, buttons and
screen capture:

- The camera is a virtual one that shows OPTN's frames, as a phone held up to
  the device would. The frames are exactly what OPTN displays:
  `encodePsbtToUrFrames` at the default 50-byte fragments, drawn at error level
  L with an 8-module margin. SeedCash's frame handling and zbar decoding run on
  them.
- The signed QR SeedCash shows is recorded frame by frame and read back with
  OPTN's own `UrPsbtScanner`, then finalized and run on the BCH VM by
  `seedcash_cashtokens finalize`.

To run it: copy SeedCash's `src`, overlay the emulator's `seedcash/` folder
on it, then start `python scripts/seedcash/emulator/harness.py <that src>
<lab folder>`. Put each case's QR frames in `<lab>/cam/<case>/` and, with the
wallet menu showing, run `SEEDCASH_LAB=<lab> python
scripts/seedcash/emulator/run_case.py <case>`; `emu.py` sends single
commands (`press DOWN`, `shot name`, `camera <dir>`).

The seed was loaded the way a holder would: Load seed, SeedQR, a Compact
SeedQR of the all-`abandon` phrase scanned by the camera. SeedCash showed
fingerprint `73c5da0a`, the phrase's known master fingerprint.

| Case | What SeedCash showed | Signed | OPTN on return |
| --- | --- | --- | --- |
| `bch-control` | 1,000,000 sats; math 0.010000 in, 0.009990 out, 0.000010 fee; the OP_RETURN as undecodable text | yes | verified, 198 bytes |
| `transfer-None-65536` | "Unknown FT token" warning (no decimals), category `1111…`, 65536 [?] to `zzw2lnr…s80a4vy`; 1,000 and 998,000 sats out, 1,000 fee | yes | verified, 271 bytes |
| `transfer-Some(Mutable)-1` | the fungible amount, then the mutable NFT with its address | yes | verified, 267 bytes |
| `mint-2-nfts` | a minting-NFT warning, then each of the three NFTs and its address | yes | verified, 409 bytes |
| `five-ft-categories` | each of the five categories in turn, then six outputs | yes | verified, 1,107 bytes |
| `burn-ft-50-remaining` | "PSBT Error, Parsing Failed" | no | — |
| `reject-ft-inflation` | the review, as for a transfer | yes | refused: "FT inflation" |

Run against all 64 exported cases, SeedCash's parser differs from OPTN's
review in two ways:

- It refuses every case that burns a token: 8 valid ones ("PSBT burns
  fungible tokens", "PSBT burns non-fungible tokens"), including destroying or
  splitting a minting authority. OPTN's watch-only token send never produces a
  burn (Rust refuses one when it plans the send), so a holder cannot reach
  this from OPTN.
- It parses 6 of the 9 consensus-invalid cases (inflation, NFT duplication or
  mutation, an overflowing genesis supply). It does not enforce CashTokens
  rules; OPTN refuses those signatures on return, as the network would.

On every review the change output appears as "Will Send", like a recipient,
though its derivation is on the change path (`…/1/99`). Token amounts carry
"[?]" because SeedCash knows no token metadata.

Limits: a virtual camera tests decoding of OPTN's frames, not a lens or
lighting. The Windows zbar wheel (0.10) has no binary mode; every QR here is
numeric, alphanumeric or plain-byte, where both modes read the same bytes, and
the harness says so where it adapts the call.

## Checks

```text
cargo test --locked --manifest-path crates/optn-core/Cargo.toml
cargo test --locked --manifest-path crates/optn-cli/Cargo.toml --test psbt
npx vitest run src/services/psbt/__tests__/cashTokensRust.test.ts
```

The Rust test compares regenerated bytes with the checked-in corpus. The WASM
test replays the same cases through independent libauth token validation and
executes every accepted signed transaction in its BCH VM. `Shared Rust
connectors` CI includes that check before and after rebuilding WASM.

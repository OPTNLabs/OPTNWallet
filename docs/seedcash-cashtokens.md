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
The 9 invalid cases carry real signatures too: signatures do not make an invalid
token transition valid. Both token validators reject them.

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

The source used for the final run was exported directly from canonical SeedCash
commit `4e1016637edf12bc478fc01bff354a5e384563ca`, including its original parser.
Only the existing hardware import shim was used; cryptography was not patched.
This is software signing evidence, **not physical-device approval/display proof**.

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

These APIs do not prove parent chain inclusion/unspentness or authorize a spend.
The GUI token selection/approval flow is not enabled by this patch. A caller must
show the exact review, obtain approval (including intentional burns/authority
changes), and preserve the original bytes. P2PKH inputs, full parents, Chipnet,
and explicit `SIGHASH_ALL|FORKID` remain the supported finalization scope.

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

# Issue #8 watch-only wallet implementation contract

This implements the air-gapped flow requested in
[OPTNLabs/OPTNWallet#8](https://github.com/OPTNLabs/OPTNWallet/issues/8) and
described in [SeedCash education](https://seedcash.cash/education). SeedCash is
the offline key holder and signer. OPTN is the online watch-only wallet,
transaction builder, verifier, and broadcaster.

## End-to-end product flow

1. The user creates or restores the mnemonic and optional passphrase only in
   SeedCash on the offline device.
2. SeedCash exports the BCH account xPub as a static, single-frame QR. No
   mnemonic, passphrase, xPriv, or child private key crosses into OPTN.
3. OPTN's wallet picker offers **Create Watch-Only Wallet**, with Standard and
   Multisign choices. The entry is added when its end-to-end flow is functional,
   not as a non-working placeholder.
4. OPTN scans the xPub QR, validates its network and account origin, and restores
   the BIP44 public account tree. For a normal BCH account rooted at
   `m/44'/145'/account'`, it derives receive addresses from `/0/index` and change
   addresses from `/1/index`.
5. OPTN performs gap-limit discovery and provides normal receive, balance,
   history, UTXO, and coin-control behavior without exposing any signing path.
6. Send builds a binary Paytaca-compatible PSBT with global PSBT version `145`.
   Inputs use `ALL | FORKID | ANYONECANPAY` (`0xc1`) as required by Issue #8.
7. The transaction workspace shows the destination, amount, fee, change, inputs,
   decoded PSBT information, and raw unsigned transaction. The same screen has
   **Export**, **Import**, PSBT details, and raw-transaction access.
8. **Export** encodes the binary PSBT in a multipart `ur:crypto-psbt` animated
   QR. The wire payload is PSBT bytes, not JSON; JSON may be shown only as a
   decoded human-readable view.
9. SeedCash scans the animated UR, reviews and signs offline, then returns a
   signed or partially signed PSBT as `ur:crypto-psbt`.
10. **Import** scans and reconstructs the returned UR, binds it to the exact
    approved unsigned transaction, validates its signatures, and merges partial
    signatures where applicable.
11. OPTN presents a final confirmation and broadcasts the completed transaction.
    SeedCash never broadcasts.

## Implementation checkpoints

### 1. Public-only wallet model and xPub import

- Add an explicit watch-only wallet type and schema version.
- Store only xPub, master fingerprint when supplied, network, account origin,
  receive/change branch state, gap-limit cursors, and multisign policy.
- Validate xPub version bytes, network, depth, child number, origin, and account
  scope before accepting it. Require explicit confirmation when origin metadata
  is absent from the static QR.
- Reject mnemonic/private-key fields and software/hardware signing commands for
  this wallet type at database, TypeScript, IPC, and Rust boundaries.
- Include public watch-only metadata in `.optn` backup/restore without
  fabricating or requesting a signing secret.

### 2. Discovery, receive, and coin control

- Derive `/0/index` and `/1/index` public children from the account xPub.
- Reuse the normal network backend and wallet-wide privacy settings.
- Persist scan cursors, enforce the gap limit, and prevent address reuse.
- Display history, balance, UTXOs, frozen coins, fee estimate, destination,
  amount, and change before proposal creation.

### 3. Paytaca PSBTv145 codec

- Implement and parse the standard `psbt` magic container with global PSBT
  version `145`, matching Paytaca's BCH extensions and proprietary fields.
- Serialize the complete unsigned BCH transaction, input UTXO data, derivation
  metadata, outputs, and `0xc1` sighash type.
- Use byte-for-byte Paytaca and SeedCash interoperability fixtures, including
  CashToken fields when present.
- Reject modified outputs, wrong network, missing or inconsistent UTXOs,
  unsupported sighash flags, duplicate keys, malformed maps, and oversized data.

### 4. `ur:crypto-psbt` exchange

- Encode PSBT bytes as `ur:crypto-psbt`; do not put arbitrary JSON into the UR.
- Implement multipart animated export and decoder progress, frame reordering,
  duplicates, loss/recovery, timeout, cancel, camera permission errors, and
  bounded payload allocation.
- Provide QR plus file/base64 fallback for both unsigned export and signed
  import.
- Match a returned partial PSBT by unsigned-transaction hash before merging it.

### 5. Transaction workspace, validation, and broadcast

- Keep **Export**, **Import**, decoded PSBT information, and raw transaction on
  the same proposal screen as required by Issue #8.
- Compare the imported unsigned transaction, inputs, outputs, amounts, change,
  locktime, sequences, UTXO commitments, and sighash flags with the approved
  proposal.
- Validate signatures locally and distinguish unsigned, partially signed,
  complete, invalid, rejected, expired, and already-broadcast states.
- Broadcast only a complete, locally verified transaction after final user
  confirmation, and report success only with the network txid.

### 6. Multisign

- Match Paytaca's participant policy, script ordering, and PSBT merge behavior.
- Track cosigner fingerprints and partial signatures without private material.
- Support repeated export/import cycles until threshold completion while
  rejecting any conflicting unsigned transaction.

## Release evidence

- Standard mainnet and chipnet xPub discovery fixtures reproduce the same
  receive/change addresses as SeedCash.
- Unsigned and signed PSBTv145 fixtures round-trip between OPTN, Paytaca, and
  SeedCash through `ur:crypto-psbt`.
- Multisign fixtures merge successfully in different signer orders.
- Animated UR decoding survives reordered, duplicated, and recoverably missing
  frames while malformed or oversized streams fail closed.
- Tampered destination, amount, fee, change, sighash, network, UTXO, or unsigned
  transaction data cannot reach broadcast.
- A watch-only wallet cannot invoke or persist any mnemonic/private-key signing
  path.

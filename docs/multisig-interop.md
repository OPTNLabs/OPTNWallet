# Multisig interop: checked against Electron Cash

A multisig wallet only this wallet can open is a worse multisig wallet. This
records what has actually been checked against another implementation, what
that proves, and what it does not.

Everything here is public material — compressed public keys, a redeem script,
and addresses. No seed, key or wallet file was created, read or funded, and
nothing was broadcast.

## The result

**Three independent implementations produce the same redeem script and the same
address, byte for byte.**

| Implementation | Source |
| --- | --- |
| `optn_core::multisig` | this branch |
| `optn-multisig-core` | PR #65, its published `VECTOR_1` |
| Electron Cash 4.4.5 | `createmultisig`, run locally on chipnet |

## The vector

Two compressed public keys, from PR #65's `VECTOR_1`. They are test-vector
material and control nothing.

```
KEY_A = 02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8
KEY_B = 02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f
```

BIP-67 sorts them lexicographically, so `KEY_B` (`02fe…`) precedes `KEY_A`
(`02ff…`) in the script regardless of the order they were entered.

**2-of-2 redeem script**

```
522102fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f
2102ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f852ae
```

**Address (chipnet)**

```
CashAddr  bchtest:ppttar4f8yf0xa592s4z4pj22cq03zn82syer0akm8
legacy    2N19tNw3Ss4L9QDERtCw7FhXb6jBsYmeXNu
```

## Reproducing it

Electron Cash 4.4.5 from source, run offline. `createmultisig` needs no network
and no wallet.

```sh
python electron-cash --chipnet createmultisig 2 \
  '["02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f",
    "02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8"]'
```

```json
{
    "address": "2N19tNw3Ss4L9QDERtCw7FhXb6jBsYmeXNu",
    "redeemScript": "522102fe6f0a...52ae"
}
```

It returns a legacy address, so convert it:

```sh
python electron-cash --chipnet addressconvert 2N19tNw3Ss4L9QDERtCw7FhXb6jBsYmeXNu
```

```json
{
    "cashaddr": "bchtest:ppttar4f8yf0xa592s4z4pj22cq03zn82syer0akm8",
    "legacy": "2N19tNw3Ss4L9QDERtCw7FhXb6jBsYmeXNu"
}
```

## Electron Cash does not sort, and that is the useful part

`createmultisig` builds the script in the order it is given.
`electroncash/transaction.py`:

```python
def multisig_script(public_keys, m):
    keylist = [push_script(k) for k in public_keys]
    return op_m + ''.join(keylist) + op_n + OP_CHECKMULTISIG
```

Handing it the same two keys reversed produces a **different address**:

| Key order | Address |
| --- | --- |
| `02fe…`, `02ff…` (BIP-67 order) | `2N19tNw3Ss4L9QDERtCw7FhXb6jBsYmeXNu` |
| `02ff…`, `02fe…` (as entered) | `2NAuwhxNprDtAvaJiSTow1pC88fKnFTHseR` |

That is BIP-67's whole reason to exist, demonstrated rather than asserted: the
same cosigners in a different order are a different wallet unless something
sorts. It also isolates the comparison usefully — Electron Cash agreeing with
us on the *script construction* (push encoding, `OP_m`/`OP_n`,
`OP_CHECKMULTISIG`, hash160, P2SH) is checked separately from our sorting being
right, rather than the two being tested together and covering for each other.

## What this proves, and what it does not

**Proved.** Given the same public keys in the same order, our redeem script and
address are byte-identical to Electron Cash's. Anyone who can open a wallet in
Electron Cash sees the same addresses we do.

**Not proved.** Two things, both worth being honest about:

- **Descriptors are unanchored.** Electron Cash has no descriptor support —
  descriptors are a Bitcoin Core / Bitcoin ABC feature — so
  `optn_core::multisig::parse_descriptor` is still only checked against our own
  export. In `optn_core::conformance` terms that is `AgreeButUnanchored`:
  consistency, not correctness. Anchoring it needs a descriptor from Sparrow,
  Specter or `bitcoin-abc`.
- **Nothing was signed or spent.** This is address derivation only. That two
  wallets agree on where the money goes does not establish that a transaction
  signed here is accepted there.

## One difference worth knowing

Electron Cash caps a multisig at 15 keys:

```python
n = len(public_keys)
assert n <= 15
```

`optn_core::multisig::MAX_COSIGNERS` is 16, which is what the script can encode
— `OP_16` exists. So a 16-key wallet built here is valid on chain and cannot be
opened in Electron Cash. Nothing is wrong with either, but a 16-of-16 is a
wallet with fewer places to open it than the maker probably expects.

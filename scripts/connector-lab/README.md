# OPTN Connector Lab

This is a development-only requester for comparing the real WalletConnect,
WizardConnect, and CashConnect review surfaces in OPTN Wallet.

It is intentionally outside the production bundle. The default mode never
requests broadcast and does not print wallet secrets.

## Run

From the repository root:

```sh
node scripts/connector-lab/index.mjs
```

The lab starts a local status page at `http://127.0.0.1:8787` and accepts
terminal commands:

```text
preflight Query the derived Chipnet receive address without spending
wc       WalletConnect pairing and sign request
wizard   WizardConnect pairing and sign request
cash     CashConnect pairing and template action request
quit     Stop the lab
```

The status page exposes `/health`, including the current connector phase, the
normalized review summary, and the raw protocol request/response. The summary
is intentionally connector-neutral: it reports network, operation, input/output
values, and fee before any connector-specific technical details.

`preflight` performs a live Chipnet Electrum `blockchain.scripthash.listunspent`
lookup and reports the UTXO count and total without allocating funds to a
connector or enabling broadcast. It also fetches and decodes each parent
transaction so CashToken category, amount, and NFT capability/commitment are
known before any future batch allocator can select an input.

When at least three BCH-only UTXOs meet the lab minimum, preflight identifies
one disjoint candidate batch for each connector. Token-bearing UTXOs remain
excluded until a token-preserving output plan is supplied. Candidate selection
does not enable signing or broadcast.

The requester is Chipnet-only. WalletConnect requires `VITE_WC_PROJECT_ID` in
the environment or an ignored `.env` file. Public relay services are used for
protocol compatibility; only disposable public-looking request data is sent.
The destination is derived locally as Chipnet `m/44'/1'/0'/0/0` from
`OPTN_E2E_MNEMONIC`; the mnemonic is read but never logged or transmitted.

## What this compares

The same disposable BCH request is sent through each protocol so the wallet
review surfaces can be compared side by side:

| Connector | Request shape | Expected wallet-side review emphasis |
| --- | --- | --- |
| WalletConnect | `bch_signTransaction` with transaction, source outputs, prompt, and `broadcast: false` | destination/value, fee, wallet effect, then sign-and-return |
| WizardConnect | `sign_transaction_request` with encoded transaction, source outputs, input paths, prompt, and `broadcast: false` | the same spend summary, with protocol details reachable separately |
| CashConnect | named template action with a fixed BCH output and wallet-generated change | action intent and reported balance changes; raw prepared transaction details are not independently supplied by the requester |

The lab deliberately exposes these protocol differences instead of normalizing
them in the requester. That makes it possible to identify where OPTN Wallet's
summary components need a common user-facing interpretation while retaining a
technical disclosure for connector-specific data.

CashConnect alpha.31 generates the prepared action before its final approval
callback. The `cash` command uses a BCH-only template action, pairs with the
wallet, and requests the action through the real Nostr protocol. Its
request-reported balance-change sheet must not be treated as an independently
verified raw transaction preview.

No live broadcast path is enabled by this initial harness. A live approval phase
must first add explicit Chipnet UTXO preflight, mnemonic-derived destination
verification, token-preserving transaction validation, disjoint funding batches,
and mempool/confirmation reconciliation. It must also keep WalletConnect's
wallet-owned broadcast behavior separate from WizardConnect/CashConnect's
requester-side submission behavior.

The safety module already rejects non-Chipnet requests, synthetic lab outpoints,
broadcast without live preflight, and overlapping connector funding batches.
Token-bearing inputs also receive a preservation-only plan that keeps category,
amount, NFT capability, and commitment unchanged while reserving the fee from
BCH value. This is a validation artifact, not a signed transaction.

# OPTN Wallet add-on SDK

This directory contains the private, dependency-free client contract for
third-party OPTN Wallet integrations. It is intentionally marked `private` in
`package.json`; it must not be published or treated as a stable npm API yet.

For runnable examples, see [`examples/README.md`](./examples/README.md). The
in-wallet example is registered as **OPTN Builtin Demo → Add-on SDK Demo** so
it can be opened from the wallet's Apps screen and exercised against the live
wallet facade.

The client talks to a host-provided transport. The transport may be an iframe
adapter, a desktop/native connector, or a future external wallet protocol. The
package itself has no wallet/provider access and contains no signing or key
material APIs.

`defineAddon` performs local manifest validation for schema shape, public
capabilities, trust tier, and HTTP host syntax. The wallet still performs the
authoritative publisher, allowlist, consent, and runtime policy checks.

For a normal browser connector, use the host-issued `sessionId` and an explicit wallet origin. The temporary
opaque-origin iframe can opt into `allowOpaqueOrigin: true` with
`targetOrigin: '*'`; that option must not be used for ordinary cross-origin
integrations. The host still authenticates the peer window and applies the
capability policy before dispatching requests.

An external connector should establish a session before creating the wallet
client:

```ts
import {
  connectAddonPostMessage,
  createAddonWalletClient,
} from '@optnlabs/optn-wallet-addon-sdk';

const connection = await connectAddonPostMessage({
  target: walletWindow,
  targetOrigin: 'https://wallet.example',
  addonId: 'example.addon',
  requestedCapabilities: ['wallet:context:read', 'tx:propose'],
});
const wallet = createAddonWalletClient(connection.transport);
if (connection.hasCapability('tx:propose')) {
  // The wallet granted this capability; transaction proposals are still
  // reviewed and authorized by the wallet before execution.
}
```

The wallet may reject any request, grant fewer capabilities, expire the
session, or revoke it when the user disconnects or locks the wallet. Dispose
the transport when the integration is torn down; pending requests are then
rejected immediately.

Pass an `AbortSignal` as `signal` when the connection request belongs to a
short-lived UI flow. Aborting removes the pending listener and rejects with an
`AbortError` without waiting for the connection timeout.

The public transaction surface is proposal-based:

1. Create an immutable proposal.
2. Ask the wallet to review and execute it.
3. Poll the owned operation until the wallet reports its current submission
state.

Proposal inputs use public chain fields only. Internal wallet fields such as
unlockers, private keys, `txid`, `vout`, and `valueSats` are not part of this
package contract:

```ts
const proposal = await wallet.tx.propose({
  inputs: [
    {
      address: 'bitcoincash:qqexample',
      tx_hash: '11'.repeat(32),
      tx_pos: 0,
      value: 2000,
      height: 0,
    },
  ],
  outputs: [
    { recipientAddress: 'bitcoincash:qqrecipient', amount: 1000 },
  ],
});

const operation = await wallet.tx.requestExecution({
  proposalId: proposal.proposalId,
  idempotencyKey: 'checkout:order-123',
});
// Handle `submission_unknown` by polling; do not treat it as confirmation.
```

An operation may include a transaction ID after the wallet receives one. The
ID is a public correlation value only; `submission_unknown` remains possible
until the wallet reconciles provider and chain visibility, and add-ons cannot
declare a transaction confirmed themselves.

For convenience, integrations can wait for a terminal wallet decision without
implementing their own polling loop:

```ts
const operation = await wallet.tx.waitForOperation(operationId, {
  pollIntervalMs: 1000,
  timeoutMs: 120_000,
  signal: abortController.signal,
});
// operation.status is `confirmed` or `rejected`.
```

The helper never treats `mempool` or `submission_unknown` as final. A timeout
or abort is reported to the caller and does not change wallet state.

CashToken intent types cover transfer, fungible mint, NFT mint, NFT mutation,
and explicit burn. `wallet.meta.getInfo()` reports the CashToken wire limits
used by the host. Generic CashScript artifacts use the documented CashScript
artifact ABI shape; no contract registry is required. The add-on supplies
public artifact and intent data, while the wallet owns contract construction,
signer resolution, fee/change calculation, review, and broadcast. Private keys,
unlockers, and `SignatureTemplate` instances never cross this boundary.

The contract surface is:

- `contracts.instantiate()` — validate constructor arguments and derive the
  contract view.
- `contracts.deriveAddress()` and `contracts.deriveLockingBytecode()` — pure
  public derivation through the wallet host.
- `contracts.propose()` — submit a typed ABI function call with explicit
  `contractInputIndexes` and optional wallet signer bindings.

Contract proposals support mixed contract and P2PKH inputs. The wallet checks
input state, resolves wallet-owned signatures internally, preserves CashToken
state, calculates BCH/token change, and submits through its normal transaction
tracking path. Contract execution is wallet-submit only; signed transaction
export and arbitrary unlocker injection are not public capabilities.

The client rejects empty or oversized idempotency keys locally; the wallet
revalidates them before persistence. Keys are limited to 256 characters.
Proposal and operation identifiers are also limited to 256 characters. Client
request parameters are bounded to 64 KiB after serialization; CashToken
`bigint` values are measured as decimal strings, and circular or otherwise
non-serializable parameters are rejected before transport dispatch. Polling
interval and timeout controls must be finite positive numbers.

Minimal public manifest shape:

```ts
import { defineAddon } from '@optnlabs/optn-wallet-addon-sdk';

export default defineAddon({
  manifest: {
    id: 'example.addon',
    name: 'Example Add-on',
    version: '1.0.0',
    permissions: [
      {
        kind: 'capabilities',
        capabilities: ['wallet:context:read'],
      },
    ],
    contracts: [],
  },
  mount: ({ sdk }) => {
    void sdk.wallet.getContext();
    return {};
  },
});
```

Message signing is address-scoped and user-approved. Messages must contain
between 1 and 8,192 characters; the signer returns only the signature and
public verification metadata. Private keys and signature templates never enter
the add-on process.

Before publication, the host wire protocol, error schema, platform adapters,
scope/revocation behavior, and release evidence must be frozen and reviewed.

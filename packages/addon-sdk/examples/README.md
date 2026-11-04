# OPTN Wallet add-on SDK examples

These examples use only the public add-on SDK. An add-on receives a restricted
client and public wallet projections; the wallet keeps seed phrases, private
keys, unlockers, transaction construction, signing, and broadcast inside the
wallet process.

The examples assume the SDK package is available as
`@optnlabs/optn-wallet-addon-sdk`. While the package is still private, run the
same code from the repository package or the checked-in mock host.

## 1. A read-only portfolio panel

Request only the capabilities needed to display the current wallet. The wallet
may grant fewer capabilities than requested, so the UI should handle a denied
request explicitly.

```ts
import {
  connectAddonPostMessage,
  createAddonWalletClient,
} from '@optnlabs/optn-wallet-addon-sdk';

const connection = await connectAddonPostMessage({
  target: window.opener!,
  targetOrigin: 'https://portfolio.example',
  addonId: 'com.example.portfolio',
  requestedCapabilities: [
    'wallet:context:read',
    'wallet:addresses:read',
    'utxo:wallet:read',
  ],
});

const sdk = createAddonWalletClient(connection.transport);
const context = await sdk.wallet.getContext();
const addresses = await sdk.wallet.listAddresses();
const { allUtxos, tokenUtxos } = await sdk.utxos.listForWallet();

renderPortfolio({
  network: context.network,
  addresses,
  nativeUtxos: allUtxos,
  tokenUtxos,
});

// Disconnect when the add-on is unloaded or the window is closed.
connection.dispose();
```

`AddonAddress` and `AddonUtxo` deliberately omit wallet database records,
mnemonics, private keys, unlockers, and other signing material.

## 2. A BCH checkout with wallet-owned execution

The add-on proposes public inputs and outputs. It never builds a signing
template and never receives a private key. The wallet shows the user the final
review, applies its own coin selection and fee rules, signs internally, and
submits the transaction according to its policy.

```ts
const buyerAddress = await sdk.wallet.getPrimaryAddress();
if (!buyerAddress) throw new Error('The wallet has no receive address');

const { allUtxos } = await sdk.utxos.listForWallet();
const proposal = await sdk.tx.propose({
  inputs: allUtxos,
  outputs: [
    { recipientAddress: merchantAddress, amount: 25_000 },
  ],
  expiresInMs: 5 * 60_000,
  idempotencyKey: `checkout:${orderId}`,
});

const approved = await sdk.ui.confirmSensitiveAction({
  title: 'Pay merchant',
  description: 'Review the amount and destination in OPTN Wallet.',
  risk: 'high',
});
if (!approved) throw new Error('User rejected payment');

const operation = await sdk.tx.requestExecution({
  proposalId: proposal.proposalId,
  mode: 'wallet-submit',
  idempotencyKey: `checkout:${orderId}`,
});

const finalOperation = await sdk.tx.waitForOperation(operation.operationId, {
  timeoutMs: 120_000,
  pollIntervalMs: 1_000,
});

if (finalOperation.status !== 'confirmed') {
  // `mempool` and `submission_unknown` are intentionally not confirmation.
  throw new Error(`Payment ended as ${finalOperation.status}`);
}
```

Use the same idempotency key when retrying a request. Do not create a second
proposal merely because the first operation is temporarily
`submission_unknown`.

## 3. CashToken transfer

CashToken transfers use the same proposal and execution boundary. The token
category, amount, NFT capability, and commitment are public intent data; the
wallet verifies conservation and the resulting transaction before signing.

```ts
const { tokenUtxos } = await sdk.utxos.listForWallet();
const tokenInput = tokenUtxos.find(
  (utxo) => utxo.token?.category === category
);
if (!tokenInput?.token) throw new Error('Token is not available');

const proposal = await sdk.tx.propose({
  inputs: [tokenInput],
  outputs: [
    {
      recipientAddress: recipient,
      amount: 546,
      token: {
        category,
        amount: tokenInput.token.amount,
        ...(tokenInput.token.nft ? { nft: tokenInput.token.nft } : {}),
      },
    },
  ],
  tokenIntent: { kind: 'transfer' },
  idempotencyKey: `token-transfer:${transferId}`,
});

const operation = await sdk.tx.requestExecution({
  proposalId: proposal.proposalId,
  idempotencyKey: `token-transfer:${transferId}`,
});
```

For intentional state transitions, use the matching intent:

```ts
// Fungible mint, NFT mint, NFT mutation, and burn are explicit operations.
const mintIntent = {
  kind: 'mint-fungible' as const,
  category,
  amount: '1000',
};
```

The wallet still decides whether the connected wallet has the authority and
whether the proposed inputs and outputs satisfy CashToken rules. An add-on
cannot use an intent to grant itself minting or mutable authority.

## 4. Token metadata and chain reads

Metadata and chain queries are read-only capabilities and should be treated as
advisory until the wallet or the chain provider confirms a transaction.

```ts
const state = await sdk.bcmr.getTokenMetadataState(category);
const holders = await sdk.tokenIndex.listTokenHolders({
  category,
  limit: 25,
});
const tip = await sdk.chain.getLatestBlock();
```

Do not infer confirmation from a metadata response, token-index result, or a
transaction ID alone.

## 5. Generic CashScript contract call

The add-on can provide a standard CashScript artifact and ABI-shaped values.
The wallet constructs the contract and resolves wallet-owned signatures. The
add-on never receives a private key, unlocker, or `SignatureTemplate`.

```ts
const artifact = await loadBundledCashScriptArtifact();
const contract = await sdk.contracts.instantiate({
  artifact,
  constructorArgs: [{ type: 'bytes', value: '01' }],
  contractType: 'p2sh32',
});

const { allUtxos } = await sdk.utxos.listForWallet();
const contractInputs = allUtxos.filter((utxo) =>
  utxo.address === contract.address || utxo.tokenAddress === contract.tokenAddress
);
if (contractInputs.length === 0) throw new Error('No contract UTXO available');

const proposal = await sdk.contracts.propose({
  contract,
  artifact,
  constructorArgs: [{ type: 'bytes', value: '01' }],
  function: {
    name: 'spend',
    args: [{
      type: 'sig',
      signer: { address: await sdk.wallet.getPrimaryAddress(), purpose: 'wallet-spend' },
    }],
  },
  inputs: contractInputs,
  contractInputIndexes: contractInputs.map((_, index) => index),
  outputs: [{ recipientAddress: recipient, amount: 546 }],
  idempotencyKey: `contract:${operationId}`,
});

const operation = await sdk.tx.requestExecution({
  proposalId: proposal.proposalId,
  mode: 'wallet-submit',
  idempotencyKey: `contract:${operationId}`,
});
```

The wallet rechecks the contract identity, input state, ABI function, signer
bindings, token conservation, fees, and change before asking for approval.

## 6. User-approved message signing

Message signing is address-scoped. The wallet presents the message to the user
and returns signature material only; the add-on never receives the signing key.

```ts
const address = await sdk.wallet.getPrimaryAddress();
if (!address) throw new Error('No signing address available');

const signed = await sdk.signing.signMessage({
  address,
  message: `Log in to Example App\nNonce: ${nonce}`,
});

sendToServer({
  address: signed.address,
  signature: signed.signature,
  encoding: signed.encoding,
});
```

The server must verify the signature and nonce. A signature is not proof that a
transaction was approved or broadcast.

## 7. A complete add-on entrypoint

`defineAddon` validates the manifest locally. The wallet remains authoritative
for publisher approval, capability grants, user consent, rate limits, and
revocation.

```ts
import { defineAddon } from '@optnlabs/optn-wallet-addon-sdk';

export default defineAddon({
  manifest: {
    id: 'com.example.portfolio',
    name: 'Example Portfolio',
    version: '1.0.0',
    permissions: [
      {
        kind: 'capabilities',
        capabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'utxo:wallet:read',
        ],
      },
    ],
    contracts: [],
  },
  mount: async ({ sdk, host }) => {
    const context = await sdk.wallet.getContext();
    const info = await sdk.meta.getInfo();
    renderApp({ network: context.network, sdkVersion: info.version });

    return {
      dispose() {
        unmountApp();
      },
    };
  },
});
```

## What an add-on must not do

- Import `KeyService`, Redux state, wallet database code, or transaction
  internals from the host application.
- Ask for or store a mnemonic, private key, seed, unlocker, or raw signature
  template.
- Treat an operation ID or mempool state as confirmation.
- Retry execution with a new idempotency key after a timeout.
- Declare CashScript contracts in a public manifest while the reviewed registry
  and provenance policy are not available.
- Use `targetOrigin: '*'` except for the explicitly supported temporary opaque
  origin integration.

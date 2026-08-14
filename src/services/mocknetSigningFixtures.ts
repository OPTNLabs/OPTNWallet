import MockNetworkProvider from 'cashscript/dist/network/MockNetworkProvider.js';
import {
  binToHex,
  hexToBin,
  lockingBytecodeToCashAddress,
  privateKeyToP2pkhLockingBytecode,
} from '@bitauth/libauth';
import {
  createTransactionFingerprint,
  type PartiallySignedTransaction,
} from './partiallySignedTransaction';

const MOCKNET_PRIVATE_KEY = hexToBin(
  '1111111111111111111111111111111111111111111111111111111111111111'
);

export async function createMocknetSigningRequest(): Promise<PartiallySignedTransaction> {
  const provider = new MockNetworkProvider();
  const lockingBytecode = privateKeyToP2pkhLockingBytecode({
    privateKey: MOCKNET_PRIVATE_KEY,
    throwErrors: true,
  });
  const addressResult = lockingBytecodeToCashAddress({
    prefix: 'bchtest',
    bytecode: lockingBytecode,
  });
  if (typeof addressResult === 'string') throw new Error(addressResult);
  const address = addressResult.address;

  provider.addUtxo(address, {
    txid: '11'.repeat(32),
    vout: 0,
    satoshis: 10_000n,
  });
  const utxos = await provider.getUtxos(address);
  const source = utxos[0];
  if (!source) throw new Error('Mocknet fixture did not produce a UTXO');

  const unsignedTransaction = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin(source.txid),
        outpointIndex: source.vout,
        sequenceNumber: 0,
        unlockingBytecode: new Uint8Array(),
      },
    ],
    outputs: [
      {
        valueSatoshis: 8_900n,
        lockingBytecode,
      },
    ],
  };
  const sourceOutputs = [
    {
      valueSatoshis: source.satoshis,
      lockingBytecode,
    },
  ];
  const inputs = [
    {
      index: 0,
      signerRole: 'wallet' as const,
      status: 'unsigned' as const,
      derivationPath: "m/44'/145'/0'/0/0",
      partialSignatures: [],
    },
  ];
  const base = {
    version: 1 as const,
    network: 'mocknet' as const,
    unsignedTransaction,
    sourceOutputs,
    inputs,
    application: {
      applicationId: 'qr-signing-demo',
      metadata: {
        broadcast: false,
        provider: 'CashScript MockNetworkProvider',
        fixtureOutpoint: `${binToHex(hexToBin(source.txid))}:${source.vout}`,
      },
    },
  };

  return {
    ...base,
    metadata: {
      requestId: 'mocknet-qr-signing-request',
      purpose: 'Approve a mocknet BCH transaction',
      createdAt: 1_700_000_000_000,
      transactionFingerprint: createTransactionFingerprint(base),
    },
  };
}

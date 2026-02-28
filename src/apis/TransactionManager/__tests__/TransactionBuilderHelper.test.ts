import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOKEN_OUTPUT_SATS } from '../../../utils/constants';
import TransactionBuilderHelper from '../TransactionBuilderHelper';
import KeyService from '../../../services/KeyService';

const mockGetContractInstanceByAddress = vi.fn();
const mockGetContractUnlockFunction = vi.fn();

let providerSendRawResponse: unknown = 'txid-ok';
const txBuilderInstances: Array<{
  addInputs: ReturnType<typeof vi.fn>;
  addOutputs: ReturnType<typeof vi.fn>;
  setLocktime: ReturnType<typeof vi.fn>;
  build: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('cashscript', () => {
  class MockElectrumNetworkProvider {
    network: string;
    constructor(network: string) {
      this.network = network;
    }
    getBlockHeight = vi.fn(async () => 777);
    sendRawTransaction = vi.fn(async () => providerSendRawResponse);
  }

  class MockTransactionBuilder {
    addInputs = vi.fn();
    addOutputs = vi.fn();
    setLocktime = vi.fn();
    build = vi.fn(async () => 'deadbeef');
    constructor() {
      txBuilderInstances.push(this);
    }
  }

  class MockSignatureTemplate {
    key: unknown;
    hashType: unknown;
    constructor(key: unknown, hashType: unknown) {
      this.key = key;
      this.hashType = hashType;
    }
    unlockP2PKH() {
      return { kind: 'p2pkh', key: this.key };
    }
  }

  return {
    ElectrumNetworkProvider: MockElectrumNetworkProvider,
    TransactionBuilder: MockTransactionBuilder,
    SignatureTemplate: MockSignatureTemplate,
    HashType: { SIGHASH_ALL: 'ALL' },
  };
});

vi.mock('../../ContractManager/ContractManager', () => ({
  default: vi.fn(() => ({
    getContractInstanceByAddress: mockGetContractInstanceByAddress,
    getContractUnlockFunction: mockGetContractUnlockFunction,
  })),
}));

vi.mock('../../../redux/store', () => ({
  store: {
    getState: vi.fn(() => ({ network: { currentNetwork: 'mainnet' } })),
  },
}));

vi.mock('../../../services/KeyService', () => ({
  default: {
    fetchAddressPrivateKey: vi.fn(),
  },
}));

vi.mock('../../../services/PaperWalletSecretStore', () => ({
  PaperWalletSecretStore: {
    get: vi.fn(),
  },
}));

describe('TransactionBuilderHelper', () => {
  const mockedKeyService = vi.mocked(KeyService);

  beforeEach(() => {
    vi.clearAllMocks();
    txBuilderInstances.length = 0;
    providerSendRawResponse = 'txid-ok';
  });

  it('buildTransaction prepares token outputs and uses p2pkh unlocker for regular utxos', async () => {
    mockedKeyService.fetchAddressPrivateKey.mockResolvedValue(
      Uint8Array.from([1, 2, 3])
    );

    const helper = TransactionBuilderHelper();
    const tx = await helper.buildTransaction(
      [
        {
          address: 'bitcoincash:qsource',
          height: 0,
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 1000,
          token: { category: 'cat', amount: '5' as unknown as number },
        },
      ],
      [
        {
          recipientAddress: 'bitcoincash:qdest',
          amount: 1,
          token: { category: 'cat', amount: '3' as unknown as number },
        },
      ]
    );

    expect(tx).toBe('deadbeef');

    const builder = txBuilderInstances[0];
    expect(builder.addInputs).toHaveBeenCalledTimes(1);
    expect(builder.addOutputs).toHaveBeenCalledTimes(1);

    const addedInput = builder.addInputs.mock.calls[0][0][0];
    expect(addedInput.txid).toBe('a'.repeat(64));
    expect(addedInput.vout).toBe(0);
    expect(addedInput.satoshis).toBe(1000n);
    expect(addedInput.token).toEqual({ category: 'cat', amount: 5n });

    const addedOutput = builder.addOutputs.mock.calls[0][0][0];
    expect(addedOutput).toEqual({
      to: 'bitcoincash:qdest',
      amount: BigInt(TOKEN_OUTPUT_SATS),
      token: { category: 'cat', amount: 3n },
    });
  });

  it('buildTransaction sets locktime for contract functions that use time keywords', async () => {
    mockGetContractInstanceByAddress.mockResolvedValue({
      artifact: {
        source: 'function unlockWithTime() { return tx.time > 0; }',
      },
    });
    mockGetContractUnlockFunction.mockResolvedValue({ unlocker: 'contract-unlocker' });

    const helper = TransactionBuilderHelper();
    await helper.buildTransaction(
      [
        {
          address: 'bitcoincash:qcontract',
          height: 0,
          tx_hash: 'b'.repeat(64),
          tx_pos: 1,
          value: 1200,
          contractName: 'Demo',
          abi: [],
          contractFunction: 'unlockWithTime',
          contractFunctionInputs: {},
        },
      ],
      [{ recipientAddress: 'bitcoincash:qdest', amount: 546 }]
    );

    const builder = txBuilderInstances[0];
    expect(builder.setLocktime).toHaveBeenCalledWith(777);

    const addedInput = builder.addInputs.mock.calls[0][0][0];
    expect(addedInput.unlocker).toBe('contract-unlocker');
  });

  it('buildTransaction throws for invalid AuthGuard input shape', async () => {
    const helper = TransactionBuilderHelper();

    await expect(
      helper.buildTransaction(
        [
          {
            address: 'bitcoincash:qauth',
            height: 0,
            tx_hash: 'c'.repeat(64),
            tx_pos: 0,
            value: 1000,
            contractName: 'AuthGuard',
            contractFunction: 'unlockWithNft',
          },
        ],
        [{ recipientAddress: 'bitcoincash:qdest', amount: 546 }]
      )
    ).rejects.toThrow('AuthGuard spend requires at least 2 inputs');
  });

  it('sendTransaction returns txid string and throws for invalid txid response', async () => {
    const helper = TransactionBuilderHelper();

    await expect(helper.sendTransaction('rawtx')).resolves.toBe('txid-ok');

    providerSendRawResponse = 42;
    const helper2 = TransactionBuilderHelper();
    await expect(helper2.sendTransaction('rawtx')).rejects.toThrow(
      'Broadcast returned invalid txid: 42'
    );
  });
});

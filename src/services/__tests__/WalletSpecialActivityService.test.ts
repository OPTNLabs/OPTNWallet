import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../state/slices/networkSlice';

const {
  deriveRpaKeysMock,
  deriveAndEncodePaycodeMock,
  computeSharedSecretMock,
  derivePaymentAddressMock,
  fetchCauldronDerivedWalletAddressesMock,
  fetchNormalizedCauldronUserPoolsMock,
  detectCauldronWalletPoolPositionsMock,
} = vi.hoisted(() => ({
  deriveRpaKeysMock: vi.fn(async () => ({
    scanPrivkey: new Uint8Array([1]),
    scanPubkey: new Uint8Array([2]),
    spendPrivkey: new Uint8Array([3]),
    spendPubkey: new Uint8Array([4]),
  })),
  deriveAndEncodePaycodeMock: vi.fn(async () => 'paycodetest:qexample'),
  computeSharedSecretMock: vi.fn(() => new Uint8Array([5])),
  derivePaymentAddressMock: vi.fn(() => 'bchtest:qexpected'),
  fetchCauldronDerivedWalletAddressesMock: vi.fn(async () => [
    { address: 'bchtest:qreceive', tokenAddress: 'bchtest:zreceive' },
    { address: 'bchtest:qdefi', tokenAddress: 'bchtest:zdefi' },
  ]),
  fetchNormalizedCauldronUserPoolsMock: vi.fn(async () => []),
  detectCauldronWalletPoolPositionsMock: vi.fn(() => []),
}));

vi.mock('../RpaService', () => ({
  deriveRpaKeys: deriveRpaKeysMock,
  deriveAndEncodePaycode: deriveAndEncodePaycodeMock,
  computeSharedSecret: computeSharedSecretMock,
  derivePaymentAddress: derivePaymentAddressMock,
  RPA_PREFIX_BITS: 8,
}));

vi.mock('../cauldron/planner', () => ({
  fetchCauldronDerivedWalletAddresses: fetchCauldronDerivedWalletAddressesMock,
  fetchNormalizedCauldronUserPools: fetchNormalizedCauldronUserPoolsMock,
  detectCauldronWalletPoolPositions: detectCauldronWalletPoolPositionsMock,
}));

vi.mock('../../state/store', () => ({
  store: {
    getState: vi.fn(() => ({ experimental: { rpaEnabled: true } })),
    dispatch: vi.fn(),
  },
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(() => ({
    ensureDatabaseStarted: vi.fn(async () => {}),
    getDatabase: vi.fn(() => null),
    scheduleDatabaseSave: vi.fn(),
  })),
}));

vi.mock('../../apis/WalletManager/WalletManager', () => ({
  default: vi.fn(() => ({
    getWalletInfo: vi.fn(async () => ({
      mnemonic: 'test mnemonic',
      passphrase: '',
      networkType: Network.CHIPNET,
      derivation_path: "m/44'/1'/0'",
    })),
  })),
}));

import {
  scanCauldronActivity,
  scanRpaActivity,
} from '../WalletSpecialActivityService';

describe('WalletSpecialActivityService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies RPA candidates and counts only currently unspent outputs', async () => {
    const adapter = {
      request: vi.fn(async (method: string) => {
        if (method === 'rpa.getaddresshistory') return [{ tx_hash: 'tx1' }];
        if (method === 'blockchain.transaction.get') {
          return {
            inputs: [
              {
                prevout_hash: 'prevtx',
                prevout_n: 0,
                pubkeys: [`02${'11'.repeat(32)}`],
              },
            ],
            outputs: [{ address: 'bchtest:qexpected', value: 1500 }],
          };
        }
        if (method === 'blockchain.address.listunspent') {
          return [{ tx_hash: 'tx1', tx_pos: 0, value: 1500, height: 42 }];
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    };

    const result = await scanRpaActivity({
      mnemonic: 'test mnemonic',
      passphrase: '',
      network: Network.CHIPNET,
      accountPath: "m/44'/1'/0'",
      adapter,
    });

    expect(result.status).toBe('complete');
    expect(result.payload.detectedPaymentCount).toBe(1);
    expect(result.payload.unspentSats).toBe(1500);
    expect(result.payload.unspentOutputs).toEqual([
      {
        txHash: 'tx1',
        outputIndex: 0,
        address: 'bchtest:qexpected',
        valueSats: 1500,
        height: 42,
      },
    ]);
    expect(deriveRpaKeysMock).toHaveBeenCalledWith(
      'test mnemonic',
      '',
      Network.CHIPNET,
      "m/44'/1'/0'"
    );
    expect(deriveAndEncodePaycodeMock).toHaveBeenCalledWith(
      'test mnemonic',
      '',
      Network.CHIPNET,
      8,
      "m/44'/1'/0'"
    );
  });

  it('does not treat a spent RPA output as part of the balance', async () => {
    const adapter = {
      request: vi.fn(async (method: string) => {
        if (method === 'rpa.getaddresshistory') return [{ tx_hash: 'tx1' }];
        if (method === 'blockchain.transaction.get') {
          return {
            inputs: [
              {
                prevout_hash: 'prevtx',
                prevout_n: 0,
                pubkeys: [`02${'11'.repeat(32)}`],
              },
            ],
            outputs: [{ address: 'bchtest:qexpected', value: 1500 }],
          };
        }
        if (method === 'blockchain.address.listunspent') return [];
        throw new Error(`Unexpected method: ${method}`);
      }),
    };

    const result = await scanRpaActivity({
      mnemonic: 'test mnemonic',
      passphrase: '',
      network: Network.CHIPNET,
      accountPath: "m/44'/1'/0'",
      adapter,
    });

    expect(result.payload.detectedPaymentCount).toBe(1);
    expect(result.payload.unspentOutputCount).toBe(0);
    expect(result.payload.unspentSats).toBe(0);
  });

  it('maps ordinary Electrum "Unsupported request: rpa.getaddresshistory" to a clear note', async () => {
    const adapter = {
      request: vi.fn(async (method: string) => {
        if (method === 'rpa.getaddresshistory') {
          throw new Error('Unsupported request: rpa.getaddresshistory');
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    };

    const result = await scanRpaActivity({
      mnemonic: 'test mnemonic',
      passphrase: '',
      network: Network.CHIPNET,
      accountPath: "m/44'/1'/0'",
      adapter,
    });

    expect(result.status).toBe('unavailable');
    expect(result.payload.serverSupported).toBe(false);
    expect(result.payload.error).toMatch(/Fulcrum-RPA/i);
    expect(result.payload.error).not.toMatch(/^Unsupported request:/);
  });

  it('queries Cauldron using the active wallet branches and summarizes pool balances', async () => {
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: new Uint8Array([1]) },
      txHash: 'pooltx',
      outputIndex: 1,
      ownerPublicKeyHash: 'aa',
      ownerAddress: 'bchtest:qowner',
      poolId: 'pool-1',
      output: {
        amountSatoshis: 5000n,
        tokenCategory: '11'.repeat(32),
        tokenAmount: 75n,
        lockingBytecode: new Uint8Array([2]),
      },
    };
    fetchNormalizedCauldronUserPoolsMock.mockResolvedValueOnce([pool]);

    const result = await scanCauldronActivity({
      walletId: 7,
      network: Network.CHIPNET,
      baseUtxos: [
        {
          address: 'bchtest:qreceive',
          height: 1,
          tx_hash: 'tx',
          tx_pos: 0,
          value: 100,
          token: { category: '11'.repeat(32), amount: 1 },
        },
      ],
    });

    expect(result.status).toBe('complete');
    expect(result.payload.derivedAddressCount).toBe(2);
    expect(result.payload.positionCount).toBe(1);
    expect(result.payload.totalSats).toBe('5000');
    expect(result.payload.tokenAmountsByCategory['11'.repeat(32)]).toBe('75');
    expect(fetchCauldronDerivedWalletAddressesMock).toHaveBeenCalledWith(
      7,
      Network.CHIPNET,
      32,
      0
    );
    expect(detectCauldronWalletPoolPositionsMock).toHaveBeenCalledWith(
      [pool],
      expect.any(Array)
    );
  });
});

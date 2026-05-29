import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAddonSDK } from '../AddonsSDK';
import type { AddonManifest } from '../../types/addons';
import KeyService from '../KeyService';
import BcmrService from '../BcmrService';

const {
  capacitorGetPlatformMock,
  capacitorIsNativePlatformMock,
  capacitorHttpGetMock,
} = vi.hoisted(() => ({
  capacitorGetPlatformMock: vi.fn(() => 'web'),
  capacitorIsNativePlatformMock: vi.fn(() => false),
  capacitorHttpGetMock: vi.fn(),
}));

vi.mock('../KeyService', () => ({
  default: {
    signMessageForAddress: vi.fn(),
    fetchAddressPrivateKey: vi.fn(),
  },
}));

vi.mock('../BcmrService', () => ({
  default: vi.fn().mockImplementation(() => ({
    getSnapshot: vi.fn(),
    resolveIdentityRegistry: vi.fn(),
  })),
}));

vi.mock(import('@capacitor/core'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: capacitorGetPlatformMock,
      isNativePlatform: capacitorIsNativePlatformMock,
    },
    CapacitorHttp: {
      ...actual.CapacitorHttp,
      get: capacitorHttpGetMock,
    },
  };
});

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: () => ({
    addOutput: vi.fn(),
    buildTransaction: vi.fn(),
  }),
}));

const manifest: AddonManifest = {
  id: 'test.signing',
  name: 'Test Signing Addon',
  version: '1.0.0',
  permissions: [
    {
      kind: 'capabilities',
      capabilities: ['signing:message_sign'],
    },
  ],
  contracts: [],
};

describe('AddonsSDK signing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs messages through the wallet key path', async () => {
    vi.mocked(KeyService.signMessageForAddress).mockResolvedValue({
      signature: 'signed-message',
      raw: {
        ecdsa: 'ecdsa',
        schnorr: 'schnorr',
        der: 'der',
      },
      details: {
        recoveryId: 1,
        compressed: true,
        messageHash: 'hash',
      },
    });

    const sdk = createAddonSDK(manifest, {
      walletId: 1,
      network: 'mainnet',
      walletAddresses: new Set(['bitcoincash:qtestaddress']),
      appId: 'signing-app',
    });

    const result = await sdk.signing.signMessage({
      address: 'bitcoincash:qtestaddress',
      message: 'hello world',
    });

    expect(KeyService.signMessageForAddress).toHaveBeenCalledWith(
      'bitcoincash:qtestaddress',
      'hello world'
    );
    expect(result.address).toBe('bitcoincash:qtestaddress');
    expect(result.encoding).toBe('bch-signed-message');
    expect(result.signature).toBe('signed-message');
  });

  it('refuses message signing for non-wallet addresses', async () => {
    const sdk = createAddonSDK(manifest, {
      walletId: 1,
      network: 'mainnet',
      walletAddresses: new Set(['bitcoincash:qallowed']),
      appId: 'signing-app',
    });

    await expect(
      sdk.signing.signMessage({
        address: 'bitcoincash:qblocked',
        message: 'hello world',
      })
    ).rejects.toThrow('Addon attempted access to non-wallet address');
  });
});

describe('AddonsSDK bcmr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads token metadata through the wallet BCMR service', async () => {
    const bcmrInstance = {
      getSnapshot: vi.fn().mockResolvedValue({
        name: 'Alpha Token',
        description: '',
        token: {
          category:
            '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
          symbol: 'ALPHA',
          decimals: 0,
        },
        is_nft: false,
        uris: {},
        extensions: {},
      }),
      getCategoryAuthbase: vi.fn().mockResolvedValue(
        '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
      ),
      resolveIcon: vi.fn().mockResolvedValue(null),
      resolveIdentityRegistry: vi.fn(),
    };

    vi.mocked(BcmrService).mockImplementation(
      () => bcmrInstance as unknown as BcmrService
    );

    const sdk = createAddonSDK(
      {
        id: 'test.bcmr',
        name: 'Test BCMR Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['bcmr:token:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'bcmr-app',
      }
    );

    const result = await sdk.bcmr.getTokenMetadata(
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
    );

    expect(bcmrInstance.getSnapshot).toHaveBeenCalledWith(
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
    );
    expect(result?.name).toBe('Alpha Token');
    expect(result?.token.symbol).toBe('ALPHA');
  });

  it('returns BCMR metadata state with freshness information', async () => {
    const bcmrInstance = {
      getSnapshot: vi.fn().mockResolvedValue({
        name: 'Alpha Token',
        description: '',
        token: {
          category:
            '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
          symbol: 'ALPHA',
          decimals: 0,
        },
        is_nft: false,
        uris: {},
        extensions: {},
      }),
      getCategoryAuthbase: vi.fn().mockResolvedValue(
        '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
      ),
      resolveIcon: vi.fn().mockResolvedValue(null),
      resolveIdentityRegistry: vi.fn(),
    };

    vi.mocked(BcmrService).mockImplementation(
      () => bcmrInstance as unknown as BcmrService
    );

    const sdk = createAddonSDK(
      {
        id: 'test.bcmr.state',
        name: 'Test BCMR Addon State',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['bcmr:token:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'bcmr-app',
      }
    );

    const result = await sdk.bcmr.getTokenMetadataState(
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
    );

    expect(result?.freshness).toBe('cached');
    expect(result?.status).toBe('ready');
    expect(result?.snapshot?.token.symbol).toBe('ALPHA');
  });

  it('preserves cached BCMR metadata when icon hydration fails', async () => {
    const bcmrInstance = {
      getSnapshot: vi.fn().mockResolvedValue({
        name: 'Alpha Token',
        description: '',
        token: {
          category:
            '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
          symbol: 'ALPHA',
          decimals: 0,
        },
        is_nft: false,
        uris: {},
        extensions: {},
      }),
      getCategoryAuthbase: vi.fn().mockResolvedValue(
        '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
      ),
      resolveIcon: vi.fn().mockRejectedValue(new Error('gateway offline')),
      resolveIdentityRegistry: vi.fn(),
    };

    vi.mocked(BcmrService).mockImplementation(
      () => bcmrInstance as unknown as BcmrService
    );

    const sdk = createAddonSDK(
      {
        id: 'test.bcmr.icon',
        name: 'Test BCMR Addon Icon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['bcmr:token:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'bcmr-app',
      }
    );

    const result = await sdk.bcmr.getTokenMetadataState(
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
    );

    expect(result?.freshness).toBe('cached');
    expect(result?.snapshot?.token.symbol).toBe('ALPHA');
    expect(result?.iconUri).toBeNull();
  });
});

describe('AddonsSDK tokenIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capacitorGetPlatformMock.mockReturnValue('web');
  });

  it('reads holder lists through the TokenIndex SDK module', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        holders: [
          {
            locking_bytecode: '76a914abc123',
            locking_address: 'bitcoincash:qtestholder',
            ft_balance: '42',
            utxo_count: 1,
            updated_height: 900000,
          },
        ],
        next_cursor: null,
      }),
      text: async () =>
        JSON.stringify({
          holders: [
            {
              locking_bytecode: '76a914abc123',
              locking_address: 'bitcoincash:qtestholder',
              ft_balance: '42',
              utxo_count: 1,
              updated_height: 900000,
            },
          ],
          next_cursor: null,
        }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const sdk = createAddonSDK(
      {
        id: 'test.tokenindex',
        name: 'Test TokenIndex Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tokenindex:holders:read'],
          },
          {
            kind: 'http',
            domains: ['tokenindex.optnlabs.com'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'tokenindex-app',
      }
    );

    const result = await sdk.tokenIndex.listTokenHolders({
      category:
        '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
      limit: 25,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://tokenindex.optnlabs.com/v1/token/8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22/holders?limit=25',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
    expect(result.holders).toHaveLength(1);
    expect(result.holders[0].locking_address).toBe('bitcoincash:qtestholder');

    vi.unstubAllGlobals();
  });

  it('uses CapacitorHttp for token index requests on native platforms', async () => {
    capacitorGetPlatformMock.mockReturnValue('android');
    capacitorIsNativePlatformMock.mockReturnValue(true);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    capacitorHttpGetMock.mockResolvedValue({
      data: {
        holders: [
          {
            locking_bytecode: '76a914abc123',
            locking_address: 'bitcoincash:qnativeholder',
            ft_balance: '99',
            utxo_count: 1,
            updated_height: 900001,
          },
        ],
        next_cursor: null,
      },
    });

    const sdk = createAddonSDK(
      {
        id: 'test.tokenindex.native',
        name: 'Test TokenIndex Native Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tokenindex:holders:read'],
          },
          {
            kind: 'http',
            domains: ['tokenindex.optnlabs.com'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'tokenindex-app',
      }
    );

    const result = await sdk.tokenIndex.listTokenHolders({
      category:
        '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
      limit: 25,
    });

    expect(capacitorHttpGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://tokenindex.optnlabs.com/v1/token/8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22/holders?limit=25',
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://tokenindex.optnlabs.com/v1/token/8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22/holders?limit=25',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
    expect(result.holders[0].locking_address).toBe('bitcoincash:qnativeholder');
    vi.unstubAllGlobals();
  });
});

describe('AddonsSDK manifest validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed when created with an invalid manifest', () => {
    expect(() =>
      createAddonSDK(
        {
          id: 'bad.addon',
          name: 'Bad Addon',
          version: '1.0.0',
          permissions: [
            {
              kind: 'http',
              domains: ['example.com'],
            },
          ],
          contracts: [],
        },
        {
          walletId: 1,
          network: 'mainnet',
          appId: 'bad-addon-app',
        }
      )
    ).toThrow('non-allowlisted domain');
  });
});

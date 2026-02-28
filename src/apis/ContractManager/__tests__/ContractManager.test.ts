import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../../redux/networkSlice';
import ContractManager from '../ContractManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';
import AddonsRegistry from '../../../services/AddonsRegistry';
import KeyService from '../../../services/KeyService';

let builtinCache: Record<string, Record<string, unknown>> = {};
const mockContractUnlockClaim = vi.fn();

vi.mock('../artifacts', () => ({
  createBuiltinArtifactCache: vi.fn(() => builtinCache),
}));

vi.mock('../../DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

const mockAddons = {
  init: vi.fn(async () => {}),
  getAddons: vi.fn(() => []),
};
vi.mock('../../../services/AddonsRegistry', () => ({
  default: vi.fn(() => mockAddons),
}));

vi.mock('../../../services/ElectrumService', () => ({
  default: {
    getUTXOs: vi.fn(async () => []),
  },
}));

vi.mock('../../../services/KeyService', () => ({
  default: {
    fetchAddressPrivateKey: vi.fn(),
  },
}));

vi.mock('../../../redux/store', () => ({
  store: {
    getState: vi.fn(() => ({ network: { currentNetwork: Network.MAINNET } })),
  },
}));

vi.mock('cashscript', () => {
  class MockElectrumNetworkProvider {
    constructor(_network: string) {}
  }

  class MockSignatureTemplate {
    key: unknown;
    hashType: unknown;
    constructor(key: unknown, hashType: unknown) {
      this.key = key;
      this.hashType = hashType;
    }
  }

  class MockContract {
    address = 'bitcoincash:qcontract';
    tokenAddress = 'bitcoincash:ztoken';
    opcount = 0;
    bytesize = 0;
    bytecode = '00';
    redeemScript = '76a9...88ac';
    unlock = {
      claim: mockContractUnlockClaim,
    };
    constructor(
      _artifact: unknown,
      _args: unknown[],
      _opts: Record<string, unknown>
    ) {}
    async getBalance() {
      return 0n;
    }
  }

  return {
    Contract: MockContract,
    ElectrumNetworkProvider: MockElectrumNetworkProvider,
    SignatureTemplate: MockSignatureTemplate,
    HashType: { SIGHASH_ALL: 'ALL' },
  };
});

describe('ContractManager', () => {
  const mockedDatabaseService = vi.mocked(DatabaseService);
  const mockedAddonsRegistry = vi.mocked(AddonsRegistry);
  const mockedKeyService = vi.mocked(KeyService);

  beforeEach(() => {
    vi.clearAllMocks();
    builtinCache = {
      demo: {
        contractName: 'DemoContract',
        constructorInputs: [],
        abi: [{ name: 'claim', inputs: [{ name: 'sig', type: 'sig' }] }],
      },
    };
    mockContractUnlockClaim.mockReturnValue('unlocker-result');

    mockAddons.init.mockResolvedValue(undefined);
    mockAddons.getAddons.mockReturnValue([]);

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => ({
        prepare: vi.fn(() => ({
          bind: vi.fn(),
          step: vi.fn(() => false),
          getAsObject: vi.fn(() => ({})),
          run: vi.fn(),
          free: vi.fn(),
        })),
        run: vi.fn(),
      })),
      saveDatabaseToFile: vi.fn(async () => {}),
    } as never);

    mockedKeyService.fetchAddressPrivateKey.mockResolvedValue(
      Uint8Array.from([1, 2, 3])
    );

    mockedAddonsRegistry.mockReturnValue(mockAddons as never);
  });

  it('loadArtifact resolves builtin by key, case-insensitive key, and contract name', async () => {
    const cm = ContractManager();

    await expect(cm.loadArtifact('demo')).resolves.toEqual(builtinCache.demo);
    await expect(cm.loadArtifact('DEMO')).resolves.toEqual(builtinCache.demo);
    await expect(cm.loadArtifact('democontract')).resolves.toEqual(
      builtinCache.demo
    );
  });

  it('loadArtifact and listAvailableArtifacts include addon contracts', async () => {
    mockAddons.getAddons.mockReturnValue([
      {
        id: 'addon.one',
        name: 'Addon',
        version: '1.0.0',
        permissions: [{ kind: 'none' }],
        contracts: [
          {
            id: 'escrow',
            name: 'Escrow',
            cashscriptArtifact: { contractName: 'Escrow' },
            functions: [],
          },
        ],
      },
    ]);

    const cm = ContractManager();

    await expect(cm.loadArtifact('addon:addon.one:escrow')).resolves.toEqual({
      contractName: 'Escrow',
    });

    const entries = await cm.listAvailableArtifacts();
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          fileName: 'demo',
          contractName: 'DemoContract',
          source: 'builtin',
        },
        {
          fileName: 'addon:addon.one:escrow',
          contractName: 'Escrow',
          source: 'addon',
        },
      ])
    );
  });

  it('getContractArtifact parses persisted artifact fields from DB row', async () => {
    const statement = {
      bind: vi.fn(),
      step: vi.fn(() => true),
      getAsObject: vi.fn(() => ({
        contract_name: 'Demo',
        constructor_inputs: JSON.stringify([{ name: 'x', type: 'int' }]),
        abi: JSON.stringify([{ name: 'claim', inputs: [] }]),
        bytecode: '0011',
        source: 'src',
        compiler_name: 'cashc',
        compiler_version: '1.0.0',
        updated_at: '2026-02-28T00:00:00.000Z',
      })),
      free: vi.fn(),
      run: vi.fn(),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => ({
        prepare: vi.fn(() => statement),
      })),
      saveDatabaseToFile: vi.fn(async () => {}),
    } as never);

    const cm = ContractManager();
    const artifact = await cm.getContractArtifact('Demo');

    expect(artifact).toEqual({
      contractName: 'Demo',
      constructorInputs: [{ name: 'x', type: 'int' }],
      abi: [{ name: 'claim', inputs: [] }],
      bytecode: '0011',
      source: 'src',
      compiler: { name: 'cashc', version: '1.0.0' },
      updatedAt: '2026-02-28T00:00:00.000Z',
    });
  });

  it('getContractUnlockFunction supports sigaddr inputs', async () => {
    const statement = {
      bind: vi.fn(),
      step: vi.fn(() => false),
      getAsObject: vi.fn(() => ({})),
      free: vi.fn(),
      run: vi.fn(),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => ({ prepare: vi.fn(() => statement), run: vi.fn() })),
      saveDatabaseToFile: vi.fn(async () => {}),
    } as never);

    const cm = ContractManager();
    const result = await cm.getContractUnlockFunction(
      {
        address: 'bitcoincash:qcontract',
        height: 0,
        tx_hash: 'a'.repeat(64),
        tx_pos: 0,
        value: 1000,
        contractName: 'demo',
      },
      'claim',
      { sig: 'sigaddr:bitcoincash:qsigner' }
    );

    expect(mockedKeyService.fetchAddressPrivateKey).toHaveBeenCalledWith(
      'bitcoincash:qsigner'
    );
    expect(mockContractUnlockClaim).toHaveBeenCalledTimes(1);
    expect(result.lockingBytecode).toBe('76a9...88ac');
    expect(result.unlocker).toBe('unlocker-result');
  });

  it('createContract requires constructor args when artifact expects them', async () => {
    builtinCache = {
      demo_with_ctor: {
        contractName: 'CtorContract',
        constructorInputs: [{ name: 'owner', type: 'pubkey' }],
        abi: [],
      },
    };

    const cm = ContractManager();

    await expect(
      cm.createContract('demo_with_ctor', [], Network.MAINNET)
    ).rejects.toThrow('Constructor arguments are required');
  });
});

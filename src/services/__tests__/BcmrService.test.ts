import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('../../utils/ipfs', () => ({
  ipfsFetch: vi.fn(),
  resolveIpfsGatewayUrl: vi.fn((uri: string) => uri),
}));

vi.mock('../../apis/ChaingraphManager/ChaingraphManager', () => ({
  stripChaingraphHexBytes: (value: unknown) =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\\x/i, '')
      .replace(/^0x/i, ''),
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    getDatabase: () => null,
    ensureDatabaseStarted: vi.fn(),
    flushDatabaseToFile: vi.fn(),
  }),
}));

import BcmrService from '../BcmrService';
import { ipfsFetch } from '../../utils/ipfs';

describe('BcmrService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers authchain BCMR over partial indexer fallback when latest registry is missing', async () => {
    const service = new BcmrService() as unknown as {
      fetchAndCommitRegistry: (
        authbase: string,
        uriOrUris: string | string[]
      ) => Promise<unknown>;
      resolveAuthChainRegistry: ReturnType<typeof vi.fn>;
      fetchIndexerTokenFallback: ReturnType<typeof vi.fn>;
    };

    service.resolveAuthChainRegistry = vi.fn().mockResolvedValue({
      registryUri: 'ipfs://authchain',
      registry: {},
    });
    service.fetchIndexerTokenFallback = vi.fn().mockResolvedValue({
      registryUri: 'https://fallback.example/tokens/123',
      registry: {},
    });

    vi.mocked(ipfsFetch).mockResolvedValue(
      new Response('missing', { status: 404, statusText: 'Not Found' })
    );

    const result = await service.fetchAndCommitRegistry(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'https://bcmr.example/api/registries/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/latest'
    );

    expect(service.resolveAuthChainRegistry).toHaveBeenCalled();
    expect(service.fetchIndexerTokenFallback).not.toHaveBeenCalled();
    expect(result).toMatchObject({ registryUri: 'ipfs://authchain' });
  });

  it('prefers tokenindexer v1 BCMR before legacy registry URLs', async () => {
    const authbase =
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const service = new BcmrService() as unknown as {
      resolveIdentityRegistryUncached: (authbase: string) => Promise<unknown>;
      loadIdentityRegistry: ReturnType<typeof vi.fn>;
      fetchTokenIndexNativeRegistry: ReturnType<typeof vi.fn>;
      fetchAndCommitRegistry: ReturnType<typeof vi.fn>;
      resolveAuthChainRegistry: ReturnType<typeof vi.fn>;
    };

    service.loadIdentityRegistry = vi.fn().mockRejectedValue(new Error('missing'));
    service.fetchTokenIndexNativeRegistry = vi
      .fn()
      .mockResolvedValue({
        registryUri: `https://tokenindex.optnlabs.com/v1/token/${authbase}/bcmr`,
        registry: {},
      });
    service.fetchAndCommitRegistry = vi.fn();
    service.resolveAuthChainRegistry = vi.fn();

    const result = await service.resolveIdentityRegistryUncached(authbase);

    expect(service.fetchTokenIndexNativeRegistry).toHaveBeenCalledWith(authbase, [
      `https://tokenindex.optnlabs.com/v1/token/${authbase}/bcmr`,
    ]);
    expect(service.fetchAndCommitRegistry).not.toHaveBeenCalled();
    expect(service.resolveAuthChainRegistry).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      registryUri: `https://tokenindex.optnlabs.com/v1/token/${authbase}/bcmr`,
    });
  });

  it('falls back to legacy registry URLs when tokenindexer v1 is unavailable', async () => {
    const authbase =
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const service = new BcmrService() as unknown as {
      resolveIdentityRegistryUncached: (authbase: string) => Promise<unknown>;
      loadIdentityRegistry: ReturnType<typeof vi.fn>;
      fetchTokenIndexNativeRegistry: ReturnType<typeof vi.fn>;
      fetchAndCommitRegistry: ReturnType<typeof vi.fn>;
    };

    service.loadIdentityRegistry = vi.fn().mockRejectedValue(new Error('missing'));
    service.fetchTokenIndexNativeRegistry = vi.fn().mockResolvedValue(null);
    service.fetchAndCommitRegistry = vi.fn().mockResolvedValue({
      registryUri: `https://bcmr.optnlabs.com/api/registries/${authbase}/latest`,
      registry: {},
    });

    const result = await service.resolveIdentityRegistryUncached(authbase);

    expect(service.fetchTokenIndexNativeRegistry).toHaveBeenCalled();
    expect(service.fetchAndCommitRegistry).toHaveBeenCalledWith(
      authbase,
      [
        `https://bcmr.optnlabs.com/api/registries/${authbase}/latest`,
        `https://bcmr.paytaca.com/api/registries/${authbase}/latest`,
      ]
    );
    expect(result).toMatchObject({
      registryUri: `https://bcmr.optnlabs.com/api/registries/${authbase}/latest`,
    });
  });

  it('prefers authchain BCMR over a stale hosted latest registry', async () => {
    const authbase =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const service = new BcmrService() as unknown as {
      fetchAndCommitRegistry: (
        authbase: string,
        uriOrUris: string | string[]
      ) => Promise<unknown>;
      resolveAuthChainRegistry: ReturnType<typeof vi.fn>;
      commitIdentityRegistry: ReturnType<typeof vi.fn>;
    };

    service.resolveAuthChainRegistry = vi.fn().mockResolvedValue({
      registryUri: 'ipfs://fresh-on-chain',
      registry: {},
    });
    service.commitIdentityRegistry = vi.fn();

    vi.mocked(ipfsFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
          version: { major: 0, minor: 0, patch: 0 },
          latestRevision: '2026-04-10T00:00:00.000Z',
          identities: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    const result = await service.fetchAndCommitRegistry(
      authbase,
      `https://bcmr.example/api/registries/${authbase}/latest`
    );

    expect(service.resolveAuthChainRegistry).toHaveBeenCalledWith(
      authbase,
      `https://bcmr.example/api/registries/${authbase}/latest`
    );
    expect(ipfsFetch).not.toHaveBeenCalled();
    expect(service.commitIdentityRegistry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ registryUri: 'ipfs://fresh-on-chain' });
  });

  it('upgrades provisional token fallback entries loaded from disk using authchain data', async () => {
    const authbase =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const service = new BcmrService() as unknown as {
      resolveIdentityRegistryUncached: (authbase: string) => Promise<unknown>;
      loadIdentityRegistry: ReturnType<typeof vi.fn>;
      resolveAuthChainRegistry: ReturnType<typeof vi.fn>;
    };
    service.loadIdentityRegistry = vi.fn().mockResolvedValue({
      registryUri:
        `https://bcmr.example/api/tokens/${authbase}/`,
      registry: {
        $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
        version: { major: 0, minor: 0, patch: 0 },
        latestRevision: '2026-04-10T00:00:00.000Z',
        identities: {
          [authbase]: {
            '2026-04-10T00:00:00.000Z': {
              name: 'partial',
              token: {
                category: authbase,
                symbol: '',
                decimals: 0,
              },
            },
          },
        },
      },
      registryHash: 'hash',
      lastFetch: new Date().toISOString(),
    });

    service.resolveAuthChainRegistry = vi.fn().mockResolvedValue({
      registryUri: 'ipfs://authchain-upgraded',
      registry: {},
    });

    const result = await service.resolveIdentityRegistryUncached(
      authbase
    );

    expect(service.resolveAuthChainRegistry).toHaveBeenCalled();
    expect(result).toMatchObject({ registryUri: 'ipfs://authchain-upgraded' });
  });

  it('refreshes stale hosted registry entries from disk using on-chain BCMR before returning cache', async () => {
    const authbase =
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const service = new BcmrService() as unknown as {
      resolveIdentityRegistryUncached: (authbase: string) => Promise<unknown>;
      loadIdentityRegistry: ReturnType<typeof vi.fn>;
      resolveAuthChainRegistry: ReturnType<typeof vi.fn>;
    };

    service.loadIdentityRegistry = vi.fn().mockResolvedValue({
      registryUri:
        `https://bcmr.example/api/registries/${authbase}/latest`,
      registry: {
        $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
        version: { major: 0, minor: 0, patch: 0 },
        latestRevision: '2026-04-10T00:00:00.000Z',
        identities: {},
      },
      registryHash: 'hash',
      lastFetch: new Date().toISOString(),
    });

    service.resolveAuthChainRegistry = vi.fn().mockResolvedValue({
      registryUri: 'ipfs://disk-upgraded-from-authchain',
      registry: {},
    });

    const result = await service.resolveIdentityRegistryUncached(authbase);

    expect(service.resolveAuthChainRegistry).toHaveBeenCalledWith(
      authbase,
      `https://bcmr.example/api/registries/${authbase}/latest`
    );
    expect(result).toMatchObject({
      registryUri: 'ipfs://disk-upgraded-from-authchain',
    });
  });

  it('extracts metadata by token category across merged registry identities', () => {
    const service = new BcmrService();
    const registry = {
      $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
      version: { major: 0, minor: 0, patch: 2 },
      latestRevision: '2026-04-11T00:00:00.000Z',
      registryIdentity:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      identities: {
        ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']: {
          '2026-04-11T00:00:00.000Z': {
            name: 'Authbase Token',
            token: {
              category:
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              symbol: 'AUTH',
              decimals: 0,
            },
          },
        },
        ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']: {
          '2026-04-10T00:00:00.000Z': {
            name: 'Merged Token',
            description: 'Merged metadata',
            token: {
              category:
                'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              symbol: 'MRG',
              decimals: 2,
            },
            uris: {
              icon: 'ipfs://merged-icon',
            },
          },
        },
      },
    };

    const snapshot = service.extractIdentityByCategory(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      registry
    );

    expect(snapshot.name).toBe('Merged Token');
    expect(snapshot.token?.symbol).toBe('MRG');
    expect(snapshot.uris?.icon).toBe('ipfs://merged-icon');
  });

  it('can resolve category-specific hosted BCMR when the current authchain registry does not include that token', async () => {
    const category =
      '0c31b43bdfd013904062ba3e5ddf499ef771d94ea1852c7aa3949efdf5269e14';
    const service = new BcmrService() as unknown as {
      resolveCategorySpecificRegistry: (category: string) => Promise<unknown>;
      commitIdentityRegistry: ReturnType<typeof vi.fn>;
    };

    const registryJson = JSON.stringify({
      $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
      version: { major: 0, minor: 0, patch: 1 },
      latestRevision: '2026-04-10T00:00:00.000Z',
      registryIdentity: category,
      identities: {
        [category]: {
          '2026-04-10T00:00:00.000Z': {
            name: 'USDB',
            token: {
              category,
              symbol: 'USDB',
              decimals: 2,
            },
          },
        },
      },
    });

    service.commitIdentityRegistry = vi
      .fn()
      .mockImplementation(async (_authbase: string, registry: unknown, uri: string) => ({
        registry,
        registryUri: uri,
      }));

    vi.mocked(ipfsFetch).mockResolvedValue(
      new Response(registryJson, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await service.resolveCategorySpecificRegistry(category);

    expect(ipfsFetch).toHaveBeenCalled();
    expect(String((result as { registryUri?: string })?.registryUri)).toContain(
      `/registries/${category}/latest`
    );
  });
});

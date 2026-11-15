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
  resolveIpfsGatewayUrl: vi.fn((uri: string) =>
    uri.includes('.ipfs.') || uri.startsWith('ipfs://')
      ? 'https://ipfs.optnlabs.com/ipfs/example'
      : null
  ),
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

vi.mock('../../assets/bcmr-optn-local.json', () => ({
  default: {
    $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
    version: { major: 0, minor: 0, patch: 1 },
    latestRevision: '2026-11-01T00:00:00.000Z',
    registryIdentity: {
      name: 'OPTN Wallet Local Registry',
      description: 'Test registry',
    },
    identities: {
      ['9'.repeat(64)]: {
        '2026-11-01T00:00:00.000Z': {
          name: 'Embedded Token',
          token: {
            category: '9'.repeat(64),
            symbol: 'LOCAL',
            decimals: 2,
          },
        },
      },
    },
  },
}));

const embeddedCategory = '9'.repeat(64);

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

  it('prefers public BCMR before the OPTN TokenIndexer fallback', async () => {
    const authbase =
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const service = new BcmrService() as unknown as {
      resolveIdentityRegistryUncached: (authbase: string) => Promise<unknown>;
      loadIdentityRegistry: ReturnType<typeof vi.fn>;
      fetchTokenIndexNativeRegistry: ReturnType<typeof vi.fn>;
      fetchAndCommitRegistry: ReturnType<typeof vi.fn>;
      resolveAuthChainRegistry: ReturnType<typeof vi.fn>;
    };

    service.loadIdentityRegistry = vi
      .fn()
      .mockRejectedValue(new Error('missing'));
    service.fetchTokenIndexNativeRegistry = vi.fn();
    service.fetchAndCommitRegistry = vi.fn().mockResolvedValue({
      registryUri: `https://bcmr-chipnet.paytaca.com/api/registries/${authbase}/latest`,
      registry: {},
    });

    const result = await service.resolveIdentityRegistryUncached(authbase);

    expect(service.fetchAndCommitRegistry).toHaveBeenCalledWith(authbase, [
      `https://bcmr.optnlabs.com/api/registries/${authbase}/latest`,
      `https://bcmr.paytaca.com/api/registries/${authbase}/latest`,
    ]);
    expect(service.fetchTokenIndexNativeRegistry).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      registryUri: `https://bcmr-chipnet.paytaca.com/api/registries/${authbase}/latest`,
    });
  });

  it('uses the embedded local registry when hosted and on-chain sources fail', async () => {
    const service = new BcmrService() as unknown as {
      resolveIdentityRegistryUncached: (authbase: string) => Promise<{
        registryUri: string;
        registry: unknown;
      }>;
      loadIdentityRegistry: ReturnType<typeof vi.fn>;
      fetchTokenIndexNativeRegistry: ReturnType<typeof vi.fn>;
      fetchAndCommitRegistry: ReturnType<typeof vi.fn>;
      resolveAuthChainRegistry: ReturnType<typeof vi.fn>;
    };

    service.loadIdentityRegistry = vi
      .fn()
      .mockRejectedValue(new Error('missing'));
    service.fetchTokenIndexNativeRegistry = vi.fn().mockResolvedValue(null);
    service.fetchAndCommitRegistry = vi
      .fn()
      .mockRejectedValue(new Error('offline'));
    service.resolveAuthChainRegistry = vi.fn().mockResolvedValue(null);

    const result =
      await service.resolveIdentityRegistryUncached(embeddedCategory);

    expect(result.registryUri).toBe('optn://local/bcmr');
    expect(result.registry).toMatchObject({
      identities: {
        [embeddedCategory]: expect.any(Object),
      },
    });
  });

  it('treats a 200 token summary without BCMR as a typed metadata miss', async () => {
    const category =
      '1111111111111111111111111111111111111111111111111111111111111111';
    const service = new BcmrService() as unknown as {
      fetchTokenIndexNativeRegistry: (
        authbase: string,
        uri: string
      ) => Promise<unknown>;
    };

    vi.mocked(ipfsFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          category,
          bcmr: {
            identity_snapshot: null,
          },
        }),
        { status: 200 }
      )
    );

    await expect(
      service.fetchTokenIndexNativeRegistry(
        category,
        `https://tokenindex.optnlabs.com/v1/token/${category}`
      )
    ).rejects.toMatchObject({ name: 'BcmrRegistryNotFoundError' });
  });

  it('extracts nested BCMR identity data from the public TokenIndexer summary', async () => {
    const category = '2'.repeat(64);
    const service = new BcmrService() as unknown as {
      fetchTokenIndexNativeRegistry: (
        authbase: string,
        uri: string
      ) => Promise<{ registry: unknown; registryUri: string }>;
      commitIdentityRegistry: ReturnType<typeof vi.fn>;
    };
    service.commitIdentityRegistry = vi
      .fn()
      .mockImplementation(async (_authbase, registry, registryUri) => ({
        registry,
        registryUri,
        registryHash: 'hash',
        lastFetch: '2026-11-12T00:00:00.000Z',
      }));

    vi.mocked(ipfsFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          category,
          bcmr: {
            latest_revision: '2026-11-12T00:00:00.000Z',
            identity_snapshot: {
              name: 'Public TokenIndexer Token',
              token: { category, symbol: 'PUBLIC', decimals: 2 },
            },
          },
        }),
        { status: 200 }
      )
    );

    const result = await service.fetchTokenIndexNativeRegistry(
      category,
      `https://tokenindex.optnlabs.com/v1/token/${category}`
    );

    expect(result?.registry).toMatchObject({
      identities: {
        [category]: {
          '2026-11-12T00:00:00.000Z': expect.anything(),
        },
      },
    });
  });

  it('falls back to TokenIndexer when the public BCMR pool is unavailable', async () => {
    const authbase =
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const service = new BcmrService() as unknown as {
      resolveIdentityRegistryUncached: (authbase: string) => Promise<unknown>;
      loadIdentityRegistry: ReturnType<typeof vi.fn>;
      fetchTokenIndexNativeRegistry: ReturnType<typeof vi.fn>;
      fetchAndCommitRegistry: ReturnType<typeof vi.fn>;
    };

    service.loadIdentityRegistry = vi
      .fn()
      .mockRejectedValue(new Error('missing'));
    service.fetchAndCommitRegistry = vi
      .fn()
      .mockRejectedValue(new Error('public offline'));
    service.fetchTokenIndexNativeRegistry = vi.fn().mockResolvedValue({
      registryUri: `https://tokenindex.optnlabs.com/v1/token/${authbase}`,
      registry: {},
    });

    const result = await service.resolveIdentityRegistryUncached(authbase);

    expect(service.fetchAndCommitRegistry).toHaveBeenCalledWith(authbase, [
      `https://bcmr.optnlabs.com/api/registries/${authbase}/latest`,
      `https://bcmr.paytaca.com/api/registries/${authbase}/latest`,
    ]);
    expect(service.fetchTokenIndexNativeRegistry).toHaveBeenCalledWith(
      authbase,
      [`https://tokenindex.optnlabs.com/v1/token/${authbase}`]
    );
    expect(result).toMatchObject({
      registryUri: `https://tokenindex.optnlabs.com/v1/token/${authbase}`,
    });
  });

  it('queries TokenIndexer by category when category and authbase differ', async () => {
    const category = '3'.repeat(64);
    const authbase = '4'.repeat(64);
    const service = new BcmrService() as unknown as {
      getDefaultNativeRegistryUris: ReturnType<typeof vi.fn>;
      loadIdentityRegistry: ReturnType<typeof vi.fn>;
      fetchAndCommitRegistry: ReturnType<typeof vi.fn>;
      fetchTokenIndexNativeRegistry: ReturnType<typeof vi.fn>;
      resolveAuthChainRegistry: ReturnType<typeof vi.fn>;
    };

    service.getDefaultNativeRegistryUris = vi
      .fn()
      .mockReturnValue([
        `https://tokenindex.optnlabs.com/v1/token/${category}`,
      ]);
    service.loadIdentityRegistry = vi
      .fn()
      .mockRejectedValue(new Error('missing'));
    service.fetchAndCommitRegistry = vi
      .fn()
      .mockRejectedValue(new Error('public offline'));
    service.fetchTokenIndexNativeRegistry = vi.fn().mockResolvedValue({
      registryUri: `https://tokenindex.optnlabs.com/v1/token/${category}`,
      registry: {},
    });
    service.resolveAuthChainRegistry = vi.fn().mockResolvedValue(null);

    const result = await service.resolveIdentityRegistryUncached(
      authbase,
      category
    );

    expect(service.getDefaultNativeRegistryUris).toHaveBeenCalledWith(category);
    expect(service.fetchTokenIndexNativeRegistry).toHaveBeenCalledWith(
      authbase,
      [`https://tokenindex.optnlabs.com/v1/token/${category}`]
    );
    expect(result).toMatchObject({
      registryUri: `https://tokenindex.optnlabs.com/v1/token/${category}`,
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
      registryUri: `https://bcmr.example/api/tokens/${authbase}/`,
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

    const result = await service.resolveIdentityRegistryUncached(authbase);

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
      registryUri: `https://bcmr.example/api/registries/${authbase}/latest`,
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

  it('fetches gateway-hosted IPFS icons instead of returning a CORP-blocked URL', async () => {
    const category = 'ab'.repeat(32);
    const service = new BcmrService();
    vi.mocked(ipfsFetch).mockResolvedValue(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    );

    const extractIdentityByCategory = vi
      .spyOn(service, 'extractIdentityByCategory')
      .mockReturnValue({
        name: 'Gateway token',
        token: { category, decimals: 0, symbol: 'GW' },
        uris: {
          icon: 'https://bafyexample.ipfs.dweb.link/icon.png',
        },
      });

    const icon = await service.resolveIcon(
      'cd'.repeat(32),
      undefined,
      category
    );

    expect(extractIdentityByCategory).toHaveBeenCalledWith(category);
    expect(ipfsFetch).toHaveBeenCalledWith(
      'https://bafyexample.ipfs.dweb.link/icon.png'
    );
    expect(icon).toMatch(/^data:image\/png;base64,/);
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
      .mockImplementation(
        async (_authbase: string, registry: unknown, uri: string) => ({
          registry,
          registryUri: uri,
        })
      );

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

  it('resolves and caches token metadata for transaction detail rendering', async () => {
    const category = 'a'.repeat(64);
    const snapshot = {
      name: 'Example Token',
      token: { category, symbol: 'EX', decimals: 2 },
    };
    const metadata = {
      name: 'Example Token',
      description: '',
      token: { category, symbol: 'EX', decimals: 2 },
      is_nft: false,
      uris: {},
      extensions: {},
    };
    const resolved = {
      registry: {},
      registryHash: 'hash',
      registryUri: 'https://tokenindex.example/v1/token/a',
      lastFetch: '2026-11-10T00:00:00.000Z',
    };
    const service = new BcmrService() as unknown as {
      getSnapshot: ReturnType<typeof vi.fn>;
      getCategoryAuthbase: ReturnType<typeof vi.fn>;
      resolveIdentityRegistry: ReturnType<typeof vi.fn>;
      extractIdentityByCategory: ReturnType<typeof vi.fn>;
      storeSnapshot: ReturnType<typeof vi.fn>;
      resolveSnapshot: (category: string) => Promise<unknown>;
    };
    service.getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(metadata);
    service.getCategoryAuthbase = vi.fn().mockResolvedValue(category);
    service.resolveIdentityRegistry = vi.fn().mockResolvedValue(resolved);
    service.extractIdentityByCategory = vi.fn().mockReturnValue(snapshot);
    service.storeSnapshot = vi.fn().mockResolvedValue(undefined);

    await expect(service.resolveSnapshot(category)).resolves.toEqual(metadata);
    expect(service.resolveIdentityRegistry).toHaveBeenCalledWith(category);
    expect(service.storeSnapshot).toHaveBeenCalledWith(
      category,
      snapshot,
      resolved
    );
  });
});

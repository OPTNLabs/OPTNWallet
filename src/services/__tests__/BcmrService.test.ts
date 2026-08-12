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
  queryAuthHead: vi.fn(),
  queryTransactionByHash: vi.fn(),
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
import { sha256 } from '../../utils/hash';
import {
  queryAuthHead,
  queryTransactionByHash,
} from '../../apis/ChaingraphManager/ChaingraphManager';

describe('BcmrService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tries multiple on-chain BCMR URIs until one matches the published hash', async () => {
    const service = new BcmrService() as unknown as {
      resolveAuthChainRegistry: (
        authbase: string,
        fallbackUri: string
      ) => Promise<unknown>;
      resolveAuthChain: ReturnType<typeof vi.fn>;
      commitIdentityRegistry: ReturnType<typeof vi.fn>;
    };

    const registryJson =
      '{"$schema":"https://cashtokens.org/bcmr-v2.schema.json","version":{"major":0,"minor":0,"patch":0},"latestRevision":"2026-04-10T00:00:00.000Z","registryIdentity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","identities":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"2026-04-10T00:00:00.000Z":{"name":"Token","token":{"category":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","symbol":"TOK","decimals":0}}}}}';
    const registryHash = sha256.text(registryJson);

    service.resolveAuthChain = vi.fn().mockResolvedValue([
      {
        outputs: [
          {
            scriptPubKey: {
              hex: `6a0442434d5220${registryHash}0a697066733a2f2f6261640b697066733a2f2f676f6f64`,
            },
          },
        ],
      },
    ]);
    service.commitIdentityRegistry = vi
      .fn()
      .mockImplementation(async (_authbase: string, registry: unknown, uri: string) => ({
        registry,
        registryUri: uri,
      }));

    vi.mocked(ipfsFetch)
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(registryJson, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    const result = await service.resolveAuthChainRegistry(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'ipfs://fallback'
    );

    expect(ipfsFetch).toHaveBeenCalledTimes(2);
    expect(ipfsFetch).toHaveBeenNthCalledWith(1, 'ipfs://bad');
    expect(ipfsFetch).toHaveBeenNthCalledWith(2, 'ipfs://good');
    expect(result).toMatchObject({ registryUri: 'ipfs://good' });
  });

  it('walks backward through the authchain until it finds a BCMR publication', async () => {
    const service = new BcmrService() as unknown as {
      resolveAuthChainRegistry: (
        authbase: string,
        fallbackUri: string
      ) => Promise<unknown>;
      resolveAuthChain: ReturnType<typeof vi.fn>;
      commitIdentityRegistry: ReturnType<typeof vi.fn>;
    };

    const registryJson =
      '{"$schema":"https://cashtokens.org/bcmr-v2.schema.json","version":{"major":0,"minor":0,"patch":0},"latestRevision":"2026-04-10T00:00:00.000Z","registryIdentity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","identities":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"2026-04-10T00:00:00.000Z":{"name":"Token","token":{"category":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","symbol":"TOK","decimals":0}}}}}';
    const registryHash = sha256.text(registryJson);

    service.resolveAuthChain = vi.fn().mockResolvedValue([
      {
        hash: 'head',
        outputs: [{ scriptPubKey: { hex: '76a91400' } }],
      },
      {
        hash: 'previous',
        outputs: [
          {
            scriptPubKey: {
              hex: `6a0442434d5220${registryHash}0b697066733a2f2f676f6f64`,
            },
          },
        ],
      },
    ]);
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

    const result = await service.resolveAuthChainRegistry(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'ipfs://fallback'
    );

    expect(ipfsFetch).toHaveBeenCalledWith('ipfs://good');
    expect(result).toMatchObject({ registryUri: 'ipfs://good' });
  });

  it('parses the confirmed BCMR OP_RETURN shape emitted by mint transactions', async () => {
    const service = new BcmrService() as unknown as {
      parseBcmrOutput: (scriptHex: string) => { hash: string; uris: string[] };
    };

    const parsed = service.parseBcmrOutput(
      '6a0442434d52201af0d0c37fc4176d667dc033e0994c6dfe0a1fdf8c172b259b2f4364434b1ea335697066733a2f2f516d535855374858774c37746e4c6d6f714a337144545550586b59756e4a7659546648776659634a466f636f6b43'
    );

    expect(parsed.hash).toBe(
      '1af0d0c37fc4176d667dc033e0994c6dfe0a1fdf8c172b259b2f4364434b1ea3'
    );
    expect(parsed.uris).toEqual([
      'ipfs://QmSXU7HXwL7tnLmoqJ3qDTUPXkYunJvYTfHwfYcJFocokC',
    ]);
  });

  it('searches all vout-0 parent branches when resolving authchain BCMR', async () => {
    const service = new BcmrService() as unknown as {
      resolveAuthChainRegistry: (
        authbase: string,
        fallbackUri: string
      ) => Promise<unknown>;
      commitIdentityRegistry: ReturnType<typeof vi.fn>;
    };

    const registryJson =
      '{"$schema":"https://cashtokens.org/bcmr-v2.schema.json","version":{"major":0,"minor":0,"patch":0},"latestRevision":"2026-04-10T00:00:00.000Z","registryIdentity":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","identities":{"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc":{"2026-04-10T00:00:00.000Z":{"name":"Branch Token","token":{"category":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","symbol":"BR","decimals":0}}}}}';
    const registryHash = sha256.text(registryJson);

    vi.mocked(queryAuthHead).mockResolvedValue({
      data: {
        transaction: [
          {
            authchains: [
              {
                authhead: {
                  identity_output: [{ transaction_hash: 'headtx' }],
                },
              },
            ],
          },
        ],
      },
    });

    vi.mocked(queryTransactionByHash).mockImplementation(async (txid: string) => {
      if (txid === 'headtx') {
        return {
          data: {
            transaction: [
              {
                hash: 'headtx',
                inputs: [
                  { outpoint_transaction_hash: 'wrongparent', outpoint_index: '0' },
                  { outpoint_transaction_hash: 'rightparent', outpoint_index: '0' },
                ],
                outputs: [{ locking_bytecode: '76a91400' }],
              },
            ],
          },
        };
      }

      if (txid === 'wrongparent') {
        return {
          data: {
            transaction: [
              {
                hash: 'wrongparent',
                inputs: [],
                outputs: [{ locking_bytecode: '76a91401' }],
              },
            ],
          },
        };
      }

      if (txid === 'rightparent') {
        return {
          data: {
            transaction: [
              {
                hash: 'rightparent',
                inputs: [],
                outputs: [
                  {
                    locking_bytecode: `6a0442434d5220${registryHash}0d697066733a2f2f6272616e6368`,
                  },
                ],
              },
            ],
          },
        };
      }

      return { data: { transaction: [] } };
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

    const result = await service.resolveAuthChainRegistry(
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      'ipfs://fallback'
    );

    expect(queryTransactionByHash).toHaveBeenCalledWith('wrongparent');
    expect(queryTransactionByHash).toHaveBeenCalledWith('rightparent');
    expect(ipfsFetch).toHaveBeenCalledWith('ipfs://branch');
    expect(result).toMatchObject({ registryUri: 'ipfs://branch' });
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

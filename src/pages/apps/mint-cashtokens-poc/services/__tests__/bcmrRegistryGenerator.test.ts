import { describe, expect, it } from 'vitest';
import { importMetadataRegistry } from '@bitauth/libauth';

import {
  BcmrRegistryError,
  bcmrSymbolProblem,
  defaultParseBytecode,
  generateBcmrRegistry,
  generateBcmrRegistryJson,
  ipfsCidOf,
  parsableNftCommitment,
  sequentialNftCommitment,
  suggestBcmrIdentity,
  type BcmrGeneratorInput,
} from '../bcmrRegistryGenerator';
import {
  lookupSequentialNftType,
  minimallyEncodeVmNumber,
  parseNftCommitment,
  type NftParseInfo,
} from '../../../../../services/nftParsing/nftParsing';

// The registry itself is written by crates/optn-core/src/bcmr_author.rs, which
// has its own unit tests. These tests hold that output against readers that
// share none of its code: libauth's registry importer and the wallet's own NFT
// parser, which evaluates parse bytecode in the BCH 2026 VM.

const CATEGORY = 'ab12cd34'.repeat(8);
const REVISION = '2026-09-25T12:00:00.000Z';
const CHIPNET_SPLIT =
  '00000000040ba9641ba98a37b2e5ceead38e4e2930ac8f145c8094f94c708727';
const MAINNET_SPLIT =
  '0000000000000000029e471c41818d24b8b74c911071c4ef0b4a0509f9b5a8ce';

type Snapshot = {
  name: string;
  description: string;
  status: string;
  splitId: string;
  tags: string[];
  uris: Record<string, string>;
  extensions: Record<string, unknown>;
  token: {
    category: string;
    symbol: string;
    decimals: number;
    nfts?: {
      description: string;
      fields: Record<string, Record<string, unknown>>;
      parse: {
        bytecode?: string;
        types: Record<string, { name: string; fields?: string[] }>;
      };
    };
  };
};

type Registry = {
  $schema: string;
  version: { major: number; minor: number; patch: number };
  latestRevision: string;
  registryIdentity: unknown;
  defaultChain: string;
  chains: object;
  tags: object;
  extensions: object;
  identities: Record<string, Record<string, Snapshot>>;
  [key: string]: unknown;
};

function input(
  overrides: Partial<BcmrGeneratorInput> = {}
): BcmrGeneratorInput {
  return {
    network: 'chipnet',
    authbase: CATEGORY,
    tokenCategory: CATEGORY,
    tokenName: 'Token ab12cd',
    tokenSymbol: 'TAB12C',
    tokenDecimals: 0,
    latestRevision: REVISION,
    ...overrides,
  };
}

function registryOf(json: string): Registry {
  return JSON.parse(json) as Registry;
}

function snapshotOf(json: string): Snapshot {
  return registryOf(json).identities[CATEGORY][REVISION];
}

function parseInfoOf(snapshot: Snapshot): NftParseInfo {
  const nfts = snapshot.token.nfts!;
  return {
    bytecode: nfts.parse.bytecode ?? '',
    types: nfts.parse.types,
    fields: nfts.fields as NftParseInfo['fields'],
  };
}

function thrown(run: () => unknown): BcmrRegistryError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BcmrRegistryError);
    return error as BcmrRegistryError;
  }
  throw new Error('expected a BcmrRegistryError');
}

describe('bcmrRegistryGenerator', () => {
  it('writes the full skeleton for a fungible token, and libauth imports it', () => {
    const authored = generateBcmrRegistry(input());
    expect(typeof importMetadataRegistry(authored.registryJson)).not.toBe(
      'string'
    );

    const registry = registryOf(authored.registryJson);
    expect(registry.$schema).toBe('https://cashtokens.org/bcmr-v2.schema.json');
    expect(registry.version).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(registry.latestRevision).toBe(REVISION);
    expect(registry.registryIdentity).toBe(CATEGORY);
    expect(registry.defaultChain).toBe(CHIPNET_SPLIT);
    expect(registry.chains).toEqual({});
    expect(registry.tags).toEqual({});
    expect(registry.extensions).toEqual({});
    expect(registry).not.toHaveProperty('locales');

    const snapshot = snapshotOf(authored.registryJson);
    expect(snapshot).toMatchObject({
      name: 'Token ab12cd',
      description: '',
      status: 'active',
      splitId: CHIPNET_SPLIT,
      tags: [],
      uris: {},
      extensions: {},
      token: { category: CATEGORY, symbol: 'TAB12C', decimals: 0 },
    });
    expect(snapshot).not.toHaveProperty('migrated');
    expect(snapshot.token).not.toHaveProperty('nfts');
  });

  it('names mainnet on mainnet, so a chipnet token never claims mainnet', () => {
    const snapshot = snapshotOf(
      generateBcmrRegistryJson(input({ network: 'mainnet' }))
    );
    expect(snapshot.splitId).toBe(MAINNET_SPLIT);
    expect(
      registryOf(generateBcmrRegistryJson(input({ network: 'mainnet' })))
        .defaultChain
    ).toBe(MAINNET_SPLIT);
  });

  it('reports the hash and a CID that IPFS derives from the same bytes', () => {
    const authored = generateBcmrRegistry(input());
    expect(authored.ipfsCid).toMatch(/^bafkrei[a-z2-7]{52}$/);
    expect(authored.ipfsUri).toBe(`ipfs://${authored.ipfsCid}`);
    expect(ipfsCidOf(authored.registryJson)).toBe(authored.ipfsCid);
    expect(authored.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The same input always produces the same bytes, hash and link.
    expect(generateBcmrRegistry(input())).toEqual(authored);
  });

  it('keeps icon and site links', () => {
    const snapshot = snapshotOf(
      generateBcmrRegistryJson(
        input({
          iconUri: 'ipfs://bafkreiicon',
          webUri: 'https://example.org/project',
        })
      )
    );
    expect(snapshot.uris).toEqual({
      icon: 'ipfs://bafkreiicon',
      web: 'https://example.org/project',
    });
  });

  it('prefills a parsable collection that the wallet parser reads', () => {
    const snapshot = snapshotOf(
      generateBcmrRegistryJson(input({ nfts: { kind: 'parsable' } }))
    );
    const nfts = snapshot.token.nfts!;
    expect(nfts.parse.bytecode).toBe('00cf517f7c6b6b');
    expect(nfts.parse.bytecode).toBe(defaultParseBytecode());
    expect(nfts.parse.types['00']).toMatchObject({
      name: 'Token ab12cd',
      fields: ['serial'],
    });

    const info = parseInfoOf(snapshot);
    for (const serial of [0, 1, 127, 128, 255, 256, 70_000]) {
      const commitment = parsableNftCommitment(serial);
      const result = parseNftCommitment({ commitment }, info);
      expect(result.success, `serial ${serial}`).toBe(true);
      if (!result.success) continue;
      expect(result.nftTypeKey).toBe('00');
      expect(result.nftTypeName).toBe('Token ab12cd');
      const [field] = result.fields;
      expect(field.fieldId).toBe('serial');
      expect(field.parsedValue).toMatchObject({
        type: 'number',
        value: BigInt(serial),
      });
    }
  });

  it('encodes sequential numbers exactly as the wallet parser expects', () => {
    for (const n of [0, 1, 127, 128, 200, 255, 256, 300, 32_767, 32_768, 1e6]) {
      expect(sequentialNftCommitment(n), `#${n}`).toBe(
        minimallyEncodeVmNumber(BigInt(n))
      );
    }
    expect(sequentialNftCommitment(128)).toBe('8000');
    expect(parsableNftCommitment(128)).toBe('008000');
  });

  it('writes a sequential collection without any bytecode', () => {
    const types = {
      [sequentialNftCommitment(1)]: { name: '#1' },
      [sequentialNftCommitment(128)]: { name: '#128' },
    };
    const json = generateBcmrRegistryJson(
      input({ nfts: { kind: 'sequential', types } })
    );
    expect(json).not.toContain('bytecode');
    const snapshot = snapshotOf(json);
    expect(snapshot.token.nfts?.fields).toEqual({});

    const info = parseInfoOf(snapshot);
    const result = lookupSequentialNftType('8000', info);
    expect(result.success).toBe(true);
    if (result.success) expect(result.nftTypeName).toBe('#128');
  });

  it('carries custom fields and moves layout notes under extensions', () => {
    const json = generateBcmrRegistryJson(
      input({
        nfts: {
          kind: 'parsable',
          description: 'Pledge receipts with an on-chain value field.',
          bytecode: '006b00cf6b',
          fields: {
            pledgeValue: {
              name: 'Pledge Value',
              encoding: {
                type: 'number',
                aggregate: 'add',
                decimals: 8,
                unit: 'BCH',
              },
              offset: '1',
              byteLength: '4',
            },
          },
          types: {
            '': { name: 'Pledge Receipt', fields: ['pledgeValue'] },
          },
        },
      })
    );
    const nfts = snapshotOf(json).token.nfts!;
    expect(nfts.description).toBe(
      'Pledge receipts with an on-chain value field.'
    );
    expect(nfts.parse.bytecode).toBe('006b00cf6b');
    expect(nfts.parse.types[''].fields).toEqual(['pledgeValue']);
    expect(nfts.fields.pledgeValue).toEqual({
      name: 'Pledge Value',
      encoding: { type: 'number', aggregate: 'add', decimals: 8, unit: 'BCH' },
      extensions: { offset: '1', byteLength: '4' },
    });
    expect(typeof importMetadataRegistry(json)).not.toBe('string');
  });

  it('extends a base registry with a minor version bump', () => {
    const baseRegistry = {
      $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
      version: { major: 0, minor: 2, patch: 4 },
      latestRevision: '2026-01-01T00:00:00.000Z',
      registryIdentity: CATEGORY,
      identities: {
        ['b'.repeat(64)]: {
          '2026-01-01T00:00:00.000Z': {
            name: 'Older Token',
            token: { category: 'b'.repeat(64), symbol: 'OLD', decimals: 0 },
          },
        },
      },
    };
    const registry = registryOf(
      generateBcmrRegistryJson(input({ baseRegistry }))
    );
    expect(registry.version).toEqual({ major: 0, minor: 3, patch: 0 });
    expect(
      registry.identities['b'.repeat(64)]['2026-01-01T00:00:00.000Z'].name
    ).toBe('Older Token');
    expect(registry.identities[CATEGORY][REVISION].name).toBe('Token ab12cd');
  });

  it('names the field each rejection is about', () => {
    expect(
      thrown(() => generateBcmrRegistry(input({ tokenSymbol: 'tka' }))).field
    ).toBe('tokenSymbol');
    expect(
      thrown(() => generateBcmrRegistry(input({ tokenName: ' ' }))).field
    ).toBe('tokenName');
    expect(
      thrown(() => generateBcmrRegistry(input({ tokenDecimals: 19 }))).field
    ).toBe('tokenDecimals');
    expect(
      thrown(() => generateBcmrRegistry(input({ tokenDecimals: 1.5 }))).field
    ).toBe('tokenDecimals');
    expect(
      thrown(() => generateBcmrRegistry(input({ tokenCategory: 'xyz' }))).field
    ).toBe('tokenCategory');
    expect(
      thrown(() => generateBcmrRegistry(input({ iconUri: 'icon.png' }))).field
    ).toBe('iconUri');
    expect(
      thrown(() =>
        generateBcmrRegistry(
          input({ nfts: { kind: 'parsable', bytecode: '' } })
        )
      ).field
    ).toBe('nftBytecode');
    expect(
      thrown(() =>
        generateBcmrRegistry(
          input({ nfts: { kind: 'parsable', bytecode: 'zz' } })
        )
      ).field
    ).toBe('nftBytecode');
    expect(
      thrown(() =>
        generateBcmrRegistry(
          input({
            nfts: { kind: 'sequential', types: { xyz: { name: 'Bad' } } },
          })
        )
      ).field
    ).toBe('nftTypes');
    expect(
      thrown(() =>
        generateBcmrRegistry(
          input({
            nfts: {
              kind: 'parsable',
              fields: {
                f: { encoding: { type: 'number', decimals: 20 } },
              },
            },
          })
        )
      ).field
    ).toBe('nftFields');
    expect(
      thrown(() =>
        generateBcmrRegistry(
          input({
            nfts: {
              kind: 'parsable',
              fields: {
                f: { encoding: { type: 'number' }, byteLength: 'waffle' },
              },
            },
          })
        )
      ).message
    ).toContain('byteLength must be an integer or "variable"');
  });

  it('suggests a unique default identity and validates symbols', () => {
    expect(suggestBcmrIdentity(CATEGORY, false)).toEqual({
      name: 'Token ab12cd',
      symbol: 'TAB12C',
    });
    expect(suggestBcmrIdentity(CATEGORY, true).name).toBe('Collection ab12cd');
    expect(bcmrSymbolProblem('TAB12C')).toBeUndefined();
    expect(bcmrSymbolProblem('XAMPL-A')).toBeUndefined();
    expect(bcmrSymbolProblem('')).toMatch(/capital letters/);
    expect(bcmrSymbolProblem('-ABC')).toMatch(/capital letters/);
  });

  it('refuses numbers the WASM boundary would silently wrap', () => {
    expect(() => sequentialNftCommitment(-1)).toThrow(BcmrRegistryError);
    expect(() => sequentialNftCommitment(1.5)).toThrow(BcmrRegistryError);
    expect(() => sequentialNftCommitment(2 ** 32)).toThrow(BcmrRegistryError);
    expect(() => parsableNftCommitment(1, 256)).toThrow(BcmrRegistryError);
  });
});

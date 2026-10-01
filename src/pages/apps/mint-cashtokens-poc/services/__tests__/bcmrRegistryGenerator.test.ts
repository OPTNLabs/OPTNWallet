import { describe, expect, it } from 'vitest';

import { generateBcmrRegistryJson } from '../bcmrRegistryGenerator';
import {
  importMetadataRegistry,
  type MetadataRegistry,
} from '@bitauth/libauth';
import { createHash } from 'node:crypto';
import {
  bcmrAuthorRegistry,
  bcmrReadPublication,
} from '../../../../../wasm/optn-core';
import { buildBcmrPublicationOpReturn } from '../bcmrOpReturn';

describe('bcmrRegistryGenerator', () => {
  it.each(['mainnet', 'chipnet', 'regtest'] as const)(
    'publishes the exact Rust-authored bytes for the selected %s network',
    async (network) => {
      const category = 'ab'.repeat(32);
      const revision = '2026-09-30T00:00:00.000Z';
      const json = generateBcmrRegistryJson({
        network,
        authbase: category,
        tokenCategory: category,
        tokenName: 'Demo',
        tokenSymbol: 'DEMO',
        tokenDecimals: 0,
        latestRevision: revision,
        nfts: { parse: { types: { '8000': { name: '#128' } } } },
      });
      const authored = JSON.parse(
        bcmrAuthorRegistry(
          JSON.stringify({
            network,
            revision,
            identity: {
              authbase: category,
              category,
              name: 'Demo',
              symbol: 'DEMO',
              nfts: {
                kind: 'schema',
                parse: { types: { '8000': { name: '#128' } } },
              },
            },
          })
        )
      ) as { registryJson: string; sha256: string; ipfsUri: string };
      expect(json).toBe(authored.registryJson);
      const uploaded = new Uint8Array(
        await new Blob([json], { type: 'application/json' }).arrayBuffer()
      );
      expect(createHash('sha256').update(uploaded).digest('hex')).toBe(
        authored.sha256
      );
      const publication = buildBcmrPublicationOpReturn({
        registryJson: json,
        uris: [authored.ipfsUri],
      });
      expect(
        JSON.parse(
          bcmrReadPublication(Buffer.from(publication.scriptHex, 'hex'))!
        )
      ).toEqual({
        sha256: authored.sha256,
        uris: [authored.ipfsUri],
      });
      expect(typeof importMetadataRegistry(json)).toBe('object');
    }
  );

  it('generates a v2 registry with one identity snapshot', () => {
    const json = generateBcmrRegistryJson({
      network: 'mainnet',
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenSymbol: 'TKA',
      tokenDecimals: 2,
      iconUri: 'ipfs://bafyicon',
      latestRevision: '2026-01-01T00:00:00.000Z',
    });

    const parsed = JSON.parse(json) as {
      $schema: string;
      registryIdentity: string;
      identities: Record<string, Record<string, { token: { symbol: string } }>>;
    };

    expect(parsed.$schema).toBe('https://cashtokens.org/bcmr-v2.schema.json');
    expect(parsed.registryIdentity).toBe('a'.repeat(64));
    expect(
      parsed.identities['a'.repeat(64)]['2026-01-01T00:00:00.000Z'].token.symbol
    ).toBe('TKA');
  });

  it('includes web URI when provided', () => {
    const json = generateBcmrRegistryJson({
      network: 'mainnet',
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenSymbol: 'TKA',
      tokenDecimals: 2,
      webUri: 'https://example.org/project',
      latestRevision: '2026-01-01T00:00:00.000Z',
    });
    const parsed = JSON.parse(json) as {
      identities: Record<
        string,
        Record<string, { uris?: Record<string, string> }>
      >;
    };
    expect(
      parsed.identities['a'.repeat(64)]['2026-01-01T00:00:00.000Z'].uris?.web
    ).toBe('https://example.org/project');
  });

  it('generates JSON accepted by BCMR schema validator', () => {
    const json = generateBcmrRegistryJson({
      network: 'mainnet',
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenSymbol: 'TKA',
      tokenDecimals: 2,
      latestRevision: '2026-01-01T00:00:00.000Z',
    });
    const imported = importMetadataRegistry(json);
    expect(typeof imported).not.toBe('string');
  });

  it('throws if required values are missing', () => {
    expect(() =>
      generateBcmrRegistryJson({
        network: 'mainnet',
        authbase: '',
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
      })
    ).toThrow('Authbase must be 64 hex characters.');
  });

  it('throws for invalid hex ids', () => {
    expect(() =>
      generateBcmrRegistryJson({
        network: 'mainnet',
        authbase: 'xyz',
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
      })
    ).toThrow('Authbase must be 64 hex characters.');
  });

  it('merges prior identities into the next registry publication', () => {
    const baseRegistry: MetadataRegistry = {
      $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
      version: { major: 0, minor: 0, patch: 4 },
      latestRevision: '2026-01-01T00:00:00.000Z',
      registryIdentity: 'a'.repeat(64),
      identities: {
        ['b'.repeat(64)]: {
          '2026-01-01T00:00:00.000Z': {
            name: 'Older Token',
            description: 'Old description',
            token: {
              category: 'b'.repeat(64),
              symbol: 'OLD',
              decimals: 0,
            },
            uris: {
              icon: 'ipfs://older-icon',
            },
          },
        },
      },
    };

    const json = generateBcmrRegistryJson({
      network: 'mainnet',
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenDescription: 'Current description',
      tokenSymbol: 'TKA',
      tokenDecimals: 2,
      iconUri: 'ipfs://bafyicon',
      latestRevision: '2026-02-01T00:00:00.000Z',
      baseRegistry,
    });

    const parsed = JSON.parse(json) as {
      version: { minor: number; patch: number };
      identities: Record<string, Record<string, { name: string }>>;
    };

    expect(parsed.version).toMatchObject({ minor: 1, patch: 0 });
    expect(
      parsed.identities['b'.repeat(64)]['2026-01-01T00:00:00.000Z'].name
    ).toBe('Older Token');
    expect(
      parsed.identities['a'.repeat(64)]['2026-02-01T00:00:00.000Z'].name
    ).toBe('Token A');
  });

  it('emits an nfts schema block for parsable NFT categories', () => {
    const json = generateBcmrRegistryJson({
      network: 'mainnet',
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenSymbol: 'TKA',
      tokenDecimals: 0,
      latestRevision: '2026-01-01T00:00:00.000Z',
      nfts: {
        description: 'Pledge receipts with an on-chain value field.',
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
        parse: {
          bytecode: '006b00cf6b',
          types: {
            '': {
              name: 'Pledge Receipt',
              description: 'A crowdfunding pledge.',
              fields: ['pledgeValue'],
            },
          },
        },
      },
    });

    const parsed = JSON.parse(json) as {
      identities: Record<
        string,
        Record<
          string,
          {
            token: {
              nfts: {
                description: string;
                fields: Record<string, { encoding: { type: string } }>;
                parse: {
                  bytecode: string;
                  types: Record<string, { name: string; fields: string[] }>;
                };
              };
            };
          }
        >
      >;
    };
    const nfts =
      parsed.identities['a'.repeat(64)]['2026-01-01T00:00:00.000Z'].token.nfts;

    expect(nfts.description).toBe(
      'Pledge receipts with an on-chain value field.'
    );
    expect(nfts.parse.bytecode).toBe('006b00cf6b');
    expect(nfts.parse.types[''].name).toBe('Pledge Receipt');
    expect(nfts.parse.types[''].fields).toEqual(['pledgeValue']);
    expect(nfts.fields.pledgeValue.encoding).toMatchObject({
      type: 'number',
      aggregate: 'add',
      decimals: 8,
      unit: 'BCH',
    });
  });

  it('always emits the nfts block for NFT categories, even when empty', () => {
    const json = generateBcmrRegistryJson({
      network: 'mainnet',
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenSymbol: 'TKA',
      tokenDecimals: 0,
      latestRevision: '2026-01-01T00:00:00.000Z',
      nfts: { parse: {} },
    });

    const parsed = JSON.parse(json) as {
      identities: Record<
        string,
        Record<string, { token: { nfts: { parse: { types: object } } } }>
      >;
    };
    const nfts =
      parsed.identities['a'.repeat(64)]['2026-01-01T00:00:00.000Z'].token.nfts;
    expect(nfts.parse.types).toEqual({});
    expect(JSON.stringify(parsed)).not.toContain('bytecode');

    const imported = importMetadataRegistry(json);
    expect(typeof imported).not.toBe('string');
  });

  it('omits bytecode for sequential NFT collections', () => {
    const json = generateBcmrRegistryJson({
      network: 'mainnet',
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenSymbol: 'TKA',
      tokenDecimals: 0,
      latestRevision: '2026-01-01T00:00:00.000Z',
      nfts: {
        parse: {
          types: {
            '8000': { name: '#128' },
            '0001': { name: '#256' },
          },
        },
      },
    });

    const parsed = JSON.parse(json) as {
      identities: Record<
        string,
        Record<
          string,
          {
            token: {
              nfts: { parse: { types: Record<string, { name: string }> } };
            };
          }
        >
      >;
    };
    const nfts =
      parsed.identities['a'.repeat(64)]['2026-01-01T00:00:00.000Z'].token.nfts;
    expect(nfts.parse.types['8000'].name).toBe('#128');
    expect(nfts.parse.types['0001'].name).toBe('#256');

    const imported = importMetadataRegistry(json);
    expect(typeof imported).not.toBe('string');
  });

  it('merges base registry nfts types, fields and bytecode into the next snapshot', () => {
    const baseRegistry: MetadataRegistry = {
      $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
      version: { major: 0, minor: 0, patch: 4 },
      latestRevision: '2026-01-01T00:00:00.000Z',
      registryIdentity: 'a'.repeat(64),
      identities: {
        ['a'.repeat(64)]: {
          '2026-01-01T00:00:00.000Z': {
            name: 'Token A',
            token: {
              category: 'a'.repeat(64),
              symbol: 'TKA',
              decimals: 0,
              nfts: {
                description: 'Existing description',
                fields: {
                  serial: { encoding: { type: 'number' } },
                },
                parse: {
                  bytecode: '006b00cf6b',
                  types: {
                    '': { name: 'Existing Type' },
                  },
                },
              },
            },
          },
        },
      },
    };

    const json = generateBcmrRegistryJson({
      network: 'mainnet',
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenSymbol: 'TKA',
      tokenDecimals: 0,
      latestRevision: '2026-02-01T00:00:00.000Z',
      baseRegistry,
      nfts: {
        parse: {
          types: {
            '01': { name: 'New Type' },
          },
        },
      },
    });

    const parsed = JSON.parse(json) as {
      identities: Record<
        string,
        Record<
          string,
          {
            token: {
              nfts: {
                description: string;
                fields: Record<string, object>;
                parse: {
                  bytecode: string;
                  types: Record<string, { name: string }>;
                };
              };
            };
          }
        >
      >;
    };
    const nfts =
      parsed.identities['a'.repeat(64)]['2026-02-01T00:00:00.000Z'].token.nfts;

    expect(nfts.description).toBe('Existing description');
    expect(nfts.parse.bytecode).toBe('006b00cf6b');
    expect(Object.keys(nfts.fields)).toEqual(['serial']);
    expect(Object.keys(nfts.parse.types)).toEqual(['', '01']);
    expect(nfts.parse.types[''].name).toBe('Existing Type');
    expect(nfts.parse.types['01'].name).toBe('New Type');

    const imported = importMetadataRegistry(json);
    expect(typeof imported).not.toBe('string');
  });

  it('throws for invalid NFT schema input', () => {
    expect(() =>
      generateBcmrRegistryJson({
        network: 'mainnet',
        authbase: 'a'.repeat(64),
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
        nfts: { parse: { bytecode: 'zz' } },
      })
    ).toThrow('Parse bytecode must be even-length hex.');

    expect(() =>
      generateBcmrRegistryJson({
        network: 'mainnet',
        authbase: 'a'.repeat(64),
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
        nfts: { parse: { types: { xyz: { name: 'Bad' } } } },
      })
    ).toThrow('NFT type key "xyz" must be even-length hex.');

    expect(() =>
      generateBcmrRegistryJson({
        network: 'mainnet',
        authbase: 'a'.repeat(64),
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
        nfts: { parse: { types: { '01': { name: '' } } } },
      })
    ).toThrow('NFT type "01" needs a name.');

    expect(() =>
      generateBcmrRegistryJson({
        network: 'mainnet',
        authbase: 'a'.repeat(64),
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
        nfts: {
          parse: {},
          fields: {
            f: { encoding: { type: 'number', decimals: 20 } },
          },
        },
      })
    ).toThrow('decimals must be an integer between 0 and 18');

    expect(() =>
      generateBcmrRegistryJson({
        network: 'mainnet',
        authbase: 'a'.repeat(64),
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
        nfts: {
          parse: {},
          fields: {
            f: { encoding: { type: 'number' }, byteLength: 'waffle' },
          },
        },
      })
    ).toThrow('byteLength must be an integer or "variable"');
  });
});

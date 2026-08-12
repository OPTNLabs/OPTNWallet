import { describe, expect, it } from 'vitest';

import { generateBcmrRegistryJson } from '../bcmrRegistryGenerator';
import { importMetadataRegistry } from '@bitauth/libauth';

describe('bcmrRegistryGenerator', () => {
  it('generates a v2 registry with one identity snapshot', () => {
    const json = generateBcmrRegistryJson({
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
      authbase: 'a'.repeat(64),
      tokenCategory: 'a'.repeat(64),
      tokenName: 'Token A',
      tokenSymbol: 'TKA',
      tokenDecimals: 2,
      webUri: 'https://example.org/project',
      latestRevision: '2026-01-01T00:00:00.000Z',
    });
    const parsed = JSON.parse(json) as {
      identities: Record<string, Record<string, { uris?: Record<string, string> }>>;
    };
    expect(
      parsed.identities['a'.repeat(64)]['2026-01-01T00:00:00.000Z'].uris?.web
    ).toBe('https://example.org/project');
  });

  it('generates JSON accepted by BCMR schema validator', () => {
    const json = generateBcmrRegistryJson({
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
        authbase: '',
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
      })
    ).toThrow('Authbase is required.');
  });

  it('throws for invalid hex ids', () => {
    expect(() =>
      generateBcmrRegistryJson({
        authbase: 'xyz',
        tokenCategory: 'a'.repeat(64),
        tokenName: 'Token A',
        tokenSymbol: 'TKA',
        tokenDecimals: 0,
      })
    ).toThrow('Authbase must be 64 hex characters.');
  });

  it('merges prior identities into the next registry publication', () => {
    const baseRegistry = {
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
      version: { patch: number };
      identities: Record<string, Record<string, { name: string }>>;
    };

    expect(parsed.version.patch).toBe(5);
    expect(
      parsed.identities['b'.repeat(64)]['2026-01-01T00:00:00.000Z'].name
    ).toBe('Older Token');
    expect(
      parsed.identities['a'.repeat(64)]['2026-02-01T00:00:00.000Z'].name
    ).toBe('Token A');
  });
});

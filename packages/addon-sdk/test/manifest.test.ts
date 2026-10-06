import { describe, expect, it } from 'vitest';
import { defineAddon, validateAddonManifest } from '../src';

const manifest = {
  id: 'example.addon',
  name: 'Example Add-on',
  version: '1.0.0',
  permissions: [
    {
      kind: 'capabilities' as const,
      capabilities: ['wallet:context:read' as const],
    },
  ],
  contracts: [],
};

describe('addon manifest contract', () => {
  it('accepts a bounded public manifest through defineAddon', () => {
    expect(
      defineAddon({
        manifest,
        mount: () => ({}),
      }).manifest
    ).toEqual(manifest);
  });

  it('rejects host-private trust and unsafe capabilities', () => {
    expect(() =>
      validateAddonManifest({
        ...manifest,
        trustTier: 'internal',
      })
    ).toThrow(/host-private/i);
    expect(() =>
      validateAddonManifest({
        ...manifest,
        permissions: [{ kind: 'capabilities', capabilities: ['tx:build'] }],
      })
    ).toThrow(/capability/i);
  });

  it('accepts ABI-shaped CashScript contract declarations and rejects malformed ones', () => {
    const artifact = {
      contractName: 'Demo',
      constructorInputs: [],
      abi: [{ name: 'spend', inputs: [] }],
      bytecode: 'OP_TRUE',
      compiler: { name: 'cashc', version: '0.14.0-next' },
    };
    expect(() => validateAddonManifest({ ...manifest, contracts: [{ id: 'demo', artifact }] })).not.toThrow();
    expect(() =>
      validateAddonManifest({
        ...manifest,
        contracts: [{ id: 'private-contract' }],
      })
    ).toThrow(/artifact/i);
  });

  it('rejects wildcard, local, and duplicate HTTP domains', () => {
    for (const domains of [
      ['*.example.com'],
      ['localhost'],
      ['example.com', 'example.com'],
    ]) {
      expect(() =>
        validateAddonManifest({
          ...manifest,
          permissions: [{ kind: 'http', domains }],
        })
      ).toThrow();
    }
  });
});

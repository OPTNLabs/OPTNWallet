import { describe, expect, it } from 'vitest';

import type { AddonManifest } from '../../../types/addons';
import type { UTXO } from '../../../types/types';
import {
  findAddonContract,
  normalizeAddonKey,
  outpointKey,
  parseJsonOr,
  reviveUnlockFunctions,
  serializeUnlockFunctions,
  toStoredContractUtxo,
} from '../helpers';

const demoManifest: AddonManifest = {
  id: 'addon.one',
  name: 'Addon One',
  version: '1.0.0',
  permissions: [{ kind: 'none' }],
  contracts: [
    {
      id: 'escrow',
      name: 'Escrow',
      cashscriptArtifact: {},
      functions: [],
    },
  ],
};

const secondManifest: AddonManifest = {
  id: 'addon.two',
  name: 'Addon Two',
  version: '1.0.0',
  permissions: [{ kind: 'none' }],
  contracts: [
    {
      id: 'vault',
      name: 'Vault',
      cashscriptArtifact: {},
      functions: [],
    },
  ],
};

describe('ContractManager/helpers', () => {
  it('parseJsonOr parses valid json and falls back on invalid/non-string input', () => {
    expect(parseJsonOr('{"a":1}', { a: 0 })).toEqual({ a: 1 });
    expect(parseJsonOr('{bad', { ok: true })).toEqual({ ok: true });
    expect(parseJsonOr(123, ['x'])).toEqual(['x']);
  });

  it('normalizeAddonKey parses addon-prefixed keys', () => {
    expect(normalizeAddonKey('plain-key')).toBeNull();
    expect(normalizeAddonKey('addon:escrow')).toEqual({ contractId: 'escrow' });
    expect(normalizeAddonKey('addon:addon.one:escrow')).toEqual({
      addonId: 'addon.one',
      contractId: 'escrow',
    });
    expect(normalizeAddonKey('addon:')).toBeNull();
  });

  it('findAddonContract resolves scoped and unscoped addon contracts', () => {
    const manifests = [demoManifest, secondManifest];

    expect(findAddonContract(manifests, 'addon.one', 'escrow')?.id).toBe(
      'escrow'
    );
    expect(findAddonContract(manifests, undefined, 'vault')?.id).toBe('vault');
    expect(findAddonContract(manifests, 'addon.one', 'vault')).toBeNull();
  });

  it('serializeUnlockFunctions and reviveUnlockFunctions roundtrip functions', () => {
    const unlock = {
      addOne: (n: number) => n + 1,
      concat: (a: string, b: string) => `${a}:${b}`,
    };

    const serialized = serializeUnlockFunctions(unlock);
    expect(typeof serialized.addOne).toBe('string');

    const revived = reviveUnlockFunctions(serialized) as {
      addOne: (n: number) => number;
      concat: (a: string, b: string) => string;
    };

    expect(revived.addOne(41)).toBe(42);
    expect(revived.concat('a', 'b')).toBe('a:b');
  });

  it('toStoredContractUtxo maps fields and supports null-vs-undefined contract fields', () => {
    const utxo: UTXO = {
      address: 'bitcoincash:qtest',
      height: 120,
      tx_hash: 'f'.repeat(64),
      tx_pos: 1,
      value: 777,
      contractFunctionInputs: { answer: 42 },
    };

    const withNulls = toStoredContractUtxo(utxo, 'bitcoincash', true);
    expect(withNulls.amount).toBe(777n);
    expect(withNulls.contractFunction).toBeNull();
    expect(withNulls.contractFunctionInputs).toBe('{"answer":42}');

    const noNulls = toStoredContractUtxo(
      { ...utxo, contractFunction: 'claim', contractFunctionInputs: undefined },
      'bchtest',
      false
    );
    expect(noNulls.prefix).toBe('bchtest');
    expect(noNulls.contractFunction).toBe('claim');
    expect(noNulls.contractFunctionInputs).toBeUndefined();
  });

  it('outpointKey composes tx hash and position', () => {
    expect(outpointKey('abc', 0)).toBe('abc:0');
    expect(outpointKey('abc', '2')).toBe('abc:2');
  });
});

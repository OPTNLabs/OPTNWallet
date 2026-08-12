import { describe, expect, it } from 'vitest';

import { createBuiltinArtifactCache } from '../artifacts';

describe('ContractManager/artifacts', () => {
  it('createBuiltinArtifactCache returns expected builtin artifact keys', () => {
    const cache = createBuiltinArtifactCache();

    expect(Object.keys(cache).sort()).toEqual([
      'authguard',
      'bip38',
      'custody_vault',
      'escrow',
      'escrowMS2',
      'msVault',
      'p2pkh',
      'transfer_with_timeout',
    ]);
  });

  it('returns artifact objects with a contract name', () => {
    const cache = createBuiltinArtifactCache();

    expect(cache.p2pkh).toBeTruthy();
    expect(typeof cache.p2pkh.contractName).toBe('string');
    expect(cache.p2pkh.contractName.length).toBeGreaterThan(0);
  });

  it('does not expose embedded source or debug metadata in builtin artifacts', () => {
    const cache = createBuiltinArtifactCache();

    for (const artifact of Object.values(cache)) {
      expect((artifact as Record<string, unknown>).source).toBeUndefined();
      expect((artifact as Record<string, unknown>).debug).toBeUndefined();
    }
  });
});

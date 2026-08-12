import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEE_RATE,
  DUST_LIMIT,
  deriveFeeFromBytes,
  encodeLeafSpendIndex,
  formatVaultTokenCategoryForTemplate,
  normalizeTokenCategory,
  toBigIntSats,
} from '../QuantumrootRecoveryHelpers';

describe('QuantumrootRecoveryHelpers', () => {
  it('normalizes token categories and encodes leaf spend indexes', () => {
    expect(normalizeTokenCategory('0xAABB')).toBe('aabb');
    expect(formatVaultTokenCategoryForTemplate('0xAABB')).toBe('0xbbaa');
    expect(encodeLeafSpendIndex(1)).toBe('01');
  });

  it('coerces fee and satoshi values defensively', () => {
    expect(toBigIntSats(12)).toBe(12n);
    expect(toBigIntSats('34')).toBe(34n);
    expect(deriveFeeFromBytes(10, DEFAULT_FEE_RATE)).toBe(10n);
    expect(DUST_LIMIT).toBe(546n);
  });
});

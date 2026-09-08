import { describe, expect, it } from 'vitest';

import { isChipnetBroadcastEnabled } from '../seedcash/broadcastGate';

describe('SeedCash Chipnet broadcast gate', () => {
  it('requires the exact documented opt-in value', () => {
    expect(isChipnetBroadcastEnabled(undefined)).toBe(false);
    expect(isChipnetBroadcastEnabled('')).toBe(false);
    expect(isChipnetBroadcastEnabled('0')).toBe(false);
    expect(isChipnetBroadcastEnabled('false')).toBe(false);
    expect(isChipnetBroadcastEnabled('yes')).toBe(false);
    expect(isChipnetBroadcastEnabled('1')).toBe(true);
  });
});

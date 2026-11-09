import { describe, expect, it } from 'vitest';
import { maskSensitiveValue } from '../maskSensitiveValue';

describe('maskSensitiveValue', () => {
  it('keeps the first and last four characters visible', () => {
    expect(maskSensitiveValue('a'.repeat(64))).toBe(
      `aaaa${'*'.repeat(56)}aaaa`
    );
  });

  it('leaves short values readable', () => {
    expect(maskSensitiveValue('short')).toBe('short');
  });
});

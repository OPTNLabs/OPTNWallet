import { beforeAll, describe, expect, it } from 'vitest';
import {
  bcmrAuthorRegistry,
  bcmrParsableCommitment,
  bcmrSequentialCommitment,
  ensureOptnCore,
} from '..';

describe('BCMR direct WASM boundary', () => {
  beforeAll(() => ensureOptnCore());

  it.each([NaN, Infinity, -Infinity, -1, -0.5, 0.5, 2 ** 32])(
    'rejects serial %s before integer conversion',
    (value) => {
      expect(() => bcmrSequentialCommitment(value)).toThrow(/whole number/);
      expect(() => bcmrParsableCommitment(0, value)).toThrow(/whole number/);
    }
  );

  it.each([NaN, Infinity, -Infinity, -1, 0.5, 256, 2 ** 32])(
    'rejects type %s before integer conversion',
    (value) => {
      expect(() => bcmrParsableCommitment(value, 1)).toThrow(/whole number/);
    }
  );

  it('preserves valid commitments at both ends of the supported ranges', () => {
    expect(bcmrSequentialCommitment(0)).toBe('');
    expect(bcmrSequentialCommitment(128)).toBe('8000');
    expect(bcmrSequentialCommitment(0xffff_ffff)).toBe('ffffffff00');
    expect(bcmrParsableCommitment(0, 128)).toBe('008000');
    expect(bcmrParsableCommitment(255, 0xffff_ffff)).toBe('ffffffffff00');
  });

  it('rejects malformed nested metadata without a TypeScript adapter', () => {
    const category = 'ab'.repeat(32);
    const request = {
      network: 'chipnet',
      revision: '2026-09-30T00:00:00.000Z',
      identity: {
        authbase: category,
        category,
        name: 'Demo',
        symbol: 'DEMO',
        nfts: {
          kind: 'parsable',
          fields: { serial: { name: 123, encoding: { type: 'number' } } },
        },
      },
    };
    expect(() => bcmrAuthorRegistry(JSON.stringify(request))).toThrow(
      /name must be a string/
    );
  });
});

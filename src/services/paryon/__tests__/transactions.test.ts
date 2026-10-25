import { describe, expect, it } from 'vitest';

import { createParyonPreparedTransaction } from '../transactions';

describe('Paryon prepared transaction summaries', () => {
  it('reports exact bytes and network fee without broadcasting', () => {
    expect(
      createParyonPreparedTransaction('00aabbcc', 100_000n, 99_250n)
    ).toEqual({
      hex: '00aabbcc',
      transactionByteLength: 4,
      inputSats: 100_000n,
      outputSats: 99_250n,
      feeSats: 750n,
    });
  });

  it('rejects malformed raw bytes and negative fees', () => {
    expect(() => createParyonPreparedTransaction('', 1n, 0n)).toThrow(
      'even-length raw bytes'
    );
    expect(() => createParyonPreparedTransaction('00', 1n, 2n)).toThrow(
      'negative network fee'
    );
  });
});

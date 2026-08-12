import { describe, expect, it } from 'vitest';

import type { TransactionOutput } from '../../../types/types';
import {
  estimateAddP2PKHOutputBytes,
  formatMinRelayError,
  hasExplicitManualChangeOutput,
  txBytesFromHex,
} from '../feePolicy';

describe('feePolicy', () => {
  it('estimateAddP2PKHOutputBytes adds 34 bytes when varint size does not change', () => {
    expect(estimateAddP2PKHOutputBytes(250, 2)).toBe(284);
  });

  it('estimateAddP2PKHOutputBytes accounts for output-count varint boundary growth', () => {
    // 252 -> 253 outputs bumps varint from 1 byte to 3 bytes (+2)
    expect(estimateAddP2PKHOutputBytes(1000, 252)).toBe(1036);
  });

  it('txBytesFromHex returns floor(hexLength/2)', () => {
    expect(txBytesFromHex('aabbcc')).toBe(3);
    expect(txBytesFromHex('abc')).toBe(1);
    expect(txBytesFromHex('')).toBe(0);
  });

  it('hasExplicitManualChangeOutput only checks manual flag on non-OP_RETURN outputs', () => {
    const outputs: TransactionOutput[] = [
      { recipientAddress: 'bitcoincash:qrecipient', amount: 546 },
      { opReturn: ['6d02', 'hello'] },
      {
        recipientAddress: 'bitcoincash:qchange',
        amount: 1000,
        _manualChange: true,
      } as TransactionOutput,
    ];

    expect(hasExplicitManualChangeOutput(outputs, 'bitcoincash:qchange')).toBe(
      true
    );
    expect(hasExplicitManualChangeOutput(outputs, '')).toBe(false);
  });

  it('formatMinRelayError includes fee details and default tip', () => {
    const msg = formatMinRelayError({
      paying: 220n,
      size: 300,
      needAtLeast: 300,
      shortBy: 80,
    });

    expect(msg).toContain('Min relay fee not met');
    expect(msg).toContain('paying=220 sats');
    expect(msg).toContain('size=300 bytes');
    expect(msg).toContain('need_at_least=300 sats');
    expect(msg).toContain('short_by=80 sats');
    expect(msg).toContain('Tip: remove/reduce any manual');
  });

  it('formatMinRelayError uses provided tip when present', () => {
    const msg = formatMinRelayError({
      paying: 100n,
      size: 150,
      needAtLeast: 150,
      shortBy: 50,
      tip: 'Custom tip.',
    });

    expect(msg).toContain('Custom tip.');
    expect(msg).not.toContain('let Change Address auto-add change');
  });
});

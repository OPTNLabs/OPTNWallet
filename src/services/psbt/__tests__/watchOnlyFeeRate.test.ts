// Which fee a watch-only send charges, and where that number comes from.
//
// The screen used to answer this itself: multisig sends were hardcoded to
// 1 sat/byte. The rest of the wallet uses `relayFeeForBytes`, which is 1.1
// sat/byte — "a small buffer over the usual 1 sat/byte floor prevents
// otherwise-valid transactions from being rejected when a backend's rolling
// mempool minimum rises". So the one screen that could not retry cheaply was
// also the one building transactions below the floor everything else respects.

import { describe, expect, it } from 'vitest';
import {
  feeForTransactionBytes,
  resolveWatchOnlyFeeRate,
} from '../watchOnlySend';
import { relayFeeForBytes } from '../../../apis/TransactionManager/feePolicy';

describe('resolveWatchOnlyFeeRate', () => {
  it('names no rate when the wallet is on automatic', () => {
    // `undefined` is the answer, not a number. It means "use the shared relay
    // policy", so the default cannot drift away from the rest of the wallet by
    // someone editing a constant here.
    expect(resolveWatchOnlyFeeRate(null, 'auto', 1.1)).toBeUndefined();
    expect(resolveWatchOnlyFeeRate(null, 'auto', 5)).toBeUndefined();
  });

  it("uses the wallet's custom rate when Settings has one", () => {
    expect(resolveWatchOnlyFeeRate(null, 'custom', 3)).toBe(3);
  });

  it('lets a per-send choice win over the wallet setting', () => {
    expect(resolveWatchOnlyFeeRate(5, 'custom', 3)).toBe(5);
    expect(resolveWatchOnlyFeeRate(2, 'auto', 3)).toBe(2);
  });

  it('falls back rather than throwing on a half-typed rate', () => {
    // Settings holds a free-text number. A send screen that refused to render
    // because someone was mid-keystroke would be worse than one that quietly
    // used the default.
    expect(resolveWatchOnlyFeeRate(null, 'custom', 0)).toBeUndefined();
    expect(resolveWatchOnlyFeeRate(null, 'custom', -1)).toBeUndefined();
    expect(resolveWatchOnlyFeeRate(null, 'custom', Number.NaN)).toBeUndefined();
    expect(resolveWatchOnlyFeeRate(0, 'auto', 1)).toBeUndefined();
    expect(resolveWatchOnlyFeeRate(Number.NaN, 'custom', 4)).toBe(4);
  });

  it('produces the wallet default fee, not a cheaper one', () => {
    // The regression this whole change exists for. 1 sat/byte was below the
    // relay floor; the resolved default matches what a signed send from the
    // same wallet would pay.
    const bytes = 1_000;
    const resolved = resolveWatchOnlyFeeRate(null, 'auto', 1.1);

    expect(feeForTransactionBytes(bytes, resolved)).toBe(relayFeeForBytes(bytes));
    expect(feeForTransactionBytes(bytes, resolved)).toBeGreaterThan(
      feeForTransactionBytes(bytes, 1)
    );
  });
});

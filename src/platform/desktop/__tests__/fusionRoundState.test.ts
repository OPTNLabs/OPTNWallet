import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearOutpointReservations,
  fusionCoinAvailability,
  isOwnRoundKey,
  isRetiredRoundKey,
  outpointKey,
  recordRoundKey,
  releaseOutpoints,
  reserveOutpoints,
  reservedOutpoints,
  retireAllOwnRoundKeys,
  retireRoundKey,
} from '../fusionRoundState';

// A minimal localStorage so this state can be exercised without a DOM.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

describe('P2P fusion cross-window round state', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it('recognises this wallet’s own round keys and ignores other wallets’', () => {
    const mine = 'a'.repeat(64);
    recordRoundKey(4, mine);

    // Same wallet from any window/reload must never fuse with itself.
    expect(isOwnRoundKey(4, mine)).toBe(true);
    // A different wallet's round is a legitimate peer, not us.
    expect(isOwnRoundKey(5, mine)).toBe(false);
    expect(isOwnRoundKey(4, 'b'.repeat(64))).toBe(false);
  });

  it('reserves coins so a second round cannot spend them, and frees them after', () => {
    const first = outpointKey('aa'.repeat(32), 0);
    const second = outpointKey('bb'.repeat(32), 1);

    reserveOutpoints(7, [first, second]);
    const claimed = reservedOutpoints(7);
    expect(claimed.has(first)).toBe(true);
    expect(claimed.has(second)).toBe(true);
    // Reservations are per wallet.
    expect(reservedOutpoints(8).has(first)).toBe(false);

    releaseOutpoints(7, [first]);
    expect(reservedOutpoints(7).has(first)).toBe(false);
    expect(reservedOutpoints(7).has(second)).toBe(true);
  });

  it('reports free vs reserved coins for greying Start/Fuse', () => {
    const a = { tx_hash: 'aa'.repeat(32), tx_pos: 0 };
    const b = { tx_hash: 'bb'.repeat(32), tx_pos: 1 };
    reserveOutpoints(3, [outpointKey(a.tx_hash, a.tx_pos)]);
    expect(fusionCoinAvailability(3, [a, b])).toEqual({
      total: 2,
      free: 1,
      reserved: 1,
    });
    expect(fusionCoinAvailability(3, [a])).toEqual({
      total: 1,
      free: 0,
      reserved: 1,
    });
    clearOutpointReservations(3);
    expect(fusionCoinAvailability(3, [a, b])).toEqual({
      total: 2,
      free: 2,
      reserved: 0,
    });
  });

  it('retires finished throwaway keys so other windows stop counting ghosts', () => {
    const dead = 'd'.repeat(64);
    expect(isRetiredRoundKey(dead)).toBe(false);
    retireRoundKey(dead);
    expect(isRetiredRoundKey(dead)).toBe(true);
  });

  it('retireAllOwnRoundKeys marks every prior attempt of this wallet as retired', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    recordRoundKey(9, a);
    recordRoundKey(9, b);
    expect(isOwnRoundKey(9, a)).toBe(true);
    retireAllOwnRoundKeys(9);
    expect(isRetiredRoundKey(a)).toBe(true);
    expect(isRetiredRoundKey(b)).toBe(true);
  });

  it('survives unreadable storage instead of throwing mid-round', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => '{ not json',
      setItem: () => undefined,
    };
    expect(() => reserveOutpoints(1, ['x:0'])).not.toThrow();
    expect(reservedOutpoints(1).size).toBe(0);
    expect(isOwnRoundKey(1, 'c'.repeat(64))).toBe(false);
  });
});

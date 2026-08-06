import { describe, expect, it } from 'vitest';
import {
  formatAutoDepthGateLog,
  formatAutoDepthMetMessage,
  listRecordedFusionTxids,
  mergeRecordedFusionTxsIntoHistory,
  recordFusionTxid,
  clearFusionDepth,
} from '../fusionCoinDepth';

describe('Auto depth status copy', () => {
  it('names rounds-per-coin and shows current depth, not a hard-coded ≥N', () => {
    const msg = formatAutoDepthMetMessage({
      total: 10,
      minDepth: 3,
      maxCoinDepth: 3,
      maxDepth: 3,
    });
    expect(msg).toMatch(/rounds-per-coin depth/);
    expect(msg).toMatch(/Current coin depth 3/);
    expect(msg).toMatch(/number in the box/);
    expect(msg).not.toMatch(/≥\s*3/);
  });

  it('shows a depth range when coins differ', () => {
    const msg = formatAutoDepthMetMessage({
      total: 5,
      minDepth: 2,
      maxCoinDepth: 4,
      maxDepth: 5,
    });
    expect(msg).toMatch(/Current coin depth 2–4/);
  });

  it('gate log uses box target + current range', () => {
    const log = formatAutoDepthGateLog(4, 5, 2, 4);
    expect(log).toMatch(/below rounds-per-coin/);
    expect(log).toMatch(/box 5/);
    expect(log).toMatch(/current depth 2–4/);
  });
});

describe('mergeRecordedFusionTxsIntoHistory (shared P2P + server)', () => {
  class MemoryStorage {
    private map = new Map<string, string>();
    getItem(k: string) {
      return this.map.has(k) ? (this.map.get(k) as string) : null;
    }
    setItem(k: string, v: string) {
      this.map.set(k, v);
    }
    removeItem(k: string) {
      this.map.delete(k);
    }
  }

  it('re-attaches missing fusion CoinJoins after a refresh-style list', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = new MemoryStorage();
    clearFusionDepth(11);
    const fused = 'ab'.repeat(32);
    recordFusionTxid(11, fused);
    expect(listRecordedFusionTxids(11)).toContain(fused);
    const electrumOnly = [
      { tx_hash: 'cd'.repeat(32), height: 100 },
    ];
    const merged = mergeRecordedFusionTxsIntoHistory(11, electrumOnly);
    expect(merged.some((t) => t.tx_hash === fused && t.height <= 0)).toBe(true);
    expect(merged.some((t) => t.tx_hash === electrumOnly[0].tx_hash)).toBe(true);
  });
});


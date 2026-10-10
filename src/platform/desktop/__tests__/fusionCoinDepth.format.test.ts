import { beforeEach, describe, expect, it } from 'vitest';
import {
  fuseDepthEligibility,
  listRecordedFusionTxids,
  mergeRecordedFusionTxsIntoHistory,
  recordFusionRound,
  recordFusionTxid,
  clearFusionDepth,
} from '../fusionCoinDepth';

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

/** Record `depth` rounds ending in `name:0`. */
function fuseTo(walletId: number, name: string, depth: number) {
  let previous = `${name}-seed:0`;
  for (let round = 1; round <= depth; round += 1) {
    const next = round === depth ? `${name}:0` : `${name}-${round}:0`;
    recordFusionRound(walletId, [previous], [next]);
    previous = next;
  }
}

const coin = (name: string) => ({ tx_hash: name, tx_pos: 0 });

// The copy is Rust (optn-core fusion::depth); these read it through the
// desktop's eligibility call.
describe('Auto depth status copy', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = new MemoryStorage();
    clearFusionDepth(12);
  });

  it('names rounds-per-coin and shows current depth, not a hard-coded ≥N', () => {
    fuseTo(12, 'a', 3);
    fuseTo(12, 'b', 3);
    const msg = fuseDepthEligibility(12, [coin('a'), coin('b')], 3).metMessage;
    expect(msg).toMatch(/rounds-per-coin depth/);
    expect(msg).toMatch(/Current coin depth 3/);
    expect(msg).toMatch(/number in the box/);
    expect(msg).not.toMatch(/≥\s*3/);
  });

  it('shows a depth range when coins differ', () => {
    fuseTo(12, 'a', 2);
    fuseTo(12, 'b', 4);
    const msg = fuseDepthEligibility(12, [coin('a'), coin('b')], 5).metMessage;
    expect(msg).toMatch(/Current coin depth 2–4/);
  });

  it('gate log uses box target + current range', () => {
    fuseTo(12, 'a', 2);
    fuseTo(12, 'b', 4);
    const log = fuseDepthEligibility(12, [coin('a'), coin('b')], 5).gateLog;
    expect(log).toMatch(/below rounds-per-coin/);
    expect(log).toMatch(/box 5/);
    expect(log).toMatch(/current depth 2–4/);
  });
});

describe('mergeRecordedFusionTxsIntoHistory (shared P2P + server)', () => {
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


import { describe, expect, it, beforeEach } from 'vitest';

import {
  rankServersForConnect,
  recordServerFailure,
  recordServerSuccess,
  resetFulcrumReliability,
  getServerHealth,
} from '../fulcrumReliability';

describe('fulcrumReliability', () => {
  beforeEach(() => {
    resetFulcrumReliability();
  });

  it('ranks successful low-latency hosts ahead of failures', () => {
    const servers = ['a.example', 'b.example', 'c.example'];
    recordServerFailure('a.example');
    recordServerFailure('a.example');
    recordServerSuccess('b.example', 40);
    recordServerSuccess('b.example', 35);
    recordServerSuccess('c.example', 400);

    const ranked = rankServersForConnect(servers);
    expect(ranked[0]).toBe('b.example');
    expect(ranked.indexOf('a.example')).toBeGreaterThan(
      ranked.indexOf('c.example')
    );
  });

  it('sinks blocked hosts to the end even if scored high', () => {
    recordServerSuccess('fast.example', 20);
    recordServerSuccess('slow.example', 300);
    const ranked = rankServersForConnect(
      ['slow.example', 'fast.example', 'blocked.example'],
      { isBlocked: (s) => s === 'blocked.example' }
    );
    expect(ranked[ranked.length - 1]).toBe('blocked.example');
    expect(ranked[0]).toBe('fast.example');
  });

  it('tracks latency EMA on success', () => {
    recordServerSuccess('h', 100);
    recordServerSuccess('h', 20);
    const h = getServerHealth('h');
    expect(h.successes).toBe(2);
    expect(h.latencyEmaMs).toBeGreaterThan(20);
    expect(h.latencyEmaMs).toBeLessThan(100);
  });

  it('preserves relative order for equal unknown hosts', () => {
    const ranked = rankServersForConnect(['x', 'y', 'z']);
    expect(ranked).toEqual(['x', 'y', 'z']);
  });
});

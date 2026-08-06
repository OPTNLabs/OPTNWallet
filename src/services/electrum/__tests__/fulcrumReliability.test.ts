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

  it('never lowers score on a successful (even slow) sample', () => {
    // Open listunspent batches used to record multi-second wall-clock as
    // latency and make the working host score *down* below never-tried peers.
    recordServerSuccess('busy.example', 2_500);
    recordServerSuccess('busy.example', 3_000);
    const h = getServerHealth('busy.example');
    expect(h.score).toBeGreaterThan(0);
    expect(h.successes).toBe(2);

    const ranked = rankServersForConnect([
      'never.example',
      'busy.example',
      'bad.example',
    ]);
    recordServerFailure('bad.example');
    const rankedAfterFail = rankServersForConnect([
      'never.example',
      'busy.example',
      'bad.example',
    ]);
    expect(ranked[0]).toBe('busy.example');
    expect(rankedAfterFail[0]).toBe('busy.example');
    expect(rankedAfterFail.indexOf('bad.example')).toBe(
      rankedAfterFail.length - 1
    );
  });

  it('strongly prefers an explicit sticky/preferred host', () => {
    recordServerSuccess('a.example', 30);
    recordServerSuccess('b.example', 30);
    const ranked = rankServersForConnect(['a.example', 'b.example', 'c.example'], {
      preferred: 'c.example',
    });
    expect(ranked[0]).toBe('c.example');
  });
});

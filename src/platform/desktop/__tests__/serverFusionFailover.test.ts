import { describe, expect, it, vi } from 'vitest';

import {
  orderedFusionServerCandidates,
  selectPreparedFusionServer,
} from '../serverFusionFailover';

describe('server Fusion pre-round failover', () => {
  it('tries the selected server first without duplicating it', () => {
    expect(
      orderedFusionServerCandidates('second:8789:s', [
        'first:8789:s',
        'second:8789:s',
        'third:8789:s',
      ])
    ).toEqual(['second:8789:s', 'first:8789:s', 'third:8789:s']);
  });

  it('moves from a dead selected server to the next validated candidate', async () => {
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce('runner-two');

    await expect(
      selectPreparedFusionServer({
        selected: 'dead',
        configured: ['dead', 'live'],
        prepare,
      })
    ).resolves.toEqual({ server: 'live', prepared: 'runner-two' });
    expect(prepare.mock.calls.map(([server]) => server)).toEqual([
      'dead',
      'live',
    ]);
  });

  it('moves past a malformed ServerHello and stops after one candidate is prepared', async () => {
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad config on server: tiers'))
      .mockResolvedValueOnce('runner-two');

    const selected = await selectPreparedFusionServer({
      configured: ['malformed', 'ready', 'must-not-run'],
      prepare,
    });

    expect(selected.server).toBe('ready');
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('does not perform post-start failover when the chosen runner fails', async () => {
    const prepare = vi.fn().mockResolvedValue(async () => {
      throw new Error('native round failed after start');
    });
    const selected = await selectPreparedFusionServer({
      configured: ['first', 'second'],
      prepare,
    });

    await expect(selected.prepared()).rejects.toThrow(
      'native round failed after start'
    );
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

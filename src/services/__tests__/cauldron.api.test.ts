import { afterEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../state/slices/networkSlice';
import { CauldronApiClient, clearCauldronApiCache } from '../cauldron/api';

afterEach(() => {
  clearCauldronApiCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cauldron api client cache', () => {
  it('reuses recent GET responses and refreshes after the ttl expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify([
          {
            token_id: 'abc123',
            score: 1,
            tvl_sats: 0,
            tvl_tokens: 0,
            trade_count: 0,
            trade_volume: 0,
            score_rank: 1,
            price_now: 1,
            price_now_usd: 1,
          },
        ]),
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const client = new CauldronApiClient(
      Network.MAINNET,
      'https://example.test/cauldron'
    );

    await client.listCachedTokens({ limit: 1 });
    await client.listCachedTokens({ limit: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_001);

    await client.listCachedTokens({ limit: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

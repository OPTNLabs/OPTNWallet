import { beforeEach, describe, expect, it, vi } from 'vitest';

import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import ElectrumService, {
  invalidateUTXOCache,
  primeUTXOCache,
} from '../ElectrumService';

vi.mock('../../apis/ElectrumServer/ElectrumServer', () => ({
  default: vi.fn(),
}));

describe('ElectrumService', () => {
  const mockedElectrumServer = vi.mocked(ElectrumServer);

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateUTXOCache();
  });

  it('getUTXOs maps Electrum rows and uses cache', async () => {
    const server = {
      request: vi.fn(async () => [
        {
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 1234,
          height: 100,
          token_data: { category: 'cat', amount: 5 },
        },
      ]),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const addr = 'bitcoincash:q1';
    const first = await ElectrumService.getUTXOs(addr);
    const second = await ElectrumService.getUTXOs(addr);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      address: addr,
      value: 1234,
      amount: 1234,
      token: { category: 'cat', amount: 5, nft: undefined },
      id: `${'a'.repeat(64)}:0`,
    });
    expect(second).toEqual(first);
    expect(server.request).toHaveBeenCalledTimes(1);
  });

  it('primeUTXOCache seeds cache used by getUTXOs', async () => {
    const server = {
      request: vi.fn(async () => []),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    primeUTXOCache('bitcoincash:qcached', [
      {
        address: 'bitcoincash:qcached',
        height: 0,
        tx_hash: 'b'.repeat(64),
        tx_pos: 1,
        value: 546,
      },
    ]);

    const res = await ElectrumService.getUTXOs('bitcoincash:qcached');
    expect(res).toHaveLength(1);
    expect(server.request).not.toHaveBeenCalled();
  });

  it('getBalance returns confirmed + unconfirmed and falls back to 0', async () => {
    const server = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ confirmed: 10, unconfirmed: 2 })
        .mockResolvedValueOnce({ wrong: true }),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    await expect(ElectrumService.getBalance('bitcoincash:q1')).resolves.toBe(12);
    await expect(ElectrumService.getBalance('bitcoincash:q1')).resolves.toBe(0);
  });

  it('broadcastTransaction returns txid string or error message fallback', async () => {
    const server = {
      request: vi
        .fn()
        .mockResolvedValueOnce('txid123')
        .mockResolvedValueOnce({ bad: true }),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    await expect(ElectrumService.broadcastTransaction('rawhex')).resolves.toBe('txid123');
    await expect(ElectrumService.broadcastTransaction('rawhex')).resolves.toBe(
      'Invalid transaction hash response'
    );
  });

  it('getTransactionHistory validates response shape', async () => {
    const server = {
      request: vi
        .fn()
        .mockResolvedValueOnce([{ tx_hash: 'abc', height: 10 }])
        .mockResolvedValueOnce({ not: 'array' }),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    await expect(ElectrumService.getTransactionHistory('bitcoincash:q1')).resolves.toEqual([
      { tx_hash: 'abc', height: 10 },
    ]);
    await expect(ElectrumService.getTransactionHistory('bitcoincash:q1')).resolves.toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import getElectrumAdapter from '../ElectrumAdapter';
import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';

vi.mock('../../apis/ElectrumServer/ElectrumServer', () => ({
  default: vi.fn(),
}));

describe('ElectrumAdapter', () => {
  const mockedElectrumServer = vi.mocked(ElectrumServer);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards connect/reconnect/disconnect/request/subscribe/unsubscribe to ElectrumServer', async () => {
    const server = {
      electrumConnect: vi.fn(async () => 'connected'),
      electrumReconnect: vi.fn(async () => 'reconnected'),
      electrumDisconnect: vi.fn(async () => true),
      request: vi.fn(async () => 'ok'),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const adapter = getElectrumAdapter();

    await expect(adapter.connect('wss://server:50004')).resolves.toBe('connected');
    await expect(adapter.reconnect('wss://server:50005')).resolves.toBe('reconnected');
    await expect(adapter.disconnect()).resolves.toBe(true);
    await expect(adapter.request('blockchain.headers.get_tip')).resolves.toBe('ok');

    await adapter.subscribe('blockchain.address.subscribe', ['bitcoincash:q1']);
    await adapter.unsubscribe('blockchain.address.subscribe', ['bitcoincash:q1']);

    expect(server.electrumConnect).toHaveBeenCalledWith('wss://server:50004');
    expect(server.electrumReconnect).toHaveBeenCalledWith('wss://server:50005');
    expect(server.electrumDisconnect).toHaveBeenCalledTimes(1);
    expect(server.request).toHaveBeenCalledWith('blockchain.headers.get_tip');
    expect(server.subscribe).toHaveBeenCalledWith('blockchain.address.subscribe', [
      'bitcoincash:q1',
    ]);
    expect(server.unsubscribe).toHaveBeenCalledWith(
      'blockchain.address.subscribe',
      ['bitcoincash:q1']
    );
  });
});

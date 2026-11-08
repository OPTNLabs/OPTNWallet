import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  state: {
    wallet_id: { currentWalletId: 7 as number | null, sessionGeneration: 2 },
    network: { currentNetwork: 'chipnet' },
  },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../../state/store', () => ({
  store: { getState: () => mocks.state },
}));

import { submitSignedTransaction } from '../engineBroadcast';

const send = () => submitSignedTransaction('0200', 7, 2, 'chipnet');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.state.wallet_id.currentWalletId = 7;
});

describe('desktop broadcast handoff', () => {
  it('names the missing engine session instead of a generic failure', async () => {
    // A watch-only wallet the engine never opened: the SeedCash report.
    mocks.invoke.mockResolvedValueOnce({
      active: null,
      legacy_source_id: null,
      epoch: 0,
    });
    expect(await send()).toEqual({
      txid: '',
      status: 'deferred',
      message:
        'This wallet is not open in the shared engine. Lock it and open it again with its password before sending.',
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses a session that belongs to another wallet', async () => {
    mocks.invoke.mockResolvedValueOnce({
      active: 'wallet-other.optn',
      legacy_source_id: 9,
      epoch: 4,
    });
    expect((await send()).status).toBe('deferred');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('says when the selected wallet changed before handoff', async () => {
    mocks.state.wallet_id.currentWalletId = 8;
    expect(await send()).toMatchObject({
      status: 'deferred',
      message: 'Wallet session changed. Review the transaction again.',
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('keeps native errors out of the message', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('C:\\Users\\someone\\x.optn'));
    expect(await send()).toEqual({
      txid: '',
      status: 'deferred',
      message:
        'Wallet session is unavailable or changed. Reopen this wallet before sending.',
    });
  });

  it('hands a matching watch-only session to the engine', async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        active: 'wallet-0011.optn',
        legacy_source_id: 7,
        epoch: 4,
      })
      .mockResolvedValueOnce({ txid: 'ab', status: 'accepted', message: null });
    expect(await send()).toEqual({
      txid: 'ab',
      status: 'accepted',
      message: null,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith('optn_wallet_broadcast', {
      request: { wallet_id: 7, epoch: 4, network: 'chipnet', raw_hex: '0200' },
    });
  });

  it('reports an unknown outcome once the engine has the transaction', async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        active: 'wallet-0011.optn',
        legacy_source_id: 7,
        epoch: 4,
      })
      .mockRejectedValueOnce(new Error('ipc closed'));
    expect(await send()).toMatchObject({ status: 'uncertain' });
  });
});

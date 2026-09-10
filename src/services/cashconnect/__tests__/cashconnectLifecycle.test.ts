import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Wallet } from '@cashconnect-js/nostr/wallet';

const mocks = vi.hoisted(() => ({
  Wallet: vi.fn(),
  getWalletInfo: vi.fn(),
  getWalletMetadata: vi.fn(),
  deriveIdentity: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  spendable: vi.fn(),
}));
vi.mock('@cashconnect-js/nostr', () => ({ MemoryStore: class {} }));
vi.mock('@cashconnect-js/nostr/wallet', () => ({
  Wallet: mocks.Wallet,
  doesActionRequireApproval: () => true,
}));
vi.mock('../../../apis/WalletManager/WalletManager', () => ({
  default: () => mocks,
}));
vi.mock('../../WalletUtxoRefreshService', () => ({
  subscribeWalletUtxoRefresh: mocks.subscribe,
}));
vi.mock('../cashconnectKey', () => ({
  deriveCashConnectIdentityKey: mocks.deriveIdentity,
}));
vi.mock('../cashconnectContext', () => ({
  getSpendableUTXOsForCashConnect: mocks.spendable,
  getChangeTemplateDirectiveForCashConnect: vi.fn(),
  getSourceOutputForCashConnect: vi.fn(),
}));

import {
  bindCashConnectUi,
  isCashConnectActive,
  pairCashConnect,
  startCashConnect,
  stopCashConnect,
} from '../CashConnectService';
import reducer, {
  initCashConnect,
  pairCashConnectThunk,
  setCashConnectError,
  stopCashConnectThunk,
} from '../../../state/slices/cashconnectSlice';

type Options = ConstructorParameters<typeof Wallet>[0];
type Client = {
  options: Options;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pair?: ReturnType<typeof vi.fn>;
  getActiveSessions: () => Record<string, never>;
};
const clients: Client[] = [];
const hooks = {
  onSessions: vi.fn(),
  onProposal: vi.fn(),
  onAction: vi.fn(),
  onClearProposal: vi.fn(),
  onClearAction: vi.fn(),
  onError: vi.fn(),
};
const info = {
  mnemonic: 'test fixture, never used for derivation',
  networkType: 'chipnet',
  derivation_path: "m/44'/145'/0'",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await stopCashConnect();
  vi.resetAllMocks();
  clients.length = 0;
  bindCashConnectUi(hooks);
  mocks.getWalletInfo.mockResolvedValue(info);
  mocks.getWalletMetadata.mockResolvedValue({ walletType: 'standard' });
  mocks.deriveIdentity.mockImplementation(async () =>
    new Uint8Array(32).fill(1)
  );
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  mocks.Wallet.mockImplementation(function (options: Options) {
    const client = {
      options,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      pair: vi.fn().mockResolvedValue(undefined),
      getActiveSessions: () => ({}),
    };
    clients.push(client);
    return client;
  });
});

describe('CashConnect wallet lock cancellation', () => {
  it('does not report a pairing error from a wallet that has closed', async () => {
    await startCashConnect(7);
    const pairing = deferred<void>();
    clients[0].pair!.mockReturnValueOnce(pairing.promise);
    const pending = pairCashConnect('test-only-pairing');
    await stopCashConnect();
    pairing.reject(new Error('cancelled pairing'));
    await expect(pending).resolves.toBeUndefined();
  });
  it('cannot start a client after locking during wallet loading or identity derivation', async () => {
    const loading = deferred<typeof info>();
    mocks.getWalletInfo.mockReturnValueOnce(loading.promise);
    const first = startCashConnect(7);
    await vi.waitFor(() => expect(mocks.getWalletInfo).toHaveBeenCalled());
    await stopCashConnect();
    loading.resolve(info);
    await first;
    expect(mocks.Wallet).not.toHaveBeenCalled();

    const deriving = deferred<Uint8Array>();
    mocks.deriveIdentity.mockReturnValueOnce(deriving.promise);
    const second = startCashConnect(7);
    await vi.waitFor(() =>
      expect(mocks.deriveIdentity).toHaveBeenCalledTimes(1)
    );
    await stopCashConnect();
    const identity = new Uint8Array(32).fill(2);
    deriving.resolve(identity);
    await second;
    expect(identity).toEqual(new Uint8Array(32));
    expect(mocks.Wallet).not.toHaveBeenCalled();
    expect(isCashConnectActive(7)).toBe(false);
  });

  it('ignores cancelled startup errors and callbacks after reopening the same wallet', async () => {
    const starting = deferred<void>();
    mocks.Wallet.mockImplementationOnce(function (options: Options) {
      const client = {
        options,
        start: vi.fn(() => starting.promise),
        stop: vi.fn().mockResolvedValue(undefined),
        getActiveSessions: () => ({}),
      };
      clients.push(client);
      return client;
    });
    const pending = startCashConnect(7);
    await vi.waitFor(() => expect(clients[0]?.start).toHaveBeenCalled());
    await stopCashConnect();
    await startCashConnect(7);
    hooks.onError.mockClear();
    hooks.onSessions.mockClear();
    clients[0].options.eventCallbacks.onError?.(
      new Error('late relay failure')
    );
    clients[0].options.eventCallbacks.onSessionsUpdated?.({});
    expect(() =>
      clients[0].options.contextCallbacks.getSpendableUTXOs()
    ).toThrow('aborted');
    starting.reject(new Error('cancelled startup'));
    await expect(pending).resolves.toBeUndefined();
    expect(hooks.onError).not.toHaveBeenCalled();
    expect(hooks.onSessions).not.toHaveBeenCalled();
    expect(mocks.spendable).not.toHaveBeenCalled();
    expect(isCashConnectActive(7)).toBe(true);
  });

  it('still reports a current startup failure and releases its subscription', async () => {
    mocks.Wallet.mockImplementationOnce(function (options: Options) {
      const client = {
        options,
        start: vi.fn().mockRejectedValue(new Error('relay unavailable')),
        stop: vi.fn().mockResolvedValue(undefined),
        getActiveSessions: () => ({}),
      };
      clients.push(client);
      return client;
    });
    await expect(startCashConnect(7)).rejects.toThrow('relay unavailable');
    expect(isCashConnectActive(7)).toBe(false);
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(clients[0].stop).toHaveBeenCalledOnce();
  });

  it('clears the blocking popup when stop begins and cannot clear a newer error when stop finishes', () => {
    const failed = reducer(undefined, setCashConnectError('old error'));
    const stopped = reducer(
      failed,
      stopCashConnectThunk.pending('stop-1', undefined)
    );
    expect(stopped.errorMessage).toBeNull();
    const newer = reducer(stopped, setCashConnectError('new wallet error'));
    expect(
      reducer(
        newer,
        stopCashConnectThunk.fulfilled(undefined, 'stop-1', undefined)
      ).errorMessage
    ).toBe('new wallet error');
    const oldInit = initCashConnect.rejected(
      new Error('old startup'),
      'old-init',
      7
    );
    const oldPair = pairCashConnectThunk.rejected(
      new Error('old pairing'),
      'old-pair',
      'test-only-pairing'
    );
    expect(reducer(newer, oldInit).errorMessage).toBe('new wallet error');
    expect(reducer(newer, oldPair).errorMessage).toBe('new wallet error');
  });
});

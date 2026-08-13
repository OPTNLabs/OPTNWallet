import { describe, expect, it, vi } from 'vitest';

import { Network } from '../../state/slices/networkSlice';
import { WalletType } from '../../types/wallet';
import { bootstrapWalletNetwork } from '../../app/useAppLifecycle';

describe('wallet network bootstrap', () => {
  it('does not hold wallet rendering behind the Electrum connection', async () => {
    let finishConnection: (() => void) | undefined;
    const connection = new Promise<void>((resolve) => {
      finishConnection = resolve;
    });
    const dispatch = vi.fn();
    const ensureFreshConnection = vi.fn(() => connection);
    const refreshHistory = vi.fn(async () => {});
    let bootstrapFinished = false;

    const bootstrap = bootstrapWalletNetwork(
      7,
      dispatch as never,
      () => false,
      {
        loadWalletMetadata: vi.fn(async () => ({
          id: 7,
          wallet_name: 'wallet7',
          networkType: Network.CHIPNET,
          walletType: WalletType.STANDARD,
          balance: 0,
          derivation_path: "m/44'/145'/0'",
          derivation_path_source: 'default' as const,
        })),
        ensureFreshConnection,
        refreshHistory,
        getSessionGeneration: () => 3,
      }
    ).then(() => {
      bootstrapFinished = true;
    });

    await vi.waitFor(() => expect(ensureFreshConnection).toHaveBeenCalledOnce());
    expect(bootstrapFinished).toBe(true);
    expect(refreshHistory).not.toHaveBeenCalled();

    finishConnection?.();
    await bootstrap;
    await vi.waitFor(() => expect(refreshHistory).toHaveBeenCalledOnce());
    expect(refreshHistory).toHaveBeenCalledWith({
      walletId: 7,
      dispatch,
      sessionGeneration: 3,
    });
  });

  it('does not hold balance sync behind the full history scan', async () => {
    let finishHistory: (() => void) | undefined;
    const history = new Promise<void>((resolve) => {
      finishHistory = resolve;
    });
    const dispatch = vi.fn();
    const refreshHistory = vi.fn(() => history);

    await bootstrapWalletNetwork(
      7,
      dispatch as never,
      () => false,
      {
        loadWalletMetadata: vi.fn(async () => ({
          id: 7,
          wallet_name: 'wallet7',
          networkType: Network.CHIPNET,
          walletType: WalletType.STANDARD,
          balance: 0,
          derivation_path: "m/44'/145'/0'",
          derivation_path_source: 'default' as const,
        })),
        ensureFreshConnection: vi.fn(async () => {}),
        refreshHistory,
      }
    );

    expect(refreshHistory).toHaveBeenCalledOnce();
    expect(finishHistory).toBeTypeOf('function');
    finishHistory?.();
    await history;
  });
});

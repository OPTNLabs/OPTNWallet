import React from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const activityState = vi.hoisted(() => ({
  current: null as null | {
    walletId: number;
    mode: 'p2p' | 'server';
    trigger: 'manual';
    startedAt: number;
  },
}));

vi.mock('../../../platform/desktop/FusionRunnerService', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../platform/desktop/FusionRunnerService')
    >();
  return {
    ...actual,
    // Activity only greys the UI when this window holds a real lease.
    isFusionRunning: (walletId: number) =>
      activityState.current?.walletId === walletId,
    getFusionActivity: () => activityState.current,
    reconcileIdleFusionState: async () => undefined,
    subscribeFusionActivity: (
      _walletId: number,
      listener: (activity: typeof activityState.current) => void
    ) => {
      listener(activityState.current);
      return () => undefined;
    },
  };
});

import { CashFusionSettings } from '../CashFusionSettings';
import experimentalReducer, {
  setCashFusionEnabled,
  setP2pFusionEnabled,
} from '../../../state/slices/experimentalSlice';

describe('CashFusion settings mode enforcement', () => {
  afterEach(() => {
    activityState.current = null;
  });

  it('mutes and disables the server Fuse Now card in P2P mode', () => {
    const store = configureStore({
      reducer: {
        experimental: experimentalReducer,
        wallet_id: (state = { currentWalletId: 7 }) => state,
        network: (state = { currentNetwork: 'chipnet' }) => state,
        utxos: (state = { utxos: {} }) => state,
      },
    });
    store.dispatch(setCashFusionEnabled(true));
    store.dispatch(setP2pFusionEnabled(true));

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <CashFusionSettings />
      </Provider>
    );
    const serverCardStart = html.indexOf('aria-disabled="true"');
    const p2pCardStart = html.indexOf('P2P Fusion over Nostr');
    const serverCard = html.slice(serverCardStart, p2pCardStart);

    expect(serverCardStart).toBeGreaterThan(-1);
    expect(serverCard).toContain('opacity-40 grayscale');
    expect(serverCard).toContain('disabled=""');
    expect(serverCard).toContain('Fuse Now using CashFusion server');
  });

  it('greys Start P2P when every coin is reserved by another round', async () => {
    class MemoryStorage {
      private map = new Map<string, string>();
      getItem(key: string): string | null {
        return this.map.has(key) ? (this.map.get(key) as string) : null;
      }
      setItem(key: string, value: string): void {
        this.map.set(key, value);
      }
      removeItem(key: string): void {
        this.map.delete(key);
      }
    }
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();

    const { reserveOutpoints, outpointKey, clearOutpointReservations } =
      await import('../../../platform/desktop/fusionRoundState');
    const tx = 'ab'.repeat(32);
    clearOutpointReservations(7);
    reserveOutpoints(7, [outpointKey(tx, 0)]);

    const store = configureStore({
      reducer: {
        experimental: experimentalReducer,
        wallet_id: (state = { currentWalletId: 7 }) => state,
        network: (state = { currentNetwork: 'chipnet' }) => state,
        utxos: (
          state = {
            utxos: {
              'bchtest:q1': [
                {
                  address: 'bchtest:q1',
                  height: 1,
                  tx_hash: tx,
                  tx_pos: 0,
                  value: 50_000,
                },
              ],
            },
          }
        ) => state,
      },
    });
    store.dispatch(setCashFusionEnabled(true));
    store.dispatch(setP2pFusionEnabled(true));

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <CashFusionSettings />
      </Provider>
    );

    expect(html).toContain('Start P2P round');
    expect(html).toContain(
      'All coins are reserved by another fusion round'
    );
    expect(html).toMatch(
      /disabled=""[^>]*>Start P2P round/
    );
    clearOutpointReservations(7);
  });

  it.each(['server', 'p2p'] as const)(
    'restores a disabled Fusing control when returning to a running %s round',
    (mode) => {
      const store = configureStore({
        reducer: {
          experimental: experimentalReducer,
          wallet_id: (state = { currentWalletId: 7 }) => state,
          network: (state = { currentNetwork: 'chipnet' }) => state,
          utxos: (state = { utxos: {} }) => state,
        },
      });
      store.dispatch(setCashFusionEnabled(true));
      store.dispatch(setP2pFusionEnabled(mode === 'p2p'));
      activityState.current = {
        walletId: 7,
        mode,
        trigger: 'manual',
        startedAt: 1,
      };

      const html = renderToStaticMarkup(
        <Provider store={store}>
          <CashFusionSettings />
        </Provider>
      );

      expect(html).toContain('Fusing…');
      expect(html).toContain('disabled=""');
      expect(html).not.toContain('Running P2P round…');
    }
  );
});

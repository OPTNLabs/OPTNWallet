/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { encodeCashAddress } from '@bitauth/libauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UTXO } from '../../../../types/types';
import type { RootState } from '../../../../state/store';
import useSimpleSend from '../../../../hooks/useSimpleSend';

const mocks = vi.hoisted(() => ({
  desktop: true,
  state: {} as RootState,
  invoke: vi.fn(),
  planner: vi.fn(),
  send: vi.fn(),
  sign: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../../../utils/platform', () => ({
  isDesktopPlatform: () => mocks.desktop,
}));
vi.mock('react-redux', () => ({
  useSelector: (select: (state: RootState) => unknown) => select(mocks.state),
}));
vi.mock('../../../../state/store', () => ({
  store: { getState: () => mocks.state },
}));
vi.mock('../../../../hooks/useFetchWalletAddresses', () => ({
  default: vi.fn(),
}));
vi.mock('../../../../services/UTXOService', () => ({
  default: {
    fetchAllWalletUtxos: mocks.fetch,
    fetchAndStoreUTXOsMany: vi.fn(),
  },
}));
vi.mock('../../../../apis/AddressManager/AddressManager', () => ({
  default: () => ({
    fetchTokenAddress: async (_wallet: number, address: string) => address,
  }),
}));
vi.mock('../../../../services/TransactionService', () => ({
  default: { sendTransaction: mocks.send },
}));
vi.mock('../../../../hooks/simple-send/planner', () => ({
  createSimpleSendPlanner: mocks.planner,
}));
vi.mock('../../../../services/hardware/hardwareSignTransaction', () => ({
  signHardwarePayment: mocks.sign,
}));
vi.mock('../../../../services/KeyService', () => ({ default: {} }));
vi.mock('../../../../services/RpaService', () => ({
  getRpaSendBlockReason: () => null,
  looksLikeRpaPaycode: () => false,
  decodePaycode: vi.fn(),
}));
vi.mock('../../../../services/RpaSender', () => ({
  finalizeRpaPayment: vi.fn(),
  makeRpaDummyAddress: vi.fn(),
}));
vi.mock('../../CoinLabelService', () => ({
  outpointKey: (txid: string, vout: number) => `${txid.toLowerCase()}:${vout}`,
}));
vi.mock('../../fusionSpendPolicy', () => ({
  applySpendOnlyFusedPolicy: (_wallet: number, coins: UTXO[]) => coins,
}));

const ADDRESS = encodeCashAddress({
  prefix: 'bchtest',
  type: 'p2pkh',
  payload: new Uint8Array(20).fill(1),
}).address;
const FROZEN = 'ab'.repeat(32);
const PLEDGED = 'cd'.repeat(32);
const FREE = 'ef'.repeat(32);
const coins: UTXO[] = [FROZEN.toUpperCase(), PLEDGED, FREE].map((tx_hash) => ({
  tx_hash,
  tx_pos: 0,
  amount: 50_000,
  value: 50_000,
  height: 1,
  address: ADDRESS,
}));
const holds = [
  { txid: FROZEN, vout: 0, reason: 'user' },
  { txid: PLEDGED, vout: 0, reason: 'flipstarter-pledge' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = true;
  mocks.state = {
    wallet_id: {
      currentWalletId: 11,
      walletType: 'standard',
      networkType: 'chipnet',
      sessionGeneration: 1,
    },
    network: { currentNetwork: 'chipnet' },
    priceFeed: {},
    preferences: {},
    experimental: {},
    utxos: { utxos: {} },
  } as RootState;
  mocks.invoke.mockReset().mockResolvedValue(holds);
  mocks.fetch.mockResolvedValue({ allUtxos: coins, tokenUtxos: [] });
  mocks.planner.mockImplementation(({ dbUtxos }: { dbUtxos: UTXO[] }) => {
    const result = {
      ok: true,
      inputs: dbUtxos,
      rawTx: 'unsigned-fixture',
      feeSats: 100,
      totalSats: 1000,
      finalOutputs: [{ recipientAddress: ADDRESS, amount: 1000 }],
    };
    return {
      addBchOnlyUntilBuild: async () => result,
      estimateSweepAllBch: () => result,
    };
  });
});
afterEach(cleanup);

async function setup(selected = [FROZEN, PLEDGED, FREE]) {
  const hook = renderHook(() => useSimpleSend());
  await waitFor(() => expect(hook.result.current.dbUtxos).toHaveLength(3));
  act(() => {
    hook.result.current.setRecipient(ADDRESS);
    hook.result.current.setAmountBch('0.00001');
    hook.result.current.setSelectedChangeAddress(ADDRESS);
    hook.result.current.setCoinControlEnabled(true);
    hook.result.current.setSelectedCoinKeys(
      new Set(selected.map((txid) => `${txid}:0`))
    );
  });
  return hook;
}

describe('retained Simple Send hold adapter', () => {
  it.each(['doReview', 'doMax'] as const)(
    '%s never reintroduces manually selected frozen or pledged coins',
    async (action) => {
      const { result } = await setup();
      await act(async () => {
        await result.current[action]();
      });
      expect(result.current.error).toBe('');
      expect(mocks.planner).toHaveBeenCalledWith(
        expect.objectContaining({ dbUtxos: [coins[2]] })
      );
      expect(mocks.invoke).toHaveBeenCalledWith('optn_coin_holds', {
        walletId: 11,
      });
    }
  );

  it.each([FROZEN, PLEDGED])(
    'refuses manual selection containing only held coin %s',
    async (txid) => {
      const { result } = await setup([txid]);
      await act(async () => {
        await result.current.doReview();
      });
      expect(result.current.mode).toBe('error');
      expect(result.current.error).toContain('None of the selected coins');
      expect(mocks.planner).not.toHaveBeenCalled();
    }
  );

  it.each(['doReview', 'doMax'] as const)(
    '%s surfaces an unreadable hold record and does not build',
    async (action) => {
      const { result } = await setup();
      mocks.invoke.mockRejectedValue('coin holds file is unreadable');
      await act(async () => {
        await result.current[action]();
      });
      expect(result.current.error).toContain('coin holds file is unreadable');
      expect(result.current.mode).toBe('error');
      expect(mocks.planner).not.toHaveBeenCalled();
    }
  );

  it.each(['hold', 'unreadable'] as const)(
    'refuses %s added after review before hardware signing or broadcast',
    async (failure) => {
      mocks.state.wallet_id.walletType = 'hardware';
      const { result } = await setup([FREE]);
      await act(async () => {
        await result.current.doReview();
      });
      expect(result.current.mode).toBe('review');
      if (failure === 'hold')
        mocks.invoke.mockResolvedValue([
          { txid: FREE, vout: 0, reason: 'user' },
        ]);
      else mocks.invoke.mockRejectedValue('unreadable holds');
      await act(async () => {
        await result.current.doSend();
      });
      expect(result.current.mode).toBe('error');
      expect(result.current.error).toMatch(
        /frozen or reserved|unreadable holds/
      );
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    }
  );

  it.each(['wallet', 'network', 'session'] as const)(
    'invalidates a review on a %s change',
    async (change) => {
      const { result, rerender } = await setup([FREE]);
      await act(async () => {
        await result.current.doReview();
      });
      if (change === 'wallet') mocks.state.wallet_id.currentWalletId = 42;
      if (change === 'network')
        mocks.state.wallet_id.networkType =
          'mainnet' as RootState['wallet_id']['networkType'];
      if (change === 'session') mocks.state.wallet_id.sessionGeneration += 1;
      rerender();
      await act(async () => {
        await result.current.doSend();
      });
      expect(result.current.error).toContain('Wallet or network changed');
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.sign).not.toHaveBeenCalled();
    }
  );

  it('rejects a wallet switch during an in-flight Rust hold read', async () => {
    const { result } = await setup([FREE]);
    mocks.invoke.mockImplementation(async () => {
      mocks.state.wallet_id.currentWalletId = 42;
      return [];
    });
    await act(async () => {
      await result.current.doReview();
    });
    expect(result.current.error).toContain('Wallet or network changed');
    expect(mocks.planner).not.toHaveBeenCalled();
  });

  it('preserves non-desktop Max, Review and Send without desktop hold IPC', async () => {
    mocks.desktop = false;
    mocks.invoke.mockRejectedValue('desktop holds unsupported');
    mocks.send.mockResolvedValue({ txid: 'mock-only', errorMessage: null });
    const { result } = await setup();
    await act(async () => {
      await result.current.doMax();
    });
    await act(async () => {
      await result.current.doReview();
    });
    expect(result.current.mode).toBe('review');
    expect(mocks.planner).toHaveBeenLastCalledWith(
      expect.objectContaining({ dbUtxos: coins })
    );
    await act(async () => {
      await result.current.doSend();
    });
    expect(result.current.mode).toBe('sent');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});

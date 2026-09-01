/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listActiveMock,
  subscribeMock,
  runOutboundReconcileMock,
  reconcileMock,
} = vi.hoisted(() => ({
  listActiveMock: vi.fn(),
  subscribeMock: vi.fn(() => () => undefined),
  runOutboundReconcileMock: vi.fn(),
  reconcileMock: vi.fn(),
}));

vi.mock('../../services/OutboundTransactionTracker', () => ({
  default: {
    listActive: listActiveMock,
    subscribe: subscribeMock,
    canRelease: vi.fn(() => false),
    canClear: vi.fn(() => false),
  },
  OUTBOUND_RELEASE_DELAY_MS: 20 * 60 * 1000,
}));

vi.mock('../../services/OutboundTransactionReconciler', () => ({
  reconcileOutboundTransactions: reconcileMock,
}));

vi.mock('../../services/RefreshCoordinator', () => ({
  runOutboundReconcile: runOutboundReconcileMock,
}));

import useOutboundTransactions from '../useOutboundTransactions';

function Harness({ walletId = 7 }: { walletId?: number }) {
  const { reconciling } = useOutboundTransactions(walletId);
  return <output>{String(reconciling)}</output>;
}

function WalletStateHarness({ walletId }: { walletId: number }) {
  const { unresolvedCount, reservedOutpointKeys } =
    useOutboundTransactions(walletId);
  return (
    <output data-testid="wallet-state">
      {`${unresolvedCount}:${Array.from(reservedOutpointKeys).join(',')}`}
    </output>
  );
}

describe('useOutboundTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActiveMock.mockResolvedValue([]);
    reconcileMock.mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it('does not restart the mount refresh when reconciliation state changes', async () => {
    let finishReconcile!: () => void;
    const reconciliation = new Promise<void>((resolve) => {
      finishReconcile = resolve;
    });
    runOutboundReconcileMock.mockReturnValue(reconciliation);

    render(<Harness />);

    await waitFor(() => {
      expect(runOutboundReconcileMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText('true')).toBeTruthy();
    });

    finishReconcile();

    await waitFor(() => {
      expect(screen.getByText('false')).toBeTruthy();
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runOutboundReconcileMock).toHaveBeenCalledTimes(1);
  });

  it('clears previous-wallet records before the next wallet load resolves', async () => {
    let resolveWalletEight!: (records: unknown[]) => void;
    const walletEightRecords = new Promise<unknown[]>((resolve) => {
      resolveWalletEight = resolve;
    });
    const oldRecord = {
      txid: 'old-wallet-tx',
      spentOutpoints: [{ tx_hash: 'old-hash', tx_pos: 2 }],
    };
    const newRecord = {
      txid: 'new-wallet-tx',
      spentOutpoints: [{ tx_hash: 'new-hash', tx_pos: 3 }],
    };

    listActiveMock.mockImplementation((walletId: number) =>
      walletId === 7 ? Promise.resolve([oldRecord]) : walletEightRecords
    );
    runOutboundReconcileMock.mockResolvedValue(undefined);

    const rendered = render(<WalletStateHarness walletId={7} />);
    await waitFor(() => {
      expect(screen.getByTestId('wallet-state').textContent).toBe(
        '1:old-hash:2'
      );
    });

    rendered.rerender(<WalletStateHarness walletId={8} />);
    expect(screen.getByTestId('wallet-state').textContent).toBe('0:');

    resolveWalletEight([newRecord]);
    await waitFor(() => {
      expect(screen.getByTestId('wallet-state').textContent).toBe(
        '1:new-hash:3'
      );
    });
  });

  it('refreshes a new wallet while the previous wallet is reconciling', async () => {
    let finishFirst!: () => void;
    const firstReconciliation = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    runOutboundReconcileMock.mockImplementation((walletId: number) =>
      walletId === 7 ? firstReconciliation : Promise.resolve()
    );

    const rendered = render(<Harness walletId={7} />);
    await waitFor(() => {
      expect(runOutboundReconcileMock).toHaveBeenCalledWith(
        7,
        expect.any(Function)
      );
    });

    rendered.rerender(<Harness walletId={8} />);
    await waitFor(() => {
      expect(runOutboundReconcileMock).toHaveBeenCalledWith(
        8,
        expect.any(Function)
      );
    });

    finishFirst();
    await waitFor(() => {
      expect(screen.getByText('false')).toBeTruthy();
    });
  });
});

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

function Harness() {
  const { reconciling } = useOutboundTransactions(7);
  return <output>{String(reconciling)}</output>;
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
});

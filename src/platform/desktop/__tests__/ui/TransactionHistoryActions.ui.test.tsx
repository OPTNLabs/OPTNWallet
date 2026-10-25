/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TransactionHistoryItem } from '../../../../types/types';

const mocks = vi.hoisted(() => ({
  state: {
    transactions: {
      transactions: {} as Record<string, TransactionHistoryItem[]>,
    },
    utxos: { initialized: true },
    wallet_id: { sessionGeneration: 3 },
  },
  explorer: {
    tx: vi.fn(),
    reason: 'Public explorer access is disabled by your server policy.',
  },
  locationState: null as {
    openTransaction?: { txid?: string; height?: number };
  } | null,
  fetch: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) => selector(mocks.state),
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ wallet_id: '7' }),
  useLocation: () => ({ state: mocks.locationState }),
}));
vi.mock('../../../../state/selectors/networkSelectors', () => ({
  selectCurrentNetwork: () => 'chipnet',
}));
vi.mock('../../../../utils/servers/useExplorerLink', () => ({
  useExplorerLink: () => mocks.explorer,
}));
vi.mock(
  '../../../../features/transaction-history/useTransactionHistoryFetch',
  () => ({
    useTransactionHistoryFetch: () => ({
      loading: false,
      error: false,
      fetchTransactionHistory: mocks.fetch,
    }),
  })
);
vi.mock(
  '../../../../features/transaction-history/useTransactionHistoryPagination',
  () => ({
    useTransactionHistoryPagination: ({
      transactions,
    }: {
      transactions: TransactionHistoryItem[];
    }) => ({
      sortOrder: 'desc',
      transactionsPerPage: 10,
      currentPage: 1,
      totalPages: 1,
      hasTransactions: transactions.length > 0,
      paginatedTransactions: transactions,
      toggleSortOrder: vi.fn(),
      handleTransactionsPerPageChange: vi.fn(),
      handleNextPage: vi.fn(),
      handlePreviousPage: vi.fn(),
      handleFirstPage: vi.fn(),
      handleLastPage: vi.fn(),
    }),
  })
);
vi.mock('../../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted: async () => undefined,
    getDatabase: () => ({
      prepare: () => ({
        bind: vi.fn(),
        step: () => false,
        free: vi.fn(),
      }),
    }),
  }),
}));
vi.mock('../../../../services/QuantumrootTrackingService', () => ({
  default: { listTrackedAddresses: async () => [] },
}));
vi.mock('../../../../platform/desktop/useFusionDepthRevision', () => ({
  useFusionDepthRevision: () => 0,
}));
vi.mock('../../../../platform/desktop/fusionCoinDepth', () => ({
  isFusionTransaction: () => false,
}));
vi.mock(
  '../../../../features/transaction-history/TransactionDetailPopup',
  () => ({
    default: ({
      txid,
      explorerUrl,
    }: {
      txid: string;
      explorerUrl: string | null;
    }) => (
      <div
        role="dialog"
        data-txid={txid}
        data-explorer-url={explorerUrl ?? ''}
      />
    ),
  })
);
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: { count?: number }) =>
      key === 'history.recorded' ? `${values?.count} recorded` : key,
  }),
}));

import TransactionHistory from '../../../../features/transaction-history/TransactionHistory';

const transaction = {
  tx_hash: 'a'.repeat(64),
  height: 100,
  timestamp: '2026-01-01T00:00:00.000Z',
} as TransactionHistoryItem;

function renderHistory(rows: TransactionHistoryItem[]) {
  mocks.state.transactions.transactions = { '7': rows };
  return render(<TransactionHistory />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.transactions = { transactions: {} };
  mocks.locationState = null;
  mocks.explorer.tx.mockReturnValue('https://explorer.example/tx/test');
});
afterEach(cleanup);

it('opens the selected-network explorer from transaction details', () => {
  renderHistory([transaction]);

  const detailsAction = screen.getByRole('button', {
    name: /history\.transactionHash/,
  });
  expect(
    screen.getByRole('button', { name: 'history.previousPage' })
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'history.nextPage' })
  ).toBeDisabled();
  expect(
    screen.getByRole('combobox', { name: 'history.perPageLabel' })
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'history.sync' })).toBeEnabled();
  expect(
    screen.queryByRole('link', { name: 'history.openExplorer' })
  ).toBeNull();
  fireEvent.click(detailsAction);
  expect(mocks.explorer.tx).toHaveBeenCalledWith(
    'chipnet',
    transaction.tx_hash
  );
  expect(screen.getByRole('dialog')).toHaveAttribute(
    'data-explorer-url',
    'https://explorer.example/tx/test'
  );
});

it('does not add a confusing server-settings detour when no URL is available', () => {
  mocks.explorer.tx.mockReturnValue(null);
  renderHistory([transaction]);

  expect(
    screen.queryByRole('link', { name: 'history.openExplorer' })
  ).toBeNull();
  expect(screen.queryByRole('link', { name: 'nav.settings' })).toBeNull();
});

it('opens the transaction passed from Home activity', () => {
  mocks.locationState = {
    openTransaction: { txid: transaction.tx_hash, height: transaction.height },
  };
  renderHistory([transaction]);

  expect(screen.getByRole('dialog')).toHaveAttribute(
    'data-txid',
    transaction.tx_hash
  );
  expect(mocks.explorer.tx).toHaveBeenCalledWith(
    'chipnet',
    transaction.tx_hash
  );
});

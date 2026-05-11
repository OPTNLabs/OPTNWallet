import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../state/store';
import { useParams } from 'react-router-dom';
import { createSelector } from 'reselect';
import { shortenTxHash } from '../../utils/shortenHash';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { Network } from '../../state/slices/networkSlice';
import { useTransactionHistoryFetch } from './useTransactionHistoryFetch';
import { useTransactionHistoryPagination } from './useTransactionHistoryPagination';
import PageHeader from '../../components/ui/PageHeader';
import EmptyState from '../../components/ui/EmptyState';
import StatusChip from '../../components/ui/StatusChip';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import TransactionDetailPopup from './TransactionDetailPopup';
import QuantumrootTrackingService from '../../services/QuantumrootTrackingService';
import WalletScreen from '../../components/ui/WalletScreen';
import type { TransactionHistoryItem } from '../../types/types';

const EMPTY_TRANSACTIONS: TransactionHistoryItem[] = [];

const selectTransactions = createSelector(
  (state: RootState) => state.transactions.transactions,
  (_: RootState, wallet_id: string) => wallet_id,
  (transactions, wallet_id) => transactions[wallet_id] ?? EMPTY_TRANSACTIONS
);

const TransactionHistory: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { wallet_id } = useParams<{ wallet_id: string }>();
  const transactions = useSelector((state: RootState) =>
    selectTransactions(state, wallet_id || '')
  );
  const IsInitialized = useSelector(
    (state: RootState) => state.utxos.initialized
  );

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const [selectedTx, setSelectedTx] = useState<{
    txid: string;
    height: number;
  } | null>(null);
  const [walletAddresses, setWalletAddresses] = useState<Set<string>>(new Set());

  const { loading, fetchTransactionHistory } =
    useTransactionHistoryFetch({
      walletIdParam: wallet_id,
      isInitialized: IsInitialized,
      transactionCount: transactions.length,
      dispatch,
    });

  const {
    sortOrder,
    transactionsPerPage,
    currentPage,
    totalPages,
    hasTransactions,
    paginatedTransactions,
    toggleSortOrder,
    handleTransactionsPerPageChange,
    handleNextPage,
    handlePreviousPage,
    handleFirstPage,
    handleLastPage,
  } = useTransactionHistoryPagination({ transactions });

  const explorerBase = useMemo(
    () =>
      currentNetwork === Network.CHIPNET
        ? 'https://chipnet.bch.ninja/tx/'
        : 'https://explorer.bch.ninja/tx/',
    [currentNetwork]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadWalletAddresses() {
      if (!wallet_id) return;
      const dbService = DatabaseService();
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (!db) return;

      const stmt = db.prepare(`
        SELECT address FROM addresses WHERE wallet_id = ?;
      `);
      stmt.bind([wallet_id]);

      const next = new Set<string>();
      while (stmt.step()) {
        const row = stmt.getAsObject();
        if (typeof row.address === 'string' && row.address) {
          next.add(row.address);
        }
      }
      stmt.free();

      const quantumrootAddresses = await QuantumrootTrackingService.listTrackedAddresses(
        Number(wallet_id)
      );
      for (const address of quantumrootAddresses) {
        next.add(address);
      }

      if (!cancelled) {
        setWalletAddresses(next);
      }
    }

    void loadWalletAddresses();
    return () => {
      cancelled = true;
    };
  }, [wallet_id]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title="Transaction History"
          subtitle={hasTransactions ? `${transactions.length} recorded` : 'No activity yet'}
          compact
        />

        <div className="wallet-card p-3 shrink-0">
          <div className="grid grid-cols-10 gap-2">
            <button
              onClick={toggleSortOrder}
              className="wallet-btn-secondary col-span-4 py-2 px-3 text-sm"
            >
              {sortOrder === 'asc' ? 'Oldest first' : 'Newest first'}
            </button>
            <select
              value={transactionsPerPage}
              onChange={handleTransactionsPerPageChange}
              className="wallet-input col-span-4 py-1.5 px-3 text-sm"
            >
              <option value={10}>10 per page</option>
              <option value={20}>20 per page</option>
              <option value={30}>30 per page</option>
            </select>
            <button
              onClick={fetchTransactionHistory}
              className="wallet-btn-secondary col-span-2 py-1.5 px-3 text-sm"
              disabled={loading}
            >
              {loading ? (
                <span className="flex items-center justify-center">
                  <span className="wallet-spinner" aria-hidden="true" />
                </span>
              ) : (
                'Sync'
              )}
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {!hasTransactions ? (
            <EmptyState message="No transactions available yet." />
          ) : (
            <ul className="h-full space-y-3 overflow-y-auto overscroll-contain pr-1">
              {paginatedTransactions.map((tx, id) => (
                <li key={id + tx.tx_hash}>
                  <button
                    type="button"
                    onClick={() => setSelectedTx({ txid: tx.tx_hash, height: tx.height })}
                    className="wallet-card p-4 block w-full text-left hover:brightness-[0.98] transition"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs wallet-muted mb-1">
                          Transaction Hash
                        </div>
                        <div className="font-mono text-sm break-all wallet-text-strong">
                          {shortenTxHash(tx.tx_hash)}
                        </div>
                      </div>
                      {tx.height > 0 ? (
                        <StatusChip tone="success">Confirmed</StatusChip>
                      ) : (
                        <StatusChip tone="warning">Pending</StatusChip>
                      )}
                    </div>
                    <div className="mt-2 text-sm">
                      {tx.height > 0 ? (
                        <span className="wallet-text-strong">
                          Block: {tx.height}
                        </span>
                      ) : (
                        <span className="wallet-muted">
                          Awaiting confirmation
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="wallet-card shrink-0 p-3 flex items-center justify-between gap-2 mb-[calc(var(--safe-bottom)+1rem)]">
          <button
            onClick={handleFirstPage}
            className="wallet-btn-secondary py-2 px-3 text-sm font-bold"
            disabled={!hasTransactions || currentPage === 1}
          >
          First
        </button>
        <button
          onClick={handlePreviousPage}
          className="wallet-btn-secondary py-2 px-3 text-sm font-bold"
          disabled={!hasTransactions || currentPage === 1}
        >
          {'<'}
        </button>
        <div className="py-2 text-sm wallet-text-strong min-w-[56px] text-center">
          {hasTransactions ? `${currentPage}/${totalPages}` : '0/0'}
        </div>
        <button
          onClick={handleNextPage}
          className="wallet-btn-secondary py-2 px-3 text-sm font-bold"
          disabled={!hasTransactions || currentPage === totalPages}
        >
          {'>'}
        </button>
          <button
            onClick={handleLastPage}
            className="wallet-btn-secondary py-2 px-3 text-sm font-bold"
            disabled={!hasTransactions || currentPage === totalPages}
          >
            Last
          </button>
        </div>

        {selectedTx ? (
          <TransactionDetailPopup
            txid={selectedTx.txid}
            txHeight={selectedTx.height}
            explorerUrl={`${explorerBase}${selectedTx.txid}`}
            walletAddresses={walletAddresses}
            onClose={() => setSelectedTx(null)}
          />
        ) : null}
      </div>
    </WalletScreen>
  );
};

export default TransactionHistory;

import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../redux/store';
import { useParams } from 'react-router-dom';
import { createSelector } from 'reselect';
import { shortenTxHash } from '../utils/shortenHash';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { Network } from '../redux/networkSlice';
import { useTransactionHistoryFetch } from './transaction-history/useTransactionHistoryFetch';
import { useTransactionHistoryPagination } from './transaction-history/useTransactionHistoryPagination';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import StatusChip from '../components/ui/StatusChip';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import TransactionDetailPopup from './transaction-history/TransactionDetailPopup';
import QuantumrootTrackingService from '../services/QuantumrootTrackingService';

const selectTransactions = createSelector(
  (state: RootState) => state.transactions.transactions,
  (_: RootState, wallet_id: string) => wallet_id,
  (transactions, wallet_id) => transactions[wallet_id] || []
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
	    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-3 flex flex-col overflow-hidden wallet-page">
	      <PageHeader title="Transaction History" compact />

      <div className="wallet-card p-3 mb-3 shrink-0">
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

      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        {!hasTransactions ? (
          <EmptyState message="No transactions available yet." />
        ) : (
          <ul className="space-y-3">
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

      <div className="wallet-card mt-3 p-3 flex items-center justify-between gap-2 shrink-0">
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
  );
};

export default TransactionHistory;

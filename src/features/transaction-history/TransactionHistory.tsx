import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../state/store';
import { useLocation, useParams } from 'react-router-dom';
import { createSelector } from 'reselect';
import { shortenTxHash } from '../../utils/shortenHash';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { useExplorerLink } from '../../utils/servers/useExplorerLink';
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
import { isFusionTransaction } from '../../platform/desktop/fusionCoinDepth';
import { useFusionDepthRevision } from '../../platform/desktop/useFusionDepthRevision';
import { FusionBadge } from '../../components/FusionBadge';
import { isTxConfirmed } from '../../utils/txConfirmation';
import { isMempoolLike } from '../../utils/transactionHistoryOrder';
import { useI18n } from '../../i18n/useI18n';

const EMPTY_TRANSACTIONS: TransactionHistoryItem[] = [];

type TransactionHistoryLocationState = {
  openTransaction?: {
    txid?: string;
    height?: number;
  };
};

const selectTransactions = createSelector(
  (state: RootState) => state.transactions.transactions,
  (_: RootState, wallet_id: string) => wallet_id,
  (transactions, wallet_id) => transactions[wallet_id] ?? EMPTY_TRANSACTIONS
);

const TransactionHistory: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { t } = useI18n();
  const location = useLocation();
  const { wallet_id } = useParams<{ wallet_id: string }>();
  const openTransaction = (
    location.state as TransactionHistoryLocationState | null | undefined
  )?.openTransaction;
  const walletIdNum = Number(wallet_id);
  const fusionDepthRev = useFusionDepthRevision(
    Number.isFinite(walletIdNum) && walletIdNum > 0 ? walletIdNum : 0
  );
  const transactions = useSelector((state: RootState) =>
    selectTransactions(state, wallet_id || '')
  );
  const IsInitialized = useSelector(
    (state: RootState) => state.utxos.initialized
  );
  const sessionGeneration = useSelector(
    (state: RootState) => state.wallet_id.sessionGeneration ?? 0
  );

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const [selectedTx, setSelectedTx] = useState<{
    txid: string;
    height: number;
  } | null>(() =>
    openTransaction?.txid
      ? {
          txid: openTransaction.txid,
          height: openTransaction.height ?? 0,
        }
      : null
  );
  const [walletAddresses, setWalletAddresses] = useState<Set<string>>(
    new Set()
  );

  const {
    loading,
    error: historyError,
    fetchTransactionHistory,
  } = useTransactionHistoryFetch({
    walletIdParam: wallet_id,
    isInitialized: IsInitialized,
    transactionCount: transactions.length,
    sessionGeneration,
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

  const explorer = useExplorerLink();

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

      const quantumrootAddresses =
        await QuantumrootTrackingService.listTrackedAddresses(
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
          title={t('history.title')}
          subtitle={
            currentNetwork === 'chipnet' ? t('network.chipnet') : undefined
          }
          compact
        />

        <div className="wallet-card p-3 shrink-0">
          <div className="grid grid-cols-10 gap-2">
            <button
              onClick={toggleSortOrder}
              className="wallet-btn-secondary col-span-4 py-2 px-3 text-sm"
            >
              {sortOrder === 'asc'
                ? t('history.oldestFirst')
                : t('history.newestFirst')}
            </button>
            <select
              aria-label={t('history.perPageLabel')}
              value={transactionsPerPage}
              onChange={handleTransactionsPerPageChange}
              className="wallet-input col-span-4 py-1.5 px-3 text-sm"
            >
              <option value={10}>{t('history.perPage', { count: 10 })}</option>
              <option value={20}>{t('history.perPage', { count: 20 })}</option>
              <option value={30}>{t('history.perPage', { count: 30 })}</option>
            </select>
            <button
              onClick={fetchTransactionHistory}
              className="wallet-btn-secondary col-span-2 py-1.5 px-3 text-sm"
              disabled={loading}
              aria-label={loading ? t('history.syncing') : t('history.sync')}
              aria-busy={loading}
            >
              {loading ? (
                <span
                  className="flex items-center justify-center"
                  aria-hidden="true"
                >
                  <span className="wallet-spinner" aria-hidden="true" />
                </span>
              ) : (
                t('history.sync')
              )}
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {!hasTransactions ? (
            loading ? (
              <div
                className="wallet-card p-4 text-center wallet-muted"
                role="status"
                aria-live="polite"
              >
                {t('history.loading')}
              </div>
            ) : historyError ? (
              <div className="wallet-card p-4 text-center" role="alert">
                <p className="wallet-text-strong">{t('history.loadFailed')}</p>
                <button
                  type="button"
                  onClick={fetchTransactionHistory}
                  className="wallet-btn-secondary mt-3 min-h-[44px] px-4 py-2"
                >
                  {t('builder.tryAgain')}
                </button>
              </div>
            ) : (
              <EmptyState message={t('history.noTransactions')} />
            )
          ) : (
            <ul className="h-full space-y-3 overflow-y-auto overscroll-contain pr-1">
              {paginatedTransactions.map((tx, id) => {
                void fusionDepthRev;
                const fused =
                  Number.isFinite(walletIdNum) &&
                  walletIdNum > 0 &&
                  isFusionTransaction(walletIdNum, tx.tx_hash);
                return (
                  <li key={id + tx.tx_hash}>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedTx({ txid: tx.tx_hash, height: tx.height })
                      }
                      className="wallet-card p-4 block w-full text-left hover:brightness-[0.98] transition"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs wallet-muted mb-1">
                            {t('history.transactionHash')}
                          </div>
                          <div className="font-mono text-sm break-all wallet-text-strong">
                            {shortenTxHash(tx.tx_hash)}
                            {fused && <FusionBadge asTx className="ml-2" />}
                          </div>
                        </div>
                        {isTxConfirmed(tx) || !isMempoolLike(tx) ? (
                          <StatusChip tone="success">
                            {fused
                              ? `Fused · ${t('history.confirmed')}`
                              : t('history.confirmed')}
                          </StatusChip>
                        ) : (
                          <StatusChip tone="warning">
                            {fused
                              ? `Fused · ${t('history.unconfirmed')}`
                              : t('history.unconfirmed')}
                          </StatusChip>
                        )}
                      </div>
                      <div className="mt-2 text-sm">
                        {tx.height > 0 || tx.timestamp ? (
                          <span className="wallet-text-strong">
                            {t('history.block')}: {tx.height || '—'}
                          </span>
                        ) : isTxConfirmed(tx) ? (
                          <span className="wallet-text-strong">
                            {t('history.confirmed')}
                          </span>
                        ) : isMempoolLike(tx) ? (
                          <span className="wallet-muted">
                            {fused
                              ? 'Broadcast — waiting for a block (height not yet in history)'
                              : t('history.awaitingConfirmation')}
                          </span>
                        ) : (
                          <span className="wallet-text-strong">
                            {fused ? 'On chain' : t('history.confirmed')}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="wallet-card shrink-0 p-3 flex items-center justify-between gap-2 mb-[calc(var(--safe-bottom)+1rem)]">
          <button
            onClick={handleFirstPage}
            className="wallet-btn-secondary min-h-[44px] py-2 px-3 text-sm font-bold"
            disabled={!hasTransactions || currentPage === 1}
          >
            {t('history.first')}
          </button>
          <button
            onClick={handlePreviousPage}
            className="wallet-btn-secondary min-h-[44px] min-w-[44px] py-2 px-3 text-sm font-bold"
            disabled={!hasTransactions || currentPage === 1}
            aria-label={t('history.previousPage')}
          >
            <span aria-hidden="true">{'<'}</span>
          </button>
          <div className="py-2 text-sm wallet-text-strong min-w-[56px] text-center">
            {hasTransactions ? `${currentPage}/${totalPages}` : '0/0'}
          </div>
          <button
            onClick={handleNextPage}
            className="wallet-btn-secondary min-h-[44px] min-w-[44px] py-2 px-3 text-sm font-bold"
            disabled={!hasTransactions || currentPage === totalPages}
            aria-label={t('history.nextPage')}
          >
            <span aria-hidden="true">{'>'}</span>
          </button>
          <button
            onClick={handleLastPage}
            className="wallet-btn-secondary min-h-[44px] py-2 px-3 text-sm font-bold"
            disabled={!hasTransactions || currentPage === totalPages}
          >
            {t('history.last')}
          </button>
        </div>

        {selectedTx ? (
          <TransactionDetailPopup
            txid={selectedTx.txid}
            txHeight={selectedTx.height}
            explorerUrl={explorer.tx(currentNetwork, selectedTx.txid)}
            explorerReason={explorer.reason}
            walletAddresses={walletAddresses}
            onClose={() => setSelectedTx(null)}
          />
        ) : null}
      </div>
    </WalletScreen>
  );
};

export default TransactionHistory;

import React, { useState, useCallback, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import { addTransactions } from '../redux/transactionSlice';
import { useParams } from 'react-router-dom';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { createSelector } from 'reselect';
import { shortenTxHash } from '../utils/shortenHash';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { Network } from '../redux/networkSlice';
import { TransactionHistoryItem } from '../types/types';

const selectTransactions = createSelector(
  (state: RootState) => state.transactions.transactions,
  (_: RootState, wallet_id: string) => wallet_id,
  (transactions, wallet_id) => transactions[wallet_id] || []
);

const TransactionHistory: React.FC = () => {
  const dispatch = useDispatch();
  const { wallet_id } = useParams<{ wallet_id: string }>();
  const transactions = useSelector((state: RootState) =>
    selectTransactions(state, wallet_id || '')
  );
  const IsInitialized = useSelector(
    (state: RootState) => state.utxos.initialized
  );
  const [progress, setProgress] = useState(0);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(false);
  const [fetchedAddresses, setFetchedAddresses] = useState<Set<string>>(
    new Set()
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [transactionsPerPage, setTransactionsPerPage] = useState(10);
  const [navBarHeight, setNavBarHeight] = useState(0);
  const dbService = DatabaseService();

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  useEffect(() => {
    const adjustHeight = () => {
      const bottomNavBar = document.getElementById('bottomNavBar');
      if (bottomNavBar) {
        setNavBarHeight(bottomNavBar.offsetHeight * 1.75);
      }
    };
    adjustHeight();
    window.addEventListener('resize', adjustHeight);
    return () => {
      window.removeEventListener('resize', adjustHeight);
    };
  }, []);

  useEffect(() => {
    if (IsInitialized && transactions.length === 0 && !loading) {
      fetchTransactionHistory();
    }
  }, [IsInitialized, transactions, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchTransactionHistory = useCallback(async () => {
    if (!wallet_id || loading) return;

    setLoading(true);
    setProgress(0);

    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      if (!db) {
        console.error('Database not started.');
        return; // finally{} will still run and clear loading
      }

      const addressesQuery = db.prepare(`
        SELECT address FROM addresses WHERE wallet_id = ?;
      `);
      addressesQuery.bind([wallet_id]);

      const addresses: string[] = [];
      while (addressesQuery.step()) {
        const result = addressesQuery.getAsObject();
        if (typeof result.address === 'string') {
          addresses.push(result.address);
        }
      }
      addressesQuery.free();

      const totalAddresses = addresses.length;

      // Nothing to scan? Mark done and exit.
      if (totalAddresses === 0) {
        setProgress(100);
        return;
      }

      const transactionManager = TransactionManager();
      const uniqueTransactions = new Set(transactions.map((tx) => tx.tx_hash));

      for (const [index, address] of addresses.entries()) {
        // skip if already fetched
        if (fetchedAddresses.has(address)) {
          setProgress(((index + 1) / totalAddresses) * 100);
          continue;
        }

        const newTransactions: TransactionHistoryItem[] =
          await transactionManager.fetchAndStoreTransactionHistory(
            parseInt(wallet_id, 10),
            address
          );

        // Reopen DB handle (in case manager wrote to it) and pull transactions for this wallet
        const liveDb = dbService.getDatabase();
        if (!liveDb) {
          console.error('Database not started after fetch.');
          return;
        }

        const storedTransactionsQuery = liveDb.prepare(`
          SELECT * FROM transactions WHERE wallet_id = ?;
        `);
        storedTransactionsQuery.bind([wallet_id]);

        while (storedTransactionsQuery.step()) {
          const transaction =
            storedTransactionsQuery.getAsObject() as unknown as TransactionHistoryItem;

          if (
            !uniqueTransactions.has(transaction.tx_hash) ||
            transaction.height === -1 ||
            transaction.height === 0
          ) {
            newTransactions.push({
              ...transaction,
              amount: transaction.amount,
            });
            uniqueTransactions.add(transaction.tx_hash);
          }
        }
        storedTransactionsQuery.free();

        if (newTransactions.length > 0) {
          dispatch(
            addTransactions({
              wallet_id: parseInt(wallet_id, 10),
              transactions: newTransactions,
            })
          );
        }

        // functional update to avoid stale closure
        setFetchedAddresses((prev) => {
          const next = new Set(prev);
          next.add(address);
          return next;
        });

        setProgress(((index + 1) / totalAddresses) * 100);
      }
    } catch (e) {
      console.error('Failed to fetch transaction history:', e);
    } finally {
      // Always clear loading, even if we bailed early.
      setLoading(false);
      setProgress(100);
    }
  }, [wallet_id, loading, dbService, fetchedAddresses, dispatch, transactions]);

  const sortedTransactions = useCallback(() => {
    const unconfirmed = transactions.filter((tx) => tx.height <= 0).reverse();
    const confirmed = transactions.filter((tx) => tx.height > 0);
    const sortedConfirmed = confirmed.sort((a, b) =>
      sortOrder === 'asc' ? a.height - b.height : b.height - a.height
    );
    return [...unconfirmed, ...sortedConfirmed];
  }, [transactions, sortOrder]);

  const toggleSortOrder = () => {
    setSortOrder((prevOrder) => (prevOrder === 'asc' ? 'desc' : 'asc'));
  };

  const handleTransactionsPerPageChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const nextPerPage = parseInt(e.target.value, 10);
    setTransactionsPerPage(nextPerPage);
    setCurrentPage(1);
  };

  // ---- Pagination helpers (clamped & empty-safe) ----
  const hasTransactions = transactions.length > 0;
  const rawTotalPages = Math.ceil(transactions.length / transactionsPerPage);
  const totalPages = Math.max(1, rawTotalPages);

  const handleNextPage = () => {
    if (!hasTransactions) return;
    setCurrentPage((prevPage) => Math.min(prevPage + 1, totalPages));
  };

  const handlePreviousPage = () => {
    if (!hasTransactions) return;
    setCurrentPage((prevPage) => Math.max(prevPage - 1, 1));
  };

  const handleFirstPage = () => {
    if (!hasTransactions) return;
    setCurrentPage(1);
  };

  const handleLastPage = () => {
    if (!hasTransactions) return;
    setCurrentPage(totalPages);
  };

  const paginatedTransactions = sortedTransactions().slice(
    (currentPage - 1) * transactionsPerPage,
    currentPage * transactionsPerPage
  );

  return (
    <div className="flex flex-col h-screen">
      {/* Progress bar */}
      {loading && (
        <div className="w-full h-2 bg-gray-200">
          <div
            className="h-full bg-blue-500"
            style={{ width: `${progress}%` }}
          ></div>
        </div>
      )}

      {/* Header and controls */}
      <div className="sticky top-0 bg-white z-10 p-4">
        <div className="flex justify-center mt-4">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="Welcome"
            className="w-3/4 h-auto"
          />
        </div>
        <h1 className="text-2xl font-bold flex flex-col items-center mb-4">
          Transaction History
        </h1>
        <div className="mb-4 flex flex-col space-y-2 md:space-y-0 md:flex-row md:justify-between">
          <div className="flex justify-between">
            <button
              onClick={toggleSortOrder}
              className="py-1 px-2 bg-gray-200 hover:bg-gray-800 hover:text-white transition duration-300 font-bold rounded md:py-2 md:px-4"
            >
              {sortOrder === 'asc' ? 'Oldest' : 'Newest'}
            </button>
            <select
              value={transactionsPerPage}
              onChange={handleTransactionsPerPageChange}
              className="py-1 px-2 bg-white border rounded md:py-2 md:px-4"
            >
              <option value={10}>10 per page</option>
              <option value={20}>20 per page</option>
              <option value={30}>30 per page</option>
            </select>
          </div>
          <button
            onClick={fetchTransactionHistory}
            className="py-1 px-2 bg-blue-500 hover:bg-blue-600 transition duration-300 font-bold text-white rounded md:py-2 md:px-4 self-center"
            disabled={loading}
          >
            {loading ? 'Fetching...' : 'Fetch Transaction History'}
          </button>
        </div>
      </div>

      {/* Scrollable transactions container */}
      <div className="h-1/2 overflow-y-auto px-4">
        {!hasTransactions ? (
          <p className="text-center">No transactions available.</p>
        ) : (
          <ul className="space-y-4">
            {paginatedTransactions.map((tx, id) => (
              <a
                key={id + tx.tx_hash}
                href={
                  currentNetwork === Network.CHIPNET
                    ? `https://chipnet.bch.ninja/tx/${tx.tx_hash}`
                    : `https://explorer.bch.ninja/tx/${tx.tx_hash}`
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                <li className="p-4 border rounded-lg shadow-md bg-white break-words">
                  <strong>Transaction Hash:</strong> {shortenTxHash(tx.tx_hash)}
                  <p>
                    {tx.height > 0 ? (
                      <strong>Height: {tx.height}</strong>
                    ) : (
                      <strong>Pending Transaction</strong>
                    )}
                  </p>
                </li>
              </a>
            ))}
          </ul>
        )}
      </div>

      {/* Bottom navigation */}
      <div
        id="bottomNavBar"
        className="fixed bottom-0 left-0 right-0 p-4 bg-white z-10 flex justify-between items-center"
        style={{ paddingBottom: navBarHeight }}
      >
        <button
          onClick={handleFirstPage}
          className={`py-2 px-4 mx-1 font-bold rounded ${
            !hasTransactions || currentPage === 1
              ? 'bg-gray-500 text-white'
              : 'bg-gray-200'
          } hover:bg-gray-800 hover:text-white transition duration-300`}
          disabled={!hasTransactions || currentPage === 1}
        >
          First
        </button>
        <button
          onClick={handlePreviousPage}
          className={`py-2 px-4 mx-1 font-bold rounded ${
            !hasTransactions || currentPage === 1
              ? 'bg-gray-500 text-white'
              : 'bg-gray-200'
          } hover:bg-gray-800 hover:text-white transition duration-300`}
          disabled={!hasTransactions || currentPage === 1}
        >
          {'<'}
        </button>
        <div className="py-2">
          {hasTransactions ? `${currentPage}/${totalPages}` : '0/0'}
        </div>
        <button
          onClick={handleNextPage}
          className={`py-2 px-4 mx-1 font-bold rounded ${
            !hasTransactions || currentPage === totalPages
              ? 'bg-gray-500 text-white'
              : 'bg-gray-200'
          } hover:bg-gray-800 hover:text-white transition duration-300`}
          disabled={!hasTransactions || currentPage === totalPages}
        >
          {'>'}
        </button>
        <button
          onClick={handleLastPage}
          className={`py-2 px-4 mx-1 font-bold rounded ${
            !hasTransactions || currentPage === totalPages
              ? 'bg-gray-500 text-white'
              : 'bg-gray-200'
          } hover:bg-gray-800 hover:text-white transition duration-300`}
          disabled={!hasTransactions || currentPage === totalPages}
        >
          Last
        </button>
      </div>
    </div>
  );
};

export default TransactionHistory;

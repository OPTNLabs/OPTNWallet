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
  const [progress, setProgress] = useState(0); // Track progress of loading
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc'); // Track sort order
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
    // Adjust the height of the container based on the navbar height
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

  // Fetch transaction history if not already loaded and IsInitialized is true
  useEffect(() => {
    if (IsInitialized && transactions.length === 0 && !loading) {
      fetchTransactionHistory();
    }
  }, [IsInitialized, transactions, loading]);

  const fetchTransactionHistory = async () => {
    if (!wallet_id || loading) return;

    setLoading(true);
    await dbService.ensureDatabaseStarted();
    const transactionManager = TransactionManager();
    const addresses = await getAddressesForWallet(wallet_id);

    const totalAddresses = addresses.length;
    const uniqueTransactions = new Set(transactions.map((tx) => tx.tx_hash));

    for (const [index, address] of addresses.entries()) {
      if (fetchedAddresses.has(address)) continue;

      const newTransactions =
        await transactionManager.fetchAndStoreTransactionHistory(
          parseInt(wallet_id),
          address
        );

      const db = dbService.getDatabase();
      if (!db) {
        console.error('Database not started.');
        return;
      }

      const storedTransactionsQuery = db.prepare(`
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

      setFetchedAddresses(new Set(fetchedAddresses).add(address));
      setProgress(((index + 1) / totalAddresses) * 100); // Update progress
    }

    setLoading(false);
  };

  const getAddressesForWallet = async (
    wallet_id: string
  ): Promise<string[]> => {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      console.error('Database not started.');
      return [];
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
    return addresses;
  };

  const sortedTransactions = useCallback(() => {
    return [...transactions].sort((a, b) => {
      if (sortOrder === 'asc') {
        return a.height - b.height;
      } else {
        return b.height - a.height;
      }
    });
  }, [transactions, sortOrder]);

  const toggleSortOrder = () => {
    setSortOrder((prevOrder) => (prevOrder === 'asc' ? 'desc' : 'asc'));
  };

  const handleTransactionsPerPageChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    setTransactionsPerPage(parseInt(e.target.value, 10));
    setCurrentPage(1); // Reset to first page
  };

  const handleNextPage = () => {
    setCurrentPage((prevPage) => prevPage + 1);
  };

  const handlePreviousPage = () => {
    setCurrentPage((prevPage) => Math.max(prevPage - 1, 1));
  };

  const handleFirstPage = () => {
    setCurrentPage(1);
  };

  const handleLastPage = () => {
    setCurrentPage(totalPages);
  };

  const paginatedTransactions = sortedTransactions().slice(
    (currentPage - 1) * transactionsPerPage,
    currentPage * transactionsPerPage
  );

  const totalPages = Math.ceil(transactions.length / transactionsPerPage);

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

      {/* Header and controls (remain at top) */}
      <div className="sticky top-0 bg-white z-10 p-4">
        <div className="flex justify-center mt-4">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="Welcome"
            className="max-w-full h-auto"
          />
        </div>
        <h1 className="text-2xl font-bold mb-4">Transaction History</h1>
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

      {/* Scrollable transactions container with fixed height */}
      <div className="h-1/2 overflow-y-auto px-4">
        {transactions.length === 0 ? (
          <p className="text-center">No transactions available.</p>
        ) : (
          <ul className="space-y-4">
            {paginatedTransactions.map((tx, id) => (
              <a
                key={id + tx.tx_hash} // Move the key prop here
                href={
                  currentNetwork === Network.CHIPNET
                    ? `https://chipnet.imaginary.cash/tx/${tx.tx_hash}`
                    : `https://blockchair.com/bitcoin-cash/transaction/${tx.tx_hash}`
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                <li className="p-4 border rounded-lg shadow-md bg-white break-words">
                  <p>
                    <strong>Transaction Hash:</strong>{' '}
                    {shortenTxHash(tx.tx_hash)}
                  </p>
                  <p>
                    <strong>Height:</strong> {tx.height}
                  </p>
                </li>
              </a>
            ))}
          </ul>
        )}
      </div>

      {/* Bottom navigation (fixed at the bottom) */}
      <div
        id="bottomNavBar"
        className="fixed bottom-0 left-0 right-0 p-4 bg-white z-10 flex justify-between items-center"
        style={{ paddingBottom: navBarHeight }}
      >
        <button
          onClick={handleFirstPage}
          className={`py-2 px-4 mx-1 font-bold rounded ${
            currentPage === 1 ? 'bg-gray-500 text-white' : 'bg-gray-200'
          } hover:bg-gray-800 hover:text-white transition duration-300`}
          disabled={currentPage === 1}
        >
          First
        </button>
        <button
          onClick={handlePreviousPage}
          className={`py-2 px-4 mx-1 font-bold rounded ${
            currentPage === 1 ? 'bg-gray-500 text-white' : 'bg-gray-200'
          } hover:bg-gray-800 hover:text-white transition duration-300`}
          disabled={currentPage === 1}
        >
          {'<'}
        </button>
        <div className="py-2">
          {currentPage}/{totalPages}
        </div>
        <button
          onClick={handleNextPage}
          className={`py-2 px-4 mx-1 font-bold rounded ${
            currentPage === totalPages
              ? 'bg-gray-500 text-white'
              : 'bg-gray-200'
          } hover:bg-gray-800 hover:text-white transition duration-300`}
          disabled={currentPage === totalPages}
        >
          {'>'}
        </button>
        <button
          onClick={handleLastPage}
          className={`py-2 px-4 mx-1 font-bold rounded ${
            currentPage === totalPages
              ? 'bg-gray-500 text-white'
              : 'bg-gray-200'
          } hover:bg-gray-800 hover:text-white transition duration-300`}
          disabled={currentPage === totalPages}
        >
          Last
        </button>
      </div>
    </div>
  );
};

export default TransactionHistory;

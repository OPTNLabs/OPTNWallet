import { useMemo, useState } from 'react';
import { TransactionHistoryItem } from '../../types/types';

type SortOrder = 'asc' | 'desc';

type UseTransactionHistoryPaginationParams = {
  transactions: TransactionHistoryItem[];
};

export function useTransactionHistoryPagination({
  transactions,
}: UseTransactionHistoryPaginationParams) {
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [transactionsPerPage, setTransactionsPerPage] = useState(10);

  const sortedTransactions = useMemo(() => {
    const unconfirmed = transactions.filter((tx) => tx.height <= 0).reverse();
    const confirmed = transactions.filter((tx) => tx.height > 0);
    const sortedConfirmed = [...confirmed].sort((a, b) =>
      sortOrder === 'asc' ? a.height - b.height : b.height - a.height
    );
    return [...unconfirmed, ...sortedConfirmed];
  }, [transactions, sortOrder]);

  const hasTransactions = transactions.length > 0;
  const rawTotalPages = Math.ceil(transactions.length / transactionsPerPage);
  const totalPages = Math.max(1, rawTotalPages);

  const paginatedTransactions = useMemo(
    () =>
      sortedTransactions.slice(
        (currentPage - 1) * transactionsPerPage,
        currentPage * transactionsPerPage
      ),
    [sortedTransactions, currentPage, transactionsPerPage]
  );

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

  return {
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
  };
}

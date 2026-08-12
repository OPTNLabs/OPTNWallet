import { useEffect, useState } from 'react';
import { UTXO } from '../../types/types';
import {
  calculateBalance,
  calculateCashTokenTotals,
  HomeTokenTotals,
} from './homeMetrics';

type UseHomePlaceholderStateParams = {
  reduxUTXOs: Record<string, UTXO[]>;
  fetchingUTXOsRedux: boolean;
};

export function useHomePlaceholderState({
  reduxUTXOs,
  fetchingUTXOsRedux,
}: UseHomePlaceholderStateParams) {
  const [placeholderUTXOs, setPlaceholderUTXOs] = useState<Record<string, UTXO[]>>(
    Object.keys(reduxUTXOs).length > 0 ? reduxUTXOs : {}
  );
  const [placeholderBalance, setPlaceholderBalance] = useState(0);
  const [placeholderTokenTotals, setPlaceholderTokenTotals] =
    useState<HomeTokenTotals>({});

  useEffect(() => {
    const balance = calculateBalance(placeholderUTXOs);
    setPlaceholderBalance(balance);
    setPlaceholderTokenTotals(calculateCashTokenTotals(placeholderUTXOs));
  }, [placeholderUTXOs]);

  useEffect(() => {
    if (!fetchingUTXOsRedux && Object.keys(reduxUTXOs).length > 0) {
      setPlaceholderUTXOs(reduxUTXOs);
    }
  }, [fetchingUTXOsRedux, reduxUTXOs]);

  return {
    placeholderUTXOs,
    setPlaceholderUTXOs,
    placeholderBalance,
    placeholderTokenTotals,
  };
}

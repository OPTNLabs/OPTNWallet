import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { getRate } from '../services/priceService';
import { updatePrices } from '../redux/priceFeedSlice';
import { INTERVAL } from '../utils/constants';

const SYMBOLS = ['BTC', 'BCH', 'ETH'] as const;

export type Rates = Record<string, string | null>;

export function usePrices() {
  const dispatch = useDispatch();
  const [rates, setRates] = useState<Rates>({});

  useEffect(() => {
    let alive = true;

    async function fetchAll() {
    //   console.group('[usePrices] fetchAll start');
      const result: Rates = {};

      for (const symbol of SYMBOLS) {
        // console.log(`[usePrices] fetching ${symbol}`);
        const r = await getRate(symbol);
        // console.log(`[usePrices] result ${symbol}:`, r);
        result[symbol] = r;
      }

      if (alive) {
        // console.log('[usePrices] dispatching updatePrices with', result);
        setRates(result);
        dispatch(updatePrices(result));
      }
    //   console.groupEnd();
    }

    fetchAll();
    const id = setInterval(fetchAll, INTERVAL);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [dispatch]);

  return rates;
}

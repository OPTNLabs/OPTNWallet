// src/hooks/usePrices.ts
import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { getQuotesUSD, type BaseSymbol } from '../services/priceService';
import { upsertPrices, type PriceDatum } from '../redux/priceFeedSlice';
import { INTERVAL } from '../utils/constants';

const BASES: BaseSymbol[] = ['BTC', 'BCH', 'ETH'];

export function usePrices() {
  const dispatch = useDispatch();

  useEffect(() => {
    let alive = true;

    async function fetchAll() {
      try {
        const quotes = await getQuotesUSD(BASES);
        const payload: Record<string, PriceDatum> = Object.fromEntries(
          quotes.map((q) => [
            `${q.base}-${q.quote}`,
            { price: q.price, ts: q.ts, source: q.source } as PriceDatum,
          ])
        );

        if (!alive) return;
        dispatch(upsertPrices(payload));
      } catch (_e) {
        // optional: log or surface telemetry
      }
    }

    fetchAll();
    const id = setInterval(fetchAll, INTERVAL);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [dispatch]);
}

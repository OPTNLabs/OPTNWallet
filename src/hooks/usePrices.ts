// src/hooks/usePrices.ts
import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { getQuotesUSD, type BaseSymbol } from '../services/priceService';
import { upsertPrices, type PriceDatum } from '../redux/priceFeedSlice';
import { INTERVAL } from '../utils/constants';

const BASES: BaseSymbol[] = ['BTC', 'BCH', 'ETH'];

export type PriceMap = Record<string, PriceDatum | undefined>; // key = 'BTC-USD', ...

export function usePrices() {
  const dispatch = useDispatch();
  const [prices, setPrices] = useState<PriceMap>({});

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
        setPrices(payload);
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

  return prices;
}

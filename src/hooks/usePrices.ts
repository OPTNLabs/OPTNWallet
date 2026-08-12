// src/hooks/usePrices.ts
import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { getQuotesUSD, type BaseSymbol } from '../services/priceService';
import { upsertPrices, type PriceDatum } from '../state/slices/priceFeedSlice';
import { INTERVAL } from '../utils/constants';

const BASES: BaseSymbol[] = ['BTC', 'BCH', 'ETH'];

export function usePrices() {
  const dispatch = useDispatch();

  useEffect(() => {
    let alive = true;
    // Only log on a state TRANSITION (first failure after success/startup,
    // first success after a run of failures) rather than every interval
    // tick — a persistently-down price server otherwise reprints the exact
    // same warning every INTERVAL forever, which is noise once the cause is
    // already known rather than new information.
    let wasFailing = false;

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
        if (wasFailing) {
          console.info('[usePrices] price fetch recovered');
          wasFailing = false;
        }
        dispatch(upsertPrices(payload));
      } catch (e) {
        // Bounded by fetchJSON's AbortController timeout (and, on desktop,
        // http-bridge.ts's own race) — this always fires within a few
        // seconds even if the price server never responds, rather than
        // hanging silently forever.
        if (alive && !wasFailing) {
          console.warn('[usePrices] price fetch failed:', e instanceof Error ? e.message : e);
          wasFailing = true;
        }
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

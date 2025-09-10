// src/workers/priceFeedWorker.ts
/// <reference lib="webworker" />

import { INTERVAL } from '../utils/constants';
import { getQuotesUSD, type BaseSymbol, type Quote } from '../services/priceService';

declare const self: DedicatedWorkerGlobalScope;
export {};

/** Coins to track */
const BASES: BaseSymbol[] = ['BTC', 'BCH', 'ETH'];

/** Map normalized quotes → Redux-ready payload */
function toPayload(
  quotes: Quote[]
): Record<string, { price: number; ts: number; source: 'coingecko' | 'coincap' | 'cryptoapis' }> {
  const out: Record<string, { price: number; ts: number; source: 'coingecko' | 'coincap' | 'cryptoapis' }> = {};
  for (const q of quotes) {
    const key = `${q.base}-${q.quote}`; // e.g., 'BCH-USD'
    out[key] = { price: q.price, ts: q.ts, source: q.source };
  }
  return out;
}

async function fetchAndPost() {
  try {
    const quotes = await getQuotesUSD(BASES);
    if (!quotes || quotes.length === 0) {
      self.postMessage({ type: 'PRICE_ERROR', error: 'No quotes available from any provider.' });
      return;
    }
    self.postMessage({ type: 'PRICE_UPDATE', data: toPayload(quotes) });
  } catch (err: any) {
    const msg = typeof err?.message === 'string' ? err.message : String(err);
    self.postMessage({ type: 'PRICE_ERROR', error: msg });
  }
}

// Kick off immediately, then poll on INTERVAL
fetchAndPost();
setInterval(fetchAndPost, INTERVAL);

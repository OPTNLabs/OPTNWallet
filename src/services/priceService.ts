// src/services/priceService.ts
import { CapacitorHttp } from '@capacitor/core';
import { isWebPlatform } from '../utils/platform';

/** ===== Types ===== */
export type BaseSymbol = 'BTC' | 'BCH' | 'ETH';
export type QuoteSymbol = 'USD';
export type Quote = {
  base: BaseSymbol;
  quote: QuoteSymbol; // 'USD'
  price: number;
  ts: number; // ms epoch (provider ts if available, else Date.now())
  source: 'optnlabs';
};

/** ===== Env helpers =====
 * In Vite: use VITE_* vars. In other bundlers, fall back to process.env.
 * PRICE_SERVER_BASE can be overridden for staging/local testing.
 */
function env(name: string): string | undefined {
  const metaEnv =
    typeof import.meta !== 'undefined'
      ? ((import.meta as ImportMeta & { env?: Record<string, unknown> }).env ??
        {})
      : {};
  const nodeEnv =
    typeof process !== 'undefined'
      ? ((process as { env?: Record<string, unknown> }).env ?? {})
      : {};

  // Vite style
  const viteVal = metaEnv[name];
  // Node style (SSR / native builds)
  const nodeVal = nodeEnv[name];
  if (typeof viteVal === 'string') return viteVal;
  if (typeof nodeVal === 'string') return nodeVal;
  return undefined;
}

const PRICE_SERVER_BASE = (
  env('VITE_PRICE_SERVER_BASE') ||
  env('PRICE_SERVER_BASE') ||
  'https://price.optnlabs.com'
).replace(/\/+$/, '');

/** ===== HTTP helpers ===== */
async function fetchJSON(
  full: string,
  {
    headers,
    timeoutMs = 8000,
  }: {
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(full, { headers, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & {
        status?: number;
        body?: unknown;
      };
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(to);
  }
}

async function capacitorHttpJSON(
  full: string,
  {
    headers,
    timeoutMs = 8000,
  }: {
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  return await Promise.race([
    CapacitorHttp.get({ url: full, headers, params: undefined }).then(
      (r) => r.data
    ),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Timeout')), timeoutMs)
    ),
  ]);
}

async function httpGetJSON(
  url: string,
  {
    headers,
    params,
    timeoutMs = 8000,
  }: {
    headers?: Record<string, string>;
    params?: Record<string, string | number | boolean>;
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  const qp = params
    ? '?' +
      Object.entries(params)
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
        )
        .join('&')
    : '';
  const full = url + qp;

  try {
    // Prefer the standard fetch path everywhere. The native webview can still
    // use it once the API CORS allowlist includes the app origin.
    return await fetchJSON(full, { headers, timeoutMs });
  } catch (fetchError) {
    // Fall back to CapacitorHttp on native builds so a webview/CORS issue does
    // not completely block price loading.
    if (!isWebPlatform()) {
      try {
        return await capacitorHttpJSON(full, { headers, timeoutMs });
      } catch {
        throw fetchError;
      }
    }
    throw fetchError;
  }
}

/** ===== Price server adapter ===== */
const SUPPORTED_BASES: readonly BaseSymbol[] = ['BTC', 'BCH', 'ETH'];

type PriceServerQuote = {
  base?: string;
  quote?: string;
  price?: number | string;
  ts?: number | string;
};

type PriceServerResponse = {
  quotes?: PriceServerQuote[];
};

function isBaseSymbol(value: string): value is BaseSymbol {
  return (SUPPORTED_BASES as readonly string[]).includes(value);
}

async function fetchFromOptnPriceServer(bases: BaseSymbol[]): Promise<Quote[]> {
  const url = `${PRICE_SERVER_BASE}/v1/prices`;
  const data = (await httpGetJSON(url, {
    params: { bases: bases.join(','), quote: 'USD' },
  })) as PriceServerResponse;

  const now = Date.now();
  const quotes: Quote[] = Array.isArray(data?.quotes)
    ? data.quotes
        .map((item) => {
          const base = String(item?.base ?? '').toUpperCase();
          const quote = String(item?.quote ?? '').toUpperCase();
          const price = Number(item?.price);
          const ts = Number(item?.ts);
          if (!isBaseSymbol(base)) return null;
          if (quote !== 'USD' || !Number.isFinite(price)) return null;
          return {
            base,
            quote: 'USD',
            price,
            ts: Number.isFinite(ts) ? ts : now,
            source: 'optnlabs',
          } as Quote;
        })
        .filter(Boolean) as Quote[]
    : [];

  return quotes;
}

/** ===== Public API =====
 * getQuotesUSD: reads from OPTN price server only.
 * getRate: compatibility wrapper returning a string or null.
 */
export async function getQuotesUSD(bases: BaseSymbol[]): Promise<Quote[]> {
  const unique = Array.from(new Set(bases));
  return fetchFromOptnPriceServer(unique);
}

// Back-compat: same signature as your old function, now with normalized pipeline under the hood.
// Returns string | null to avoid breaking existing callers.
export async function getRate(symbol: BaseSymbol): Promise<string | null> {
  const quotes = await getQuotesUSD([symbol]);
  const q = quotes.find((x) => x.base === symbol);
  return q ? String(q.price) : null;
}

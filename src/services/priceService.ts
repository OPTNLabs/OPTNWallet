// src/services/priceService.ts
import { Capacitor } from '@capacitor/core';
import { CapacitorHttp } from '@capacitor/core';

/** ===== Types ===== */
export type BaseSymbol = 'BTC' | 'BCH' | 'ETH';
export type QuoteSymbol = 'USD';
export type Quote = {
  base: BaseSymbol;
  quote: QuoteSymbol; // 'USD'
  price: number;
  ts: number; // ms epoch (provider ts if available, else Date.now())
  source: 'coingecko' | 'coincap' | 'cryptoapis';
};

/** ===== Env helpers =====
 * In Vite: use VITE_* vars. In other bundlers, fall back to process.env.
 * IMPORTANT: do not expose provider keys in the browser; use a proxy for web.
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

const CG_KEY = env('VITE_CG_API_KEY') || env('CG_API_KEY'); // CoinGecko (optional on web if proxied)
const COINCAP_KEY = env('VITE_COINCAP_API_KEY') || env('COINCAP_API_KEY'); // CoinCap
const CRYPTO_KEY = env('VITE_CRYPTOAPIS_KEY') || env('CRYPTOAPIS_KEY'); // CryptoAPIs

/** ===== Provider base URLs =====
 * For web, call RELATIVE proxy paths so secrets are injected server-side.
 * For native, call provider URLs directly with headers.
 */
// Detect environments
const isWeb = Capacitor.getPlatform() === 'web';
const isDev =
  typeof import.meta !== 'undefined' &&
  Boolean((import.meta as ImportMeta & { env?: { DEV?: unknown } }).env?.DEV);

// CoinGecko: use proxy in dev, real host otherwise
const CG_BASE_WEB = isDev ? '/coingecko' : 'https://api.coingecko.com';
const CG_BASE = 'https://api.coingecko.com';

// CoinCap
const CC_BASE_WEB = isDev ? '/coincap' : 'https://api.coincap.io';
const CC_BASE = 'https://api.coincap.io';

// CryptoAPIs
const CA_BASE_WEB = isDev ? '/cryptoapi' : 'https://rest.cryptoapis.io';
const CA_BASE = 'https://rest.cryptoapis.io';

/** ===== ID maps ===== */
const COINGECKO_IDS: Record<BaseSymbol, string> = {
  BTC: 'bitcoin',
  BCH: 'bitcoin-cash',
  ETH: 'ethereum',
};

const COINCAP_IDS: Record<BaseSymbol, string> = {
  BTC: 'bitcoin',
  BCH: 'bitcoin-cash',
  ETH: 'ethereum',
};

/** ===== HTTP helpers ===== */
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

  if (!isWeb) {
    // Native: CapacitorHttp + manual timeout race
    return await Promise.race([
      CapacitorHttp.get({ url: full, headers, params: undefined }).then(
        (r) => r.data
      ),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Timeout')), timeoutMs)
      ),
    ]);
  }

  // Web: fetch + AbortController
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

/** ===== Provider adapters ===== */

// CoinGecko: GET /api/v3/coins/markets?vs_currency=usd&ids=...
async function fetchFromCoinGecko(bases: BaseSymbol[]): Promise<Quote[]> {
  const ids = bases.map((b) => COINGECKO_IDS[b]).join(',');
  const baseUrl = isWeb ? CG_BASE_WEB : CG_BASE;
  const url = `${baseUrl}/api/v3/coins/markets`;
  const headers: Record<string, string> = {};

  // Attach key on native OR web prod (dev proxy injects it)
  if ((!isWeb || !isDev) && CG_KEY) {
    headers['x-cg-demo-api-key'] = CG_KEY; // free/demo header
  }

  const data = await httpGetJSON(url, {
    headers,
    params: { vs_currency: 'usd', ids },
  });

  // Expect array of items with current_price
  const now = Date.now();
  type CoinGeckoMarket = { id?: string; current_price?: number | string };
  const quotes: Quote[] = Array.isArray(data)
    ? (data
        .map((it) => {
          const row = (it ?? {}) as CoinGeckoMarket;
          const base = invert(COINGECKO_IDS)[String(row.id ?? '')] as
            | BaseSymbol
            | undefined;
          const price =
            typeof row.current_price === 'number'
              ? row.current_price
              : Number(row.current_price);
          if (!base || !isFinite(price)) return null;
          return {
            base,
            quote: 'USD',
            price,
            ts: now,
            source: 'coingecko',
          } as Quote;
        })
        .filter(Boolean) as Quote[])
    : [];

  return quotes;
}

// CoinCap: GET /v2/assets?ids=bitcoin,bitcoin-cash,ethereum
async function fetchFromCoinCap(bases: BaseSymbol[]): Promise<Quote[]> {
  const ids = bases.map((b) => COINCAP_IDS[b]).join(',');
  const baseUrl = isWeb ? CC_BASE_WEB : CC_BASE;
  const url = `${baseUrl}/v2/assets`;
  const headers: Record<string, string> = {};

  // CoinCap key optional on free; add only if we have it and not using dev proxy
  if ((!isWeb || !isDev) && COINCAP_KEY)
    headers['Authorization'] = `Bearer ${COINCAP_KEY}`;

  const json = await httpGetJSON(url, {
    headers,
    params: { ids },
  });

  const arr = Array.isArray((json as { data?: unknown[] } | undefined)?.data)
    ? (json as { data?: unknown[] }).data!
    : [];
  const now = Date.now();
  const inv = invert(COINCAP_IDS);
  type CoinCapAsset = { id?: string; priceUsd?: string | number };
  const quotes: Quote[] = arr
    .map((it) => {
      const row = (it ?? {}) as CoinCapAsset;
      const base = inv[String(row.id ?? '')] as BaseSymbol | undefined;
      const price = Number(row.priceUsd);
      if (!base || !isFinite(price)) return null;
      return { base, quote: 'USD', price, ts: now, source: 'coincap' } as Quote;
    })
    .filter(Boolean) as Quote[];

  return quotes;
}

// CryptoAPIs: GET /market-data/exchange-rates/by-symbol/{BASE}/USD (per pair)
async function fetchFromCryptoAPIs(bases: BaseSymbol[]): Promise<Quote[]> {
  const baseUrl = isWeb ? CA_BASE_WEB : CA_BASE;
  const headers: Record<string, string> = {};

  if ((!isWeb || !isDev) && CRYPTO_KEY) headers['x-api-key'] = CRYPTO_KEY;

  const tsSec = Math.floor(Date.now() / 1000);

  const results = await Promise.allSettled(
    bases.map(async (b) => {
      const url = `${baseUrl}/market-data/exchange-rates/by-symbol/${b}/USD`;
      const json = await httpGetJSON(url, {
        headers,
        params: { calculationTimestamp: tsSec },
      });
      const item = (
        json as {
          data?: { item?: { rate?: number | string; calculationTimestamp?: number | string } };
        }
      )?.data?.item;
      const price = Number(item?.rate);
      const t = Number(item?.calculationTimestamp);
      if (!isFinite(price)) return null;
      return {
        base: b,
        quote: 'USD',
        price,
        ts: Number.isFinite(t) ? t * 1000 : Date.now(),
        source: 'cryptoapis',
      } as Quote;
    })
  );

  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean) as Quote[];
}

/** Utility: invert a Record<string,string> */
function invert(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[v] = k;
  return out;
}

/** ===== Public API =====
 * getQuotesUSD: tries CoinGecko → CoinCap → CryptoAPIs, merging what’s available.
 * getRate: compatibility wrapper returning a string or null (uses first available source).
 */
export async function getQuotesUSD(bases: BaseSymbol[]): Promise<Quote[]> {
  const unique = Array.from(new Set(bases));
  const collected = {} as Record<BaseSymbol, Quote>;

  // Try CoinGecko first
  try {
    for (const q of await fetchFromCoinGecko(unique)) collected[q.base] = q;
  } catch (e: unknown) {
    // console.warn('CoinGecko failed', e?.status || e);
  }

  // Fill missing from CoinCap
  const missing1 = unique.filter((b) => !collected[b]);
  if (missing1.length) {
    try {
      for (const q of await fetchFromCoinCap(missing1)) collected[q.base] = q;
    } catch (e: unknown) {
      // console.warn('CoinCap failed', e?.status || e);
    }
  }

  // Fill remaining from CryptoAPIs
  const missing2 = unique.filter((b) => !collected[b]);
  if (missing2.length) {
    try {
      for (const q of await fetchFromCryptoAPIs(missing2))
        collected[q.base] = q;
    } catch (e: unknown) {
      // console.warn('CryptoAPIs failed', e?.status || e);
    }
  }

  return Object.values(collected);
}

// Back-compat: same signature as your old function, now with normalized pipeline under the hood.
// Returns string | null to avoid breaking existing callers.
export async function getRate(symbol: BaseSymbol): Promise<string | null> {
  const quotes = await getQuotesUSD([symbol]);
  const q = quotes.find((x) => x.base === symbol);
  return q ? String(q.price) : null;
}

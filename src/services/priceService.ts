// src/services/priceService.ts
import { Capacitor } from '@capacitor/core';
import { Http } from '@capacitor-community/http';

const API_BASE = 'https://rest.cryptoapis.io';
const API_KEY  = '6d9896a7304104e32b4091e9197f1d1b03faffb3';

export async function getRate(symbol: string): Promise<string | null> {
  const platform = Capacitor.getPlatform();
//   console.log('[priceService] Platform:', platform);

  // === WEB FALLBACK (dev only) ===
  if (platform === 'web') {
    const ts    = Math.floor(Date.now()/1000);
    const proxy = `/cryptoapi/market-data/exchange-rates/by-symbol/${symbol}/USD`;
    const url   = `${proxy}?calculationTimestamp=${ts}`;
    // console.group(`[priceService] WEB FETCH ${symbol}`);
    // console.log('→ URL:', url);
    // console.log('→ Headers: x-api-key:', API_KEY);
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': API_KEY }
      });
    //   console.log('← Status:', res.status);
      const body = await res.json();
    //   console.log('← Body:', body);
    //   console.groupEnd();

      if (res.ok && body?.data?.item?.rate) {
        return body.data.item.rate;
      }
    } catch (e) {
      console.error('[priceService] web fetch error', e);
    }
    return null;
  }

  // === NATIVE (iOS/Android) ===
  const ts     = Math.floor(Date.now()/1000);
  const url    = `${API_BASE}/market-data/exchange-rates/by-symbol/${symbol}/USD`;
  const params = { calculationTimestamp: ts.toString() };
  const headers= { 'Content-Type':'application/json', 'x-api-key': API_KEY };

//   console.group(`[priceService] NATIVE HTTP ${symbol}`);
//   console.log('→ URL:',    url);
//   console.log('→ Params:', params);
//   console.log('→ Headers:', headers);

  try {
    const response = await Http.get({ url, headers, params });
    // console.log('← Status:', response.status);
    // console.log('← Data:',   response.data);
    // console.groupEnd();

    if (response.status === 200 && response.data?.data?.item?.rate) {
      return response.data.data.item.rate;
    }
  } catch (e) {
    console.error('[priceService] native HTTP error', e);
  }
  return null;
}

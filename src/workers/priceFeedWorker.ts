// src/workers/priceFeedWorker.ts

import { INTERVAL } from '../utils/constants';

type AssetData = {
  id: string;
  rank: string;
  symbol: string;
  name: string;
  supply: string;
  maxSupply: string;
  marketCapUsd: string;
  volumeUsd24Hr: string;
  priceUsd: string;
  changePercent24Hr: string;
  vwap24Hr: string;
};

const API_URL = 'https://api.coincap.io/v2/assets/';
const ASSETS = ['bitcoin', 'ethereum', 'bitcoin-cash'];
const API_KEY = '9b3967c4-61fa-4556-ae2a-0b2e2f9d1a94';

async function fetchPrices() {
  try {
    const prices: Record<string, AssetData> = {};
    for (const asset of ASSETS) {
      const response = await fetch(`${API_URL}${asset}`, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Accept-Encoding': 'gzip',
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.data) {
          prices[asset] = data.data;
        }
      } else {
        console.error(`Failed to fetch data for asset: ${asset}`);
      }
    }

    // Send the fetched prices back to the main thread
    self.postMessage({ type: 'PRICE_UPDATE', data: prices });
  } catch (error) {
    console.error('Error fetching price data:', error);
    self.postMessage({ type: 'PRICE_ERROR', error: error.toString() });
  }
}

// Fetch prices every minute
setInterval(fetchPrices, INTERVAL);

// Fetch prices immediately after service worker starts
fetchPrices();

export {};

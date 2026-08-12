// testCryptoApiFetch.mjs
import https from 'https';
import { URL } from 'url';

const API_BASE = 'https://rest.cryptoapis.io';
const API_KEY  = '6d9896a7304104e32b4091e9197f1d1b03faffb3';
const SYMBOL   = 'BTC';  // change to BTC, BCH or ETH to test each
const ts       = Math.floor(Date.now() / 1000);

const endpoint = new URL(
  `/market-data/exchange-rates/by-symbol/${SYMBOL}/USD`,
  API_BASE
);
endpoint.searchParams.set('calculationTimestamp', ts);

const options = {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key':    API_KEY,
  },
};

console.log(`Requesting: ${endpoint.toString()}`);
const req = https.request(endpoint, options, (res) => {
  console.log(`→ STATUS: ${res.statusCode} ${res.statusMessage}`);
  console.log('→ HEADERS:', res.headers);

  let body = '';
  res.setEncoding('utf8');
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('→ BODY:', body);
  });
});

req.on('error', err => {
  console.error('Request error:', err);
});

req.end();

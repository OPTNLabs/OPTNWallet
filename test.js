// testPriceServerFetch.mjs
import https from 'https';
import { URL } from 'url';

const API_BASE = process.env.PRICE_SERVER_BASE || 'https://price.optnlabs.com';
const BASES = process.env.BASES || 'BTC,BCH,ETH';
const QUOTE = process.env.QUOTE || 'USD';

const endpoint = new URL('/v1/prices', API_BASE);
endpoint.searchParams.set('bases', BASES);
endpoint.searchParams.set('quote', QUOTE);

const options = {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
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

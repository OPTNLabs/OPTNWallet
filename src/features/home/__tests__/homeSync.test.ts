import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../Home.tsx', import.meta.url)),
  'utf8'
);

describe('Home manual sync', () => {
  it('refreshes transaction history after publishing the UTXO snapshot', () => {
    const utxoPublish = source.indexOf(
      'await refreshUTXOWorkerSubscriptions();'
    );
    const historyRefresh = source.indexOf(
      'await refreshWalletTransactionHistory({',
      utxoPublish
    );

    expect(utxoPublish).toBeGreaterThan(-1);
    expect(historyRefresh).toBeGreaterThan(utxoPublish);
    expect(source.slice(historyRefresh, historyRefresh + 220)).toContain(
      'force: true'
    );
  });
});

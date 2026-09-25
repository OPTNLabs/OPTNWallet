import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../Home.tsx', import.meta.url)),
  'utf8'
);

describe('Home manual sync', () => {
  it('does not start a full refresh when the Home route mounts', () => {
    expect(source).not.toContain('autoSyncWalletRef');
    expect(source).not.toContain('void handleRefresh();');
  });

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

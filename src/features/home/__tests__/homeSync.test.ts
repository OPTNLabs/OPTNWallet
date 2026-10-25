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

  it('announces refresh failures and keeps the retry action touch-sized', () => {
    expect(source).toContain('setRefreshFailed(true)');
    expect(source).toContain('setRefreshFailed(false)');
    expect(source).toContain("t('home.refreshFailed')");
    expect(source).toContain('role="alert"');
    expect(source).toContain(
      'wallet-btn-secondary min-h-[44px] px-3 py-1.5 text-sm'
    );
  });
});

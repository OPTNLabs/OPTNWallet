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

  it('keeps market data below the wallet task surfaces', () => {
    const portfolio = source.indexOf("title={t('home.portfolio')}");
    const quickActions = source.indexOf("title={t('home.quickActions')}");
    const priceFeed = source.indexOf('<PriceFeed compact />');

    expect(portfolio).toBeGreaterThan(-1);
    expect(quickActions).toBeGreaterThan(portfolio);
    expect(priceFeed).toBeGreaterThan(quickActions);
  });

  it('keeps Home utility actions touch-sized', () => {
    expect(source).toContain('inline-flex min-h-[44px] items-center gap-2');
    expect(source).toContain(
      'wallet-link inline-flex min-h-[44px] items-center px-2 text-sm'
    );
  });

  it('explains recent activity status without requiring the history route', () => {
    expect(source).toContain('home-history-status-${tx.tx_hash}');
    expect(source).toContain("t('history.statusHelpLabel')");
    expect(source).toContain("t('history.statusHelp')");
  });
});

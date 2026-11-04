import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const homeSource = readFileSync(
  fileURLToPath(new URL('../Home.tsx', import.meta.url)),
  'utf8'
);
const desktopHomeSource = readFileSync(
  fileURLToPath(
    new URL('../../../platform/desktop/DesktopHome.tsx', import.meta.url)
  ),
  'utf8'
);

describe('incoming funds disclosure', () => {
  it('keeps incoming identifiers copyable and long-press discoverable on both Home renderers', () => {
    for (const source of [homeSource, desktopHomeSource]) {
      expect(source).toContain('incomingFlag.address');
      expect(source).toContain('incomingFlag.txid');
      expect(source).toContain('<MaskedValue');
      expect(source).toContain('copySuccessMessageKey="receive.addressCopied"');
      expect(source).toContain(
        'copySuccessMessageKey="history.transactionCopied"'
      );
      expect(source).not.toContain('incomingFlag.body');
      expect(source).not.toContain('shortTxid');
    }
  });

  it('keeps stale desktop balances explainable and recoverable', () => {
    expect(desktopHomeSource).toContain('walletSyncStatus');
    expect(desktopHomeSource).toContain("t('home.syncStatusHelpLabel')");
    expect(desktopHomeSource).toContain("t('home.balanceMayBeOutdated')");
    expect(desktopHomeSource).toContain("t('home.serverSettings')");
    expect(desktopHomeSource).toContain('setRefreshFailed(true)');
  });

  it('explains recent activity status in the desktop renderer too', () => {
    expect(desktopHomeSource).toContain(
      'desktop-home-history-status-${tx.tx_hash}'
    );
    expect(desktopHomeSource).toContain("t('history.statusHelpLabel')");
    expect(desktopHomeSource).toContain("t('history.statusHelp')");
  });
});

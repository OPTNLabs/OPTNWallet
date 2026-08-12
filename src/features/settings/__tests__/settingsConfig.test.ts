import { describe, expect, it } from 'vitest';
import { getVisibleWalletRows, WALLET_ROWS } from '../settingsConfig';

describe('settingsConfig', () => {
  it('exposes wallet settings including the pending tx lock screen link', () => {
    const row = WALLET_ROWS.find((entry) => entry.key === 'pending-outbox');

    expect(row).toMatchObject({
      title: 'Pending Tx Locks',
      description: 'Review outgoing transaction locks',
      action: 'navigate',
      target: '/outbox',
    });
  });

  it('hides desktop-only wallet settings rows outside the desktop runtime', () => {
    const visibleKeys = getVisibleWalletRows(false).map((row) => row.key);

    expect(visibleKeys).toEqual(['recovery', 'pending-outbox', 'app-lock']);
    expect(visibleKeys).not.toEqual(expect.arrayContaining([
      'network',
      'nostr',
      'server',
      'console',
      'experimental',
      'addons',
    ]));
  });

  it('keeps all wallet settings rows in the desktop runtime', () => {
    expect(getVisibleWalletRows(true)).toBe(WALLET_ROWS);
  });
});

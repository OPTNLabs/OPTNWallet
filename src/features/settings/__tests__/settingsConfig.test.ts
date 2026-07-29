import { describe, expect, it } from 'vitest';
import { getVisibleWalletRows, WALLET_ROWS } from '../settingsConfig';
import { Network } from '../../../state/slices/networkSlice';

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

  it('keeps the common wallet controls on the mobile settings home', () => {
    const visibleKeys = getVisibleWalletRows(false, Network.MAINNET).map(
      (row) => row.key
    );

    expect(visibleKeys).toEqual(['network', 'pending-outbox']);
    expect(visibleKeys).not.toEqual(
      expect.arrayContaining([
        'faucet',
        'app-lock',
        'console',
        'experimental',
        'addons',
      ])
    );
  });

  it('shows the Chipnet faucet only for the active Chipnet network', () => {
    expect(
      getVisibleWalletRows(false, Network.MAINNET).map((row) => row.key)
    ).not.toContain('faucet');
    expect(
      getVisibleWalletRows(false, Network.CHIPNET).map((row) => row.key)
    ).toContain('faucet');
  });

  it('keeps common wallet controls on the desktop settings home', () => {
    expect(getVisibleWalletRows(true, Network.CHIPNET).map((row) => row.key)).toEqual([
      'network',
      'faucet',
      'pending-outbox',
    ]);
  });
});

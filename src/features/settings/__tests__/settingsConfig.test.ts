import { describe, expect, it } from 'vitest';
import { WALLET_ROWS } from '../settingsConfig';

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
});

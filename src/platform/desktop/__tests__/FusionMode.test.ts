import { describe, expect, it } from 'vitest';

import {
  assertServerFusionSelected,
  getFusionModeAvailability,
} from '../FusionMode';

describe('CashFusion mode exclusivity', () => {
  it('disables the server action while P2P Fusion is selected', () => {
    expect(
      getFusionModeAvailability({
        p2pFusionEnabled: true,
        walletId: 7,
        serverBusy: false,
      })
    ).toEqual({
      serverDisabled: true,
      serverMuted: true,
    });
  });

  it('allows the server action only in Server Fusion mode with an open wallet', () => {
    expect(
      getFusionModeAvailability({
        p2pFusionEnabled: false,
        walletId: 7,
        serverBusy: false,
      })
    ).toEqual({
      serverDisabled: false,
      serverMuted: false,
    });
  });

  it('enforces the selected mode inside the server action handler too', () => {
    expect(() => assertServerFusionSelected(true)).toThrow(
      'Server Fusion is unavailable while P2P Fusion is selected.'
    );
    expect(() => assertServerFusionSelected(false)).not.toThrow();
  });
});

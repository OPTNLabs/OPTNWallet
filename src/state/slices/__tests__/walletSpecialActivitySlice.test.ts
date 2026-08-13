import { describe, expect, it } from 'vitest';
import walletSpecialActivityReducer, {
  selectRpaStealthSats,
  setWalletSpecialActivity,
} from '../walletSpecialActivitySlice';
import { Network } from '../networkSlice';

describe('selectRpaStealthSats', () => {
  it('returns 0 when the wallet has no stealth record', () => {
    expect(
      selectRpaStealthSats({ walletSpecialActivity: { byWallet: {} } }, 7)
    ).toBe(0);
  });

  it('reads claimed stealth sats for the home portfolio total', () => {
    const state = {
      walletSpecialActivity: walletSpecialActivityReducer(
        undefined,
        setWalletSpecialActivity({
          walletId: 7,
          record: {
            walletId: 7,
            activityType: 'rpa',
            network: Network.CHIPNET,
            derivationPath: "m/44'/1'/0'",
            status: 'complete',
            updatedAt: 'now',
            payload: {
              enabled: true,
              serverSupported: false,
              detectedPaymentCount: 1,
              unspentOutputCount: 1,
              unspentSats: 12_500,
              unspentOutputs: [],
            },
          },
        })
      ),
    };
    expect(selectRpaStealthSats(state, 7)).toBe(12_500);
    expect(selectRpaStealthSats(state, 8)).toBe(0);
  });

  it('sums stealth outputs when unspentSats is missing or a string', () => {
    const state = {
      walletSpecialActivity: walletSpecialActivityReducer(
        undefined,
        setWalletSpecialActivity({
          walletId: 3,
          record: {
            walletId: 3,
            activityType: 'rpa',
            network: Network.CHIPNET,
            derivationPath: "m/44'/1'/0'",
            status: 'complete',
            updatedAt: 'now',
            payload: {
              enabled: true,
              serverSupported: false,
              detectedPaymentCount: 1,
              unspentOutputCount: 1,
              unspentSats: '20772641' as unknown as number,
              unspentOutputs: [{ valueSats: 20_772_641 }],
            },
          },
        })
      ),
    };
    expect(selectRpaStealthSats(state, 3)).toBe(20_772_641);
  });
});

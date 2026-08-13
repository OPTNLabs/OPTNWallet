import { describe, expect, it } from 'vitest';
import { Network } from '../../../state/slices/networkSlice';
import { isCashConnectUri } from '../cashconnectInvite';
import { expectedCashConnectPath } from '../cashconnectKey';

describe('CashConnect identity path', () => {
  it('rewrites BIP44 purpose 44 to CashConnect purpose 5001', () => {
    expect(expectedCashConnectPath(Network.MAINNET, "m/44'/145'/0'")).toBe(
      "m/5001'/145'/0'"
    );
    expect(expectedCashConnectPath(Network.CHIPNET, "m/44'/1'/0'")).toBe(
      "m/5001'/1'/0'"
    );
  });

  it('accepts only the Nostr invite scheme', () => {
    expect(isCashConnectUri('bch-cc-v1:abc')).toBe(true);
    expect(isCashConnectUri('BCH-CC-V1:abc')).toBe(true);
    expect(isCashConnectUri('wiz://abc')).toBe(false);
    expect(isCashConnectUri('wc:abc')).toBe(false);
  });
});

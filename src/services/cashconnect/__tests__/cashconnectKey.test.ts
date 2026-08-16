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

  it('accepts only parseable CashConnect v1 invites', () => {
    expect(isCashConnectUri('bch-cc-v1:abc')).toBe(true);
    expect(isCashConnectUri('BCH-CC-V1:abc')).toBe(true);
    expect(
      isCashConnectUri(
        'bch-cc-v1:ad6f1bc041b666007c6b6ea0a5151ad09ecef2139123a40e5cfbbebd93e425e0?relay=wss://nostr.infra.cash'
      )
    ).toBe(true);
    expect(isCashConnectUri('bch-cc-v2:abc')).toBe(false);
    expect(isCashConnectUri('wiz://abc')).toBe(false);
    expect(isCashConnectUri('wc:abc')).toBe(false);
    expect(isCashConnectUri('')).toBe(false);
  });
});

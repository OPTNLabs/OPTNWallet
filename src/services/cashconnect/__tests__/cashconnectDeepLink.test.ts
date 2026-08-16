import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractCashConnectUriFromOpenUrl,
  peekStashedCashConnectInvite,
  stashCashConnectInvite,
  takeStashedCashConnectInvite,
} from '../cashconnectDeepLink';

const INVITE =
  'bch-cc-v1:ad6f1bc041b666007c6b6ea0a5151ad09ecef2139123a40e5cfbbebd93e425e0?relay=wss://nostr.infra.cash';

describe('CashConnect deep links', () => {
  it('accepts a raw invite and an invite nested in another URL', () => {
    expect(extractCashConnectUriFromOpenUrl(INVITE)).toBe(
      new URL(INVITE).href
    );
    expect(
      extractCashConnectUriFromOpenUrl(
        `https://wallet.example/open?uri=${encodeURIComponent(INVITE)}`
      )
    ).toBe(new URL(INVITE).href);
    expect(extractCashConnectUriFromOpenUrl('wc:abc')).toBeNull();
    expect(extractCashConnectUriFromOpenUrl('')).toBeNull();
  });

  it('registers the native bch-cc-v1 scheme on Android and iOS', () => {
    const android = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../android/app/src/main/AndroidManifest.xml',
          import.meta.url
        )
      ),
      'utf8'
    );
    const ios = readFileSync(
      fileURLToPath(
        new URL('../../../../ios/App/App/Info.plist', import.meta.url)
      ),
      'utf8'
    );
    expect(android).toContain('android:scheme="bch-cc-v1"');
    expect(ios).toContain('<string>bch-cc-v1</string>');
  });

  it('holds one invite until a wallet is open', () => {
    stashCashConnectInvite(INVITE);
    expect(peekStashedCashConnectInvite()).toBe(INVITE);
    expect(takeStashedCashConnectInvite()).toBe(INVITE);
    expect(takeStashedCashConnectInvite()).toBeNull();
  });
});

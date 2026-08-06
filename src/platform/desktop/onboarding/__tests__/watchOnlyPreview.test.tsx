import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';

import { Network } from '../../../../state/slices/networkSlice';
import {
  deriveBchKeyMaterial,
  deriveHdPublicKeyAtPath,
  getBchAccountPath,
} from '../../../../services/HdWalletService';
import { DesktopWalletPickerActions } from '../DesktopWalletPickerActions';
import { WatchOnlyWalletPreview } from '../WatchOnlyWalletPreview';
import { deriveWatchOnlyAccountPreview } from '../watchOnlyAccountPreview';
import { masterFingerprintBytes } from '../watchOnlyWallet';

const TEST_MNEMONIC = bip39.entropyToMnemonic('0'.repeat(32));

describe('desktop watch-only preview', () => {
  it('exposes Create Watch-Only Wallet as a wallet-picker action', () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/">
        <DesktopWalletPickerActions
          hasWallets
          onHardware={() => undefined}
          onWatchOnly={() => undefined}
        />
      </StaticRouter>
    );

    expect(html).toContain('Add another wallet');
    expect(html).toContain('Create Watch-Only Wallet');
    expect(html.indexOf('Connect Hardware Wallet')).toBeLessThan(
      html.indexOf('Create Watch-Only Wallet')
    );
  });

  it('derives the first receive and change addresses from a BCH account xPub', async () => {
    const accountXpub = await deriveHdPublicKeyAtPath(
      TEST_MNEMONIC,
      '',
      Network.MAINNET,
      getBchAccountPath(Network.MAINNET, 0)
    );
    const preview = deriveWatchOnlyAccountPreview(Network.MAINNET, accountXpub);
    const receive = await deriveBchKeyMaterial(
      Network.MAINNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      0
    );
    const change = await deriveBchKeyMaterial(
      Network.MAINNET,
      TEST_MNEMONIC,
      '',
      0,
      1,
      0
    );

    expect(preview.accountPath).toBe("m/44'/145'/0'");
    expect(preview.receive.path).toBe("m/44'/145'/0'/0/0");
    expect(preview.change.path).toBe("m/44'/145'/0'/1/0");
    expect(preview.receive.address).toBe(receive?.address);
    expect(preview.change.address).toBe(change?.address);
    expect(preview).not.toHaveProperty('privateKey');
  });

  it('rejects an xPub whose encoded network does not match the selected network', async () => {
    const mainnetXpub = await deriveHdPublicKeyAtPath(
      TEST_MNEMONIC,
      '',
      Network.MAINNET,
      getBchAccountPath(Network.MAINNET, 0)
    );

    expect(() =>
      deriveWatchOnlyAccountPreview(Network.CHIPNET, mainnetXpub)
    ).toThrow(/network/i);
  });

  it('offers create controls and no longer claims preview-only status', () => {
    const html = renderToStaticMarkup(
      <WatchOnlyWalletPreview
        onBack={() => undefined}
        onCreated={() => undefined}
      />
    );

    expect(html).toContain('Create Watch-Only Wallet');
    expect(html).toContain('Wallet name');
    expect(html).toContain('Standard');
    expect(html).toContain('Multisign');
    expect(html).toContain('Save watch-only wallet');
    expect(html).not.toContain('does not save a watch-only wallet');
    expect(html).not.toContain('Public preview only');
  });

  it('offers Multisign as a real choice, not a placeholder', () => {
    // The plan for Issue #8 says an entry is added when its flow works, not as
    // a non-working placeholder. Multisign shipped disabled and labelled
    // "Coming next" while the whole codec sat behind it unreachable.
    const html = renderToStaticMarkup(
      <WatchOnlyWalletPreview
        onBack={() => undefined}
        onCreated={() => undefined}
      />
    );

    expect(html).not.toContain('Coming next');
    expect(html).not.toContain('aria-disabled');
  });

  it('does not ask for a master fingerprint when creating a wallet', () => {
    // Creating a watch-only wallet is a scan-the-xPub step. The fingerprint is
    // not in that QR, is not derivable from it, and is not needed to sign — it
    // only affects whether the device's review screen claims the coins. The
    // send screen asks once and remembers, so asking here too was an
    // unexplained hex box in onboarding for something most people skip.
    const html = renderToStaticMarkup(
      <WatchOnlyWalletPreview
        onBack={() => undefined}
        onCreated={() => undefined}
      />
    );

    expect(html).not.toContain('Master fingerprint');
    expect(html).not.toContain('8 hex chars');
  });

  it('decodes a valid master fingerprint to its 4 bytes', () => {
    expect(masterFingerprintBytes('4c9a1f7b')).toEqual(
      Uint8Array.from([0x4c, 0x9a, 0x1f, 0x7b])
    );
    expect(masterFingerprintBytes('DEADBEEF')).toEqual(
      Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
    );
  });

  it('rejects fingerprints that are not exactly 8 hex chars', () => {
    expect(masterFingerprintBytes('')).toBeNull();
    expect(masterFingerprintBytes('4c9a1f7')).toBeNull();
    expect(masterFingerprintBytes('4c9a1f7bc')).toBeNull();
    expect(masterFingerprintBytes('zzzzzzzz')).toBeNull();
    expect(masterFingerprintBytes('4c 9a 1f 7b')).toBeNull();
    expect(masterFingerprintBytes(undefined)).toBeNull();
    expect(masterFingerprintBytes(null)).toBeNull();
  });
});

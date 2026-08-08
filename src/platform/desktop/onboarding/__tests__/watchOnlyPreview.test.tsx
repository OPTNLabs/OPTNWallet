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
    expect(html).toContain('Use a hardware device');
    // Airgap/Keystone live inside create-watch-only, not on the landing list.
    expect(html).not.toContain('Set up Keystone');
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

  it('aligns xpub/tpub version bytes when the wallet network differs', async () => {
    // Version bytes only — same HD node. Trezor/chipnet exports often need this.
    const mainnetXpub = await deriveHdPublicKeyAtPath(
      TEST_MNEMONIC,
      '',
      Network.MAINNET,
      getBchAccountPath(Network.MAINNET, 0)
    );

    const preview = deriveWatchOnlyAccountPreview(Network.CHIPNET, mainnetXpub);
    expect(preview.receive.address.startsWith('bchtest:')).toBe(true);
    expect(preview.accountPath).toBe("m/44'/1'/0'");
  });

  it('saves and opens without an xPub preview step; single-sig and multisig for PSBT', () => {
    const html = renderToStaticMarkup(
      <WatchOnlyWalletPreview
        onBack={() => undefined}
        onCreated={() => undefined}
      />
    );

    expect(html).toContain('Create Watch-Only Wallet');
    expect(html).toContain('Wallet name');
    expect(html).toContain('Single-sig');
    expect(html).toContain('Multisig');
    expect(html).toContain('Save and open wallet');
    expect(html).not.toContain('Preview public addresses');
    expect(html).not.toContain('Public preview only');
  });

  it('puts Keystone in an Airgap section at the bottom of create watch-only', () => {
    const html = renderToStaticMarkup(
      <WatchOnlyWalletPreview
        onBack={() => undefined}
        onCreated={() => undefined}
      />
    );

    expect(html).toContain('Airgap');
    expect(html).toContain('Keystone');
    expect(html).toContain('not USB, not PSBT');
    expect(html.indexOf('Save and open wallet')).toBeLessThan(
      html.indexOf('Airgap')
    );
  });

  it('does not ask for a master fingerprint on the main xPub form', () => {
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

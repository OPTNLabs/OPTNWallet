import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { Provider } from 'react-redux';
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
import { I18nProvider } from '../../../../i18n/I18nProvider';
import { store } from '../../../../state/store';

const TEST_MNEMONIC = bip39.entropyToMnemonic('0'.repeat(32));

describe('desktop watch-only preview', () => {
  it('exposes Create Watch-Only Wallet as a wallet-picker action', () => {
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <I18nProvider>
          <StaticRouter location="/">
            <DesktopWalletPickerActions
              hasWallets
              onHardware={() => undefined}
              onWatchOnly={() => undefined}
            />
          </StaticRouter>
        </I18nProvider>
      </Provider>
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

  it('labels the screen as a preview and does not claim save, sign, or broadcast support', () => {
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <I18nProvider>
          <WatchOnlyWalletPreview onBack={() => undefined} />
        </I18nProvider>
      </Provider>
    );

    expect(html).toContain('Watch-Only Wallet Preview');
    expect(html).toContain('Standard');
    expect(html).toContain('Multisign');
    expect(html).toContain('Coming next');
    expect(html).toContain('does not save a watch-only wallet');
    expect(html).toContain('sign');
    expect(html).toContain('broadcast');
  });
});

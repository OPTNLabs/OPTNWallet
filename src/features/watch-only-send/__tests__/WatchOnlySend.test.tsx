import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import WatchOnlySend from '../WatchOnlySend';
import { store } from '../../../state/store';
import { I18nProvider } from '../../../i18n/I18nProvider';
describe('WatchOnlySend workspace', () => {
  it('renders the workspace shell (loading state on first paint)', () => {
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <I18nProvider>
          <StaticRouter location="/send">
            <WatchOnlySend />
          </StaticRouter>
        </I18nProvider>
      </Provider>
    );

    expect(html).toContain('Watch-only Send');
    expect(html).toContain('Back');
    expect(html).toContain('Loading coins');
  });

  it('shows where the user is in the air-gapped round trip', () => {
    // Sending here is build -> carry to the device -> carry back -> broadcast.
    // Showing every control at once made that read as one dense form, so the
    // stage is named up front and only the current stage's controls are shown.
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <I18nProvider>
          <StaticRouter location="/send">
            <WatchOnlySend />
          </StaticRouter>
        </I18nProvider>
      </Provider>
    );

    expect(html).toContain('Prepare');
    expect(html).toContain('Collect signatures');
    expect(html).toContain('Ready to broadcast');
    // The first stage is the current one before anything is built.
    expect(html).toContain('aria-current="step"');
  });

  it('does not ask for a master fingerprint on send', () => {
    // SeedCash signs from the BIP32 path in the PSBT 0x06 record and ignores
    // the fingerprint. Asking for it on this screen implied it was required.
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <I18nProvider>
          <StaticRouter location="/send">
            <WatchOnlySend />
          </StaticRouter>
        </I18nProvider>
      </Provider>
    );

    expect(html).not.toContain('Master fingerprint');
    expect(html).not.toContain('Signer options');
    expect(html).not.toContain('no master fingerprint set');
  });

  it('keeps sighash behind Advanced and omits desktop QR density on mobile', () => {
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <I18nProvider>
          <StaticRouter location="/send">
            <WatchOnlySend />
          </StaticRouter>
        </I18nProvider>
      </Provider>
    );

    expect(html).not.toContain('Sighash type');
    expect(html).not.toContain('Increase QR density');
    expect(html).not.toContain('Decrease QR density');
  });

});

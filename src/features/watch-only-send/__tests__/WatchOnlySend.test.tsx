import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import WatchOnlySend from '../WatchOnlySend';
import {
  noSpendableBchCoinsHint,
  unsignedBuildAvailability,
} from '../sendEmptyState';
import { store } from '../../../state/store';
import { I18nProvider } from '../../../i18n/I18nProvider';

const source = readFileSync(
  join(process.cwd(), 'src/features/watch-only-send/WatchOnlySend.tsx'),
  'utf8'
);

describe('WatchOnlySend workspace', () => {
  it('gives context-correct recovery guidance when no BCH coins are available', () => {
    expect(noSpendableBchCoinsHint(false)).toContain(
      'Refresh this wallet’s coin list'
    );
    expect(noSpendableBchCoinsHint(false)).not.toContain('multisig');
    expect(noSpendableBchCoinsHint(true)).toContain(
      'Refresh the multisig address inventory'
    );
  });

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

  it('blocks building without a selected coin and describes the missing state', () => {
    expect(
      unsignedBuildAvailability({
        busy: false,
        networkRefreshing: false,
        networkRefreshFailed: false,
        selectedInputCount: 0,
        availableInputCount: 0,
      })
    ).toEqual({
      disabled: true,
      reason:
        'A spendable BCH coin is required to build an unsigned transaction.',
    });
    expect(
      unsignedBuildAvailability({
        busy: false,
        networkRefreshing: false,
        networkRefreshFailed: false,
        selectedInputCount: 0,
        availableInputCount: 2,
      }).reason
    ).toBe('Select at least one coin to build an unsigned transaction.');
    expect(
      unsignedBuildAvailability({
        busy: true,
        networkRefreshing: false,
        networkRefreshFailed: false,
        selectedInputCount: 1,
        availableInputCount: 1,
      })
    ).toEqual({ disabled: true, reason: null });
    expect(
      unsignedBuildAvailability({
        busy: false,
        networkRefreshing: false,
        networkRefreshFailed: false,
        selectedInputCount: 1,
        availableInputCount: 1,
      })
    ).toEqual({ disabled: false, reason: null });
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

  it('keeps technical watch-only diagnostics behind friendly recovery copy', () => {
    expect(source).toContain('friendlyWatchOnlyError(error, t)');
    expect(source).toContain("t('send.technicalDetails')");
    expect(source).toContain('whitespace-pre-wrap break-words');
    expect(source).not.toContain('{error}</p>');
  });
});

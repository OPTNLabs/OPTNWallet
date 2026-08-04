import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';
import Bip44AccountPathFields from '../Bip44AccountPathFields';
import { Network } from '../../state/slices/networkSlice';
import { I18nProvider } from '../../i18n/I18nProvider';
import { store } from '../../state/store';

describe('Bip44AccountPathFields', () => {
  it('renders numeric controls with fixed hardened path structure', () => {
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <I18nProvider>
          <Bip44AccountPathFields
            network={Network.CHIPNET}
            value="m/44'/1'/7'"
            onChange={() => {}}
          />
        </I18nProvider>
      </Provider>
    );

    expect(html).toContain('m/44&#x27;/1&#x27;/7&#x27;');
    expect(html).toContain('aria-label="BIP44 coin type"');
    expect(html).toContain('aria-label="BIP44 account index"');
    expect(html).toContain('value="1"');
    expect(html).toContain('value="7"');
    expect(html).not.toContain('value="m/44&#x27;/1&#x27;/7&#x27;"');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import WatchOnlySend from '../WatchOnlySend';
import { store } from '../../../state/store';
describe('WatchOnlySend workspace', () => {
  it('renders the workspace shell (loading state on first paint)', () => {
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <StaticRouter location="/send">
          <WatchOnlySend />
        </StaticRouter>
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
        <StaticRouter location="/send">
          <WatchOnlySend />
        </StaticRouter>
      </Provider>
    );

    expect(html).toContain('Prepare');
    expect(html).toContain('Sign');
    expect(html).toContain('Broadcast');
    // The first stage is the current one before anything is built.
    expect(html).toContain('aria-current="step"');
  });

  it('keeps the fingerprint out of the main send path', () => {
    // It is set once per wallet and remembered. Sitting between the amount and
    // the primary action, it read as something to fill in on every send.
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <StaticRouter location="/send">
          <WatchOnlySend />
        </StaticRouter>
      </Provider>
    );

    // Present, but behind a disclosure rather than inline in the form.
    expect(html).not.toContain('<label class="block space-y-1 text-sm wallet-text-strong">Master fingerprint');
  });
});

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
});

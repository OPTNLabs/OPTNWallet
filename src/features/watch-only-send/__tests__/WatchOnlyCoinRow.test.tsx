import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../../../i18n/I18nProvider';
import { store } from '../../../state/store';
import type { CoinControlLabel } from '../../../services/psbt/coinControlLabels';
import { WatchOnlyCoinRow } from '../WatchOnlyCoinRow';

const BCH: CoinControlLabel = {
  kind: 'bch',
  title: 'BCH',
  name: null,
  category: null,
  category_short: null,
  amount: null,
  nft_capability: null,
  caveat: null,
  bch_send_refusal: null,
};

const MUSD: CoinControlLabel = {
  kind: 'fungible',
  title: 'MUSD',
  name: 'Moria USD',
  category: 'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366',
  category_short: 'b38a33f7…ed87f366',
  amount: '123.45',
  nft_capability: null,
  caveat: null,
  bch_send_refusal: 'token-bearing coins require a token-aware transfer',
};

function render(label: CoinControlLabel | null, checked = false) {
  return renderToStaticMarkup(
    <Provider store={store}>
      <I18nProvider>
        <WatchOnlyCoinRow
          testId="row"
          outpoint="abcd…1234:1"
          detail="0.00001 BCH · receive#3"
          label={label}
          checked={checked}
          onToggle={() => {}}
        />
      </I18nProvider>
    </Provider>
  );
}

describe('WatchOnlyCoinRow', () => {
  it('shows a fungible token coin by what it carries and keeps it unselectable', () => {
    const html = render(MUSD);
    expect(html).toContain('123.45 MUSD');
    expect(html).toContain('FT');
    // The category always travels with the name: tickers are not unique.
    expect(html).toContain('Moria USD · b38a33f7…ed87f366');
    expect(html).toContain('0.00001 BCH · receive#3');
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toContain(
      'Kept out of this BCH send: token-bearing coins require a token-aware transfer.'
    );
  });

  it('marks an NFT with its capability and an unverified identity with its caveat', () => {
    const html = render({
      ...MUSD,
      kind: 'nft',
      title: 'CashToken',
      name: null,
      amount: null,
      nft_capability: 'Minting',
      caveat: 'unverified',
    });
    expect(html).toContain('CashToken');
    expect(html).toContain('NFT');
    expect(html).toContain('Minting');
    expect(html).toContain('unverified');
    expect(html).not.toContain('123.45');
  });

  it('leaves a BCH coin selectable with no token detail', () => {
    const html = render(BCH);
    expect(html).not.toMatch(/disabled=""/);
    expect(html).not.toContain('Kept out of this BCH send');
    expect(html).not.toContain('FT');
  });

  it('lets a token coin that is already selected be deselected', () => {
    // A restored proposal can arrive with a token coin checked.
    expect(render(MUSD, true)).not.toMatch(/disabled=""/);
  });
});

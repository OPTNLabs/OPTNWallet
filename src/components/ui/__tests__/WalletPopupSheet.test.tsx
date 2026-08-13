import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import WalletPopupSheet from '../WalletPopupSheet';

describe('WalletPopupSheet', () => {
  it('pins the footer and scrolls the body so approve stays reachable', () => {
    const html = renderToStaticMarkup(
      <WalletPopupSheet footer={<button type="button">Approve</button>}>
        <p>Long proposal details</p>
      </WalletPopupSheet>
    );

    expect(html).toContain('wallet-popup-panel');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('overscroll-contain');
    expect(html).toContain('100dvh');
    expect(html).toContain('Approve');
    expect(html.indexOf('Long proposal details')).toBeLessThan(
      html.indexOf('Approve')
    );
  });
});

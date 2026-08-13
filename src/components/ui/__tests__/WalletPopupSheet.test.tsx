import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

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

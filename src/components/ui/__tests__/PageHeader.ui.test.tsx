import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PageHeader from '../PageHeader';

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { networkType: 'chipnet' },
      network: { currentNetwork: 'chipnet' },
    }),
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      key === 'network.chipnet'
        ? 'Chipnet'
        : key === 'network.mainnet'
          ? 'Mainnet'
          : key,
  }),
}));

describe('PageHeader', () => {
  it('places the title and context around the centered logo', () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="Home" subtitle="Chipnet" compact />
    );

    expect(markup).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    expect(markup).toContain('break-words');
    expect(markup).not.toContain('truncate text-left text-lg');
    expect(markup.indexOf('Home')).toBeLessThan(markup.indexOf('OPTN'));
    expect(markup.indexOf('OPTN')).toBeLessThan(markup.indexOf('Chipnet'));
    expect(markup).not.toContain('title="Chipnet"');
  });

  it('does not render a separate header subtitle', () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="Home" subtitle="Chipnet" compact />
    );

    expect(markup.match(/Chipnet/g)?.length).toBe(2);
    expect(markup).not.toContain('max-w-full truncate text-xs');
  });
});

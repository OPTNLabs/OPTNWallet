import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../TokenQuery', () => ({
  default: () => <div>TokenQuery</div>,
}));

vi.mock('../../hooks/useSharedTokenMetadata', () => ({
  default: () => ({
    '0123456789abcdef': {
      status: 'ready',
      freshness: 'fresh',
      name: 'Sample Token',
      symbol: 'SMP',
      decimals: 2,
      iconUri: 'https://example.com/icon.png',
      snapshot: {
        name: 'Sample Token',
        token: {
          category: '0123456789abcdef',
          symbol: 'SMP',
          decimals: 2,
        },
        uris: {
          icon: 'https://example.com/icon.png',
        },
        extensions: {},
      },
      isRefreshing: false,
    },
  }),
}));

import CashTokenCard from '../CashTokenCard';

describe('CashTokenCard', () => {
  it('renders BCMR-backed token identity and amount consistently', () => {
    const html = renderToStaticMarkup(
      <CashTokenCard
        category="0123456789abcdef"
        totalAmount={1234500n}
        decimals={2}
      />
    );

    expect(html).toContain('Sample Token');
    expect(html).toContain('SMP');
    expect(html).toContain('Fresh');
    expect(html).toContain('12345');
  });
});

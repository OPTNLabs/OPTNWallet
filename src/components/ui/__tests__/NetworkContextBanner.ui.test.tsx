/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NetworkContextBanner from '../NetworkContextBanner';

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const copy: Record<string, string> = {
        'network.mainnet': 'Mainnet',
        'network.chipnet': 'Chipnet',
        'network.liveMarker': 'LIVE',
        'network.testMarker': 'TEST',
        'network.activeLabel': `Active network: ${values?.network ?? ''}`,
        'settingsNetwork.mainnetDescription': 'Live BCH network — real funds',
        'settingsNetwork.chipnetDescription':
          'BCH testnet for upcoming CHIPs — test funds only',
      };
      return copy[key] ?? key;
    },
  }),
}));

afterEach(cleanup);

it('makes Mainnet and Chipnet visually and textually distinct', () => {
  const { rerender } = render(<NetworkContextBanner network="mainnet" />);
  const banner = screen.getByRole('region');

  expect(banner).toHaveTextContent('LIVE');
  expect(banner).toHaveTextContent('Mainnet');
  expect(banner).toHaveClass('bg-emerald-500/15');

  rerender(<NetworkContextBanner network="chipnet" />);

  expect(banner).toHaveTextContent('TEST');
  expect(banner).toHaveTextContent('Chipnet');
  expect(banner).toHaveClass('bg-indigo-500/15');
});

it('marks the legacy surface for centralized header replacement', () => {
  const { container } = render(<NetworkContextBanner network="mainnet" />);
  expect(container.firstElementChild).toHaveClass('network-context-banner');
});

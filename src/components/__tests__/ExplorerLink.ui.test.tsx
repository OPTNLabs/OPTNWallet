/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Network } from '../../state/slices/networkSlice';

const mocks = vi.hoisted(() => ({
  useExplorerLink: vi.fn(),
}));

vi.mock('../../utils/servers/useExplorerLink', () => ({
  useExplorerLink: mocks.useExplorerLink,
}));
vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import ExplorerLink from '../ExplorerLink';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExplorerLink', () => {
  it('links to explorer settings when policy blocks the explorer', () => {
    mocks.useExplorerLink.mockReturnValue({
      tx: () => null,
      reason: 'Explorer access is unavailable.',
    });

    render(
      <MemoryRouter>
        <ExplorerLink network={Network.MAINNET} txid={'a'.repeat(64)} />
      </MemoryRouter>
    );

    expect(screen.getByText('Explorer access is unavailable.')).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'history.openExplorerSettings' })
    ).toHaveAttribute('href', '/settings?panel=explorer');
  });

  it('keeps the selected explorer action separate when available', () => {
    mocks.useExplorerLink.mockReturnValue({
      tx: () => 'https://explorer.example/tx/abc',
      reason: null,
    });

    render(
      <MemoryRouter>
        <ExplorerLink
          network={Network.CHIPNET}
          txid="abc"
          label="Open explorer"
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Open explorer' })).toHaveAttribute(
      'href',
      'https://explorer.example/tx/abc'
    );
  });
});

/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readBundle: vi.fn(),
  mount: vi.fn(),
}));
vi.mock('../../services/addons/AddonInstallService', () => ({
  readAddonBundleSource: mocks.readBundle,
}));
vi.mock('../../services/addons/AddonIframeBridge', () => ({
  mountAddonIframe: mocks.mount,
}));
vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));

import AddonIframeHost from '../apps/AddonIframeHost';

const props = {
  manifest: { id: 'fixture.addon' },
  app: { id: 'fixture.app', entryFile: 'index.js' },
  sdk: {},
} as React.ComponentProps<typeof AddonIframeHost>;

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it('announces a bundle failure and retries loading from the installed source', async () => {
  mocks.readBundle
    .mockRejectedValueOnce(new Error('Stored addon bundle is unavailable'))
    .mockResolvedValueOnce('fixture source');
  mocks.mount.mockImplementation(({ container }) => {
    const ready = document.createElement('p');
    ready.textContent = 'Sandbox ready';
    container.appendChild(ready);
    return { destroy: vi.fn(), setLocale: vi.fn() };
  });

  render(<AddonIframeHost {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Stored addon bundle is unavailable'
  );
  const retry = screen.getByRole('button', { name: 'apps.retryAddon' });
  expect(retry).toHaveClass('min-h-[44px]');
  fireEvent.click(retry);

  expect(await screen.findByText('Sandbox ready')).toBeInTheDocument();
  expect(mocks.readBundle).toHaveBeenCalledTimes(2);
  expect(mocks.mount).toHaveBeenCalledOnce();
});

it('announces sandbox initialization errors and permits a remount retry', async () => {
  mocks.readBundle.mockResolvedValue('fixture source');
  mocks.mount.mockImplementationOnce(({ onInitError }) => {
    onInitError('Sandbox could not initialize');
    return { destroy: vi.fn(), setLocale: vi.fn() };
  });
  mocks.mount.mockImplementationOnce(({ container }) => {
    const ready = document.createElement('p');
    ready.textContent = 'Sandbox recovered';
    container.appendChild(ready);
    return { destroy: vi.fn(), setLocale: vi.fn() };
  });

  render(<AddonIframeHost {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Sandbox could not initialize'
  );
  fireEvent.click(screen.getByRole('button', { name: 'apps.retryAddon' }));
  await waitFor(() =>
    expect(screen.getByText('Sandbox recovered')).toBeInTheDocument()
  );
  expect(mocks.mount).toHaveBeenCalledTimes(2);
});

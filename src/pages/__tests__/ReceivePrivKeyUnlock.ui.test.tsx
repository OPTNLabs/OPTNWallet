/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  retrieveKeys: vi.fn(),
  fetchAddressPrivateKey: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: {
        currentWalletId: 7,
        walletType: 'standard',
        networkType: 'chipnet',
        derivationPath: '',
      },
    }),
}));
vi.mock('../../services/KeyService', () => ({
  default: {
    retrieveKeys: mocks.retrieveKeys,
    fetchAddressPrivateKey: mocks.fetchAddressPrivateKey,
    createQuantumrootVault: async () => null,
  },
}));
vi.mock('../../features/rpa/RpaReceiveCard', () => ({
  RpaReceiveCard: () => null,
}));
vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('qrcode.react', () => ({
  QRCodeSVG: () => <svg aria-label="Receive QR" />,
}));

import Receive from '../Receive';

function RouteControls() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/apps')}>
        Go to Apps
      </button>
      <button type="button" onClick={() => navigate('/receive')}>
        Go to Receive
      </button>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  mocks.retrieveKeys.mockResolvedValue([
    {
      address: 'bchtest:qfixture',
      tokenAddress: 'bchtest:zfixture',
      publicKey: new Uint8Array([2, 3]),
      pubkeyHash: new Uint8Array([4, 5]),
      changeIndex: 0,
      addressIndex: 0,
    },
  ]);
  mocks.fetchAddressPrivateKey.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('keeps PrivKey absent until ten PubKey taps and resets after leaving Receive', async () => {
  render(
    <MemoryRouter initialEntries={['/receive']}>
      <RouteControls />
      <Routes>
        <Route path="/receive" element={<Receive />} />
        <Route path="/apps" element={<div>Apps view</div>} />
      </Routes>
    </MemoryRouter>
  );

  const pubKey = await screen.findByRole('button', { name: 'PubKey' });
  expect(screen.queryByRole('button', { name: 'PrivKey' })).toBeNull();

  for (let tap = 1; tap < 10; tap += 1) {
    fireEvent.click(pubKey);
    expect(screen.queryByRole('button', { name: 'PrivKey' })).toBeNull();
    expect(mocks.fetchAddressPrivateKey).not.toHaveBeenCalled();
    if (tap < 5) {
      expect(screen.queryByRole('status')).toBeNull();
    } else {
      expect(screen.getByRole('status')).toHaveTextContent(
        'receive.privKeyUnlock'
      );
    }
  }

  fireEvent.click(pubKey);
  expect(screen.getByRole('button', { name: 'PrivKey' })).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
  await waitFor(() => {
    expect(mocks.fetchAddressPrivateKey).toHaveBeenCalledTimes(1);
  });

  fireEvent.click(screen.getByRole('button', { name: 'Go to Apps' }));
  expect(screen.getByText('Apps view')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Go to Receive' }));
  await screen.findByRole('button', { name: 'PubKey' });
  expect(screen.queryByRole('button', { name: 'PrivKey' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'PubKey' }));
  expect(screen.queryByRole('button', { name: 'PrivKey' })).toBeNull();
  expect(mocks.fetchAddressPrivateKey).toHaveBeenCalledTimes(1);
});

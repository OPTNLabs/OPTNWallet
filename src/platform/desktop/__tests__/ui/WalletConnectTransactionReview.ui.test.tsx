/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { translations } from '../../../../i18n/resources';
import type { TranslationKey } from '../../../../i18n/resources';

const mock = vi.hoisted(() => ({
  state: {} as unknown,
  loadWalletPublicAddresses: vi.fn(),
}));
vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) => selector(mock.state),
}));
vi.mock('../../../../hooks/useOutboundTransactions', () => ({
  default: () => ({ hasUnresolved: false }),
}));
vi.mock('../../../../components/ui/WalletTooltip', () => ({
  default: () => null,
}));
vi.mock('../../../../services/connect/walletPublicAddresses', () => ({
  loadWalletPublicAddresses: mock.loadWalletPublicAddresses,
}));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: TranslationKey) => translations.en[key] }),
}));

import { SignTransactionModal } from '../../../../components/walletconnect/SignTransactionModal';

afterEach(cleanup);

beforeEach(() => {
  const address = lockingBytecodeToCashAddress({
    prefix: 'bchtest',
    bytecode: hexToBin('76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'),
  });
  if (typeof address === 'string') throw new Error(address);
  mock.loadWalletPublicAddresses.mockResolvedValue([address.address]);
});

function request() {
  const lockingBytecode = hexToBin(
    '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'
  );
  return {
    id: 1,
    topic: 'example',
    params: {
      request: {
        params: {
          transaction: {
            version: 2,
            locktime: 0,
            inputs: [
              {
                outpointTransactionHash: new Uint8Array(32).fill(1),
                outpointIndex: 3,
                sequenceNumber: 0xffffffff,
                unlockingBytecode: new Uint8Array(),
              },
            ],
            outputs: [{ lockingBytecode, valueSatoshis: 9_000n }],
          },
          sourceOutputs: [{ lockingBytecode, valueSatoshis: 10_000n }],
          broadcast: false,
        },
      },
    },
  };
}

it('shows Chipnet destinations and a verified wallet effect', async () => {
  mock.state = {
    wallet_id: { currentWalletId: 1, networkType: 'chipnet' },
    walletconnect: {
      pendingSignTx: request(),
      activeSessions: {},
    },
  };
  render(<SignTransactionModal />);
  expect(
    screen.getByRole('heading', { name: 'Review this transaction request' })
  ).toBeInTheDocument();
  expect(screen.getByText('Chipnet')).toBeInTheDocument();
  expect(screen.getByText('Sign and return to the app')).toBeInTheDocument();
  expect(screen.getByText('0.00001000 BCH')).toBeInTheDocument();
  expect(await screen.findByText('Verified wallet effect')).toBeInTheDocument();
  expect(screen.getByText('−0.00001000 BCH')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Inputs/ }));
  expect(screen.getByText('Index: 3')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Outputs/ }));
  expect(screen.getByText(/bchtest:/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign' })).toBeEnabled();
});

it('blocks an incomplete request without displaying a negative fee', () => {
  const pendingSignTx = request();
  pendingSignTx.params.request.params.sourceOutputs = [];
  mock.state = {
    wallet_id: { currentWalletId: 1, networkType: 'chipnet' },
    walletconnect: { pendingSignTx, activeSessions: {} },
  };
  render(<SignTransactionModal />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    translations.en['wc.unsupportedTransaction']
  );
  expect(screen.getByRole('button', { name: 'Sign' })).toBeDisabled();
  expect(screen.queryByText(/-0\.00009 BCH/)).not.toBeInTheDocument();
});

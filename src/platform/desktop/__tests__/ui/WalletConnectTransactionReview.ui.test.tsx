/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { hexToBin } from '@bitauth/libauth';
import { afterEach, expect, it, vi } from 'vitest';
import { translations } from '../../../../i18n/resources';
import type { TranslationKey } from '../../../../i18n/resources';

const mock = vi.hoisted(() => ({ state: {} as unknown }));
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
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: TranslationKey) => translations.en[key] }),
}));

import { SignTransactionModal } from '../../../../components/walletconnect/SignTransactionModal';

afterEach(cleanup);

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

it('shows Chipnet destinations and a valid input outpoint in the default review', () => {
  mock.state = {
    wallet_id: { currentWalletId: 1, networkType: 'chipnet' },
    walletconnect: {
      pendingSignTx: request(),
      activeSessions: {},
    },
  };
  render(<SignTransactionModal />);
  expect(screen.getByText('Chipnet transaction')).toBeInTheDocument();
  expect(screen.getByText(/bchtest:/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Inputs/ }));
  expect(screen.getByText('Index: 3')).toBeInTheDocument();
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

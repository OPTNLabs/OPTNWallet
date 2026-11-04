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
  dispatch: vi.fn(),
  fixture: false,
}));
vi.mock('react-redux', () => ({
  useDispatch: () => mock.dispatch,
  useSelector: (selector: (state: unknown) => unknown) => selector(mock.state),
}));
vi.mock('../../../../ui-fixtures/fixtureData', () => ({
  isUiFixtureEnabled: () => mock.fixture,
}));
vi.mock('../../../../hooks/useOutboundTransactions', () => ({
  default: () => ({ hasUnresolved: false }),
}));
vi.mock('../../../../components/ui/WalletTooltip', () => ({
  default: () => null,
}));
vi.mock('../../../../hooks/useSharedTokenMetadata', () => ({
  default: (categories: string[]) =>
    Object.fromEntries(
      categories.map((category) => [
        category,
        {
          status: 'ready',
          freshness: 'fresh',
          name: 'PUSD',
          symbol: 'PUSD',
          decimals: 0,
          identityStatus: 'verified',
          iconUri: null,
          snapshot: {
            name: 'PUSD',
            token: { category, symbol: 'PUSD', decimals: 0 },
          },
          isRefreshing: false,
        },
      ])
    ),
}));
vi.mock('../../../../services/connect/walletPublicAddresses', () => ({
  loadWalletPublicAddresses: mock.loadWalletPublicAddresses,
}));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: TranslationKey) => translations.en[key] }),
}));

import { SignTransactionModal } from '../../../../components/walletconnect/SignTransactionModal';

afterEach(() => {
  cleanup();
  mock.fixture = false;
  mock.dispatch.mockReset();
});

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
  expect(
    screen.getByRole('button', { name: 'Sign and return to the app' })
  ).toBeInTheDocument();
  expect(
    await screen.findByText('What changes in this wallet')
  ).toBeInTheDocument();
  expect(
    (await screen.findAllByText('0.00001000 BCH')).length
  ).toBeGreaterThanOrEqual(2);
  fireEvent.click(screen.getByText(/Technical transaction details/));
  expect(screen.getByText('Output index: 3')).toBeInTheDocument();
  const addressTrigger = screen.getByRole('button', { name: 'Copy address' });
  expect(addressTrigger).not.toHaveTextContent('bchtest:');
  fireEvent.contextMenu(addressTrigger);
  const dialogs = screen.getAllByRole('dialog');
  expect(dialogs[dialogs.length - 1]).toHaveTextContent('bchtest:');
  expect(
    screen.getByRole('button', { name: 'Sign and return to the app' })
  ).toBeEnabled();
  mock.fixture = true;
  fireEvent.click(
    screen.getByRole('button', { name: 'Sign and return to the app' })
  );
  expect(mock.dispatch).not.toHaveBeenCalled();
  mock.fixture = false;
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
  expect(
    screen.getByRole('button', { name: 'Sign and return to the app' })
  ).toBeDisabled();
  expect(screen.queryByText(/-0\.00009 BCH/)).not.toBeInTheDocument();
});

it('surfaces a Cauldron swap prompt and token label before technical details', async () => {
  const pendingSignTx = request();
  pendingSignTx.params.request.params.userPrompt =
    'Cauldron swap 0.00999962 BCH -> PUSD';
  pendingSignTx.params.request.params.transaction.outputs[0].token = {
    category: new Uint8Array(32).fill(2),
    amount: 267n,
  };
  mock.state = {
    wallet_id: { currentWalletId: 1, networkType: 'chipnet' },
    walletconnect: {
      pendingSignTx,
      activeSessions: {},
    },
  };
  render(<SignTransactionModal />);

  expect(
    screen.getByRole('heading', { name: 'Cauldron swap' })
  ).toBeInTheDocument();
  expect(screen.getByText('0.00999962 BCH → PUSD')).toBeInTheDocument();
  expect(await screen.findByText('You receive PUSD')).toBeInTheDocument();
  expect(screen.getByText('267 atoms PUSD')).toBeInTheDocument();
  expect(screen.getAllByText('BCMR: Verified').length).toBeGreaterThanOrEqual(
    1
  );
  const technicalDetails = screen.getByText(/Technical transaction details/);
  expect(technicalDetails.closest('details')).not.toHaveAttribute('open');
  expect(technicalDetails.closest('summary')).toHaveClass('min-h-[44px]');
});

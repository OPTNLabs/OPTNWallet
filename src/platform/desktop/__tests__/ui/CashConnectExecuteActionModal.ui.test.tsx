/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { translations } from '../../../../i18n/resources';
import type { TranslationKey } from '../../../../i18n/resources';

const mock = vi.hoisted(() => ({
  state: {} as unknown,
  dispatch: vi.fn(),
  approve: vi.fn(() => ({ type: 'cashconnect/approve' })),
  reject: vi.fn(() => ({ type: 'cashconnect/reject' })),
  notify: vi.fn(),
  fixture: false,
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mock.dispatch,
  useSelector: (selector: (state: unknown) => unknown) => selector(mock.state),
}));
vi.mock('../../../../state/slices/cashconnectSlice', () => ({
  approveCashConnectActionAction: mock.approve,
  rejectCashConnectActionAction: mock.reject,
}));
vi.mock('../../../../utils/copyWithFeedback', () => ({
  showWalletNotification: mock.notify,
}));
vi.mock('../../../../ui-fixtures/fixtureData', () => ({
  isUiFixtureEnabled: () => mock.fixture,
}));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: TranslationKey) => translations.en[key] }),
}));

import CashConnectExecuteActionModal from '../../../../components/cashconnect/CashConnectExecuteActionModal';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  mock.fixture = false;
});

it('guards repeated approval and explains that the app receives prepared transactions', async () => {
  mock.state = {
    cashconnect: {
      pendingAction: {
        session: {
          dapp: { name: 'Example dApp', url: 'https://example.test' },
          template: { name: 'Swap' },
        },
        request: { action: 'swap' },
        response: {
          meta: { title: ['Swap'] },
          balanceChanges: { sats: -1000n },
          transactions: ['prepared'],
        },
      },
    },
  };
  mock.dispatch.mockReturnValue({
    unwrap: () => Promise.resolve(undefined),
  });
  mock.notify.mockResolvedValue(undefined);

  render(<CashConnectExecuteActionModal />);
  expect(
    screen.getByText(/The app may submit them to the network/)
  ).toBeInTheDocument();
  const approve = screen.getByRole('button', { name: 'Approve request' });
  fireEvent.click(approve);
  fireEvent.click(approve);

  await waitFor(() => expect(mock.approve).toHaveBeenCalledOnce());
  expect(mock.notify).toHaveBeenCalledWith(
    translations.en['cashconnect.actionApproved']
  );
});

it('keeps fixture approval and rejection display-only', () => {
  mock.fixture = true;
  mock.state = {
    cashconnect: {
      pendingAction: {
        session: {
          dapp: { name: 'Example dApp', url: 'https://example.test' },
          template: { name: 'Swap' },
          chain: 'bchtest',
        },
        request: { action: 'swap' },
        response: {
          meta: { title: ['Swap'] },
          balanceChanges: { sats: -1000n },
          transactions: ['prepared'],
        },
      },
    },
  };

  render(<CashConnectExecuteActionModal />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[1]);

  expect(mock.approve).not.toHaveBeenCalled();
  expect(mock.reject).not.toHaveBeenCalled();
});

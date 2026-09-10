/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translations } from '../../../../i18n/resources';
import type { TranslationKey } from '../../../../i18n/resources';
import { SessionList } from '../../../../components/walletconnect/SessionList';
import WizardConnectPanel from '../../../../components/wizardconnect/WizardConnectPanel';
import CashConnectPanel from '../../../../components/cashconnect/CashConnectPanel';
import WizardSignTransactionModal from '../../../../components/wizardconnect/WizardSignTransactionModal';
import { binToHex, encodeTransaction, hexToBin } from '@bitauth/libauth';

const mock = vi.hoisted(() => ({ state: {} as unknown }));
vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) => selector(mock.state),
}));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: TranslationKey) => translations.en[key] }),
}));
vi.mock('../../../../state/slices/wizardconnectSlice', () => ({
  disconnectWizardConnection: vi.fn(),
  approveWizardSignRequest: vi.fn(),
  rejectWizardSignRequest: vi.fn(),
}));
vi.mock('../../../../state/slices/cashconnectSlice', () => ({
  disconnectCashConnectThunk: vi.fn(),
}));
vi.mock('../../../../components/wizardconnect/WizardConnectionManager', () => ({
  default: () => null,
}));
vi.mock(
  '../../../../components/wizardconnect/WizardConnectionSettingsModal',
  () => ({ default: () => null })
);
vi.mock('../../../../components/wizardconnect/WizardDappAvatar', () => ({
  default: () => null,
}));
vi.mock('../../../../components/cashconnect/CashConnectPairCard', () => ({
  default: () => null,
}));

afterEach(cleanup);

describe('connection panels', () => {
  it('previews raw WizardConnect transactions on Chipnet and blocks invalid previews', () => {
    const transaction = {
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointIndex: 3,
          outpointTransactionHash: new Uint8Array(32).fill(1),
          sequenceNumber: 0xffffffff,
          unlockingBytecode: new Uint8Array(),
        },
      ],
      outputs: [
        {
          valueSatoshis: 1000n,
          lockingBytecode: hexToBin(
            '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'
          ),
        },
      ],
    };
    const request = {
      sequence: 1,
      transaction: {
        transaction: binToHex(encodeTransaction(transaction)),
        sourceOutputs: [
          {
            valueSatoshis: 2000n,
            lockingBytecode: transaction.outputs[0].lockingBytecode,
          },
        ],
      },
    };
    mock.state = {
      wallet_id: { currentWalletId: 1, networkType: 'chipnet' },
      wizardconnect: {
        activeConnections: { relay: { status: { status: 'connected' } } },
        pendingSignRequest: { connectionId: 'relay', request },
      },
    };
    const view = render(<WizardSignTransactionModal />);
    expect(screen.getByText(/^bchtest:/)).toBeInTheDocument();
    expect(
      screen.getByText('Relay available — dApp connection not verified')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign', exact: true })
    ).toBeEnabled();
    request.transaction.sourceOutputs = [];
    view.rerender(<WizardSignTransactionModal />);
    expect(
      screen.getByRole('button', { name: 'Sign', exact: true })
    ).toBeDisabled();
    request.transaction.transaction = 'not hex';
    view.rerender(<WizardSignTransactionModal />);
    expect(
      screen.getByRole('button', { name: 'Sign', exact: true })
    ).toBeDisabled();
  });
  it('does not promote relay connectivity to an established dApp session', () => {
    mock.state = {
      wizardconnect: {
        activeConnections: {
          relay: {
            id: 'relay',
            connectedAt: 1,
            status: { status: 'connected' },
            label: 'Example',
            uri: 'wiz://example',
          },
        },
      },
    };
    render(<WizardConnectPanel />);
    expect(
      screen.getByText('Relay available — dApp connection not verified')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('connected', { exact: true })
    ).not.toBeInTheDocument();
  });

  it('keeps CashConnect approval and failure visible with no established session', () => {
    mock.state = {
      cashconnect: { sessions: {}, pendingProposal: {}, errorMessage: null },
    };
    const view = render(<CashConnectPanel />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waiting for your approval'
    );
    mock.state = {
      cashconnect: {
        sessions: {},
        pendingProposal: {},
        errorMessage: 'failed',
      },
    };
    view.rerender(<CashConnectPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Connection attempt failed'
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders an unacknowledged WalletConnect record as pending', () => {
    const session = {
      acknowledged: false,
      expiry: Date.now() / 1000 + 600,
      peer: {
        metadata: {
          name: 'Example',
          url: 'https://example.com',
          icons: [],
          description: '',
        },
      },
    };
    render(
      <SessionList
        activeSessions={
          { topic: session } as React.ComponentProps<
            typeof SessionList
          >['activeSessions']
        }
        onDeleteSession={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waiting for session acknowledgement'
    );
  });
});

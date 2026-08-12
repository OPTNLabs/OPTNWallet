import type { WalletConnectionManager, RelayConnectionState, PendingSignRequest } from '@wizardconnect/wallet';

export type ActiveWizardConnections = Record<string, RelayConnectionState>;
export type PendingWizardSignRequest = PendingSignRequest | null;

export type WizardConnectState = {
  manager: WalletConnectionManager | null;
  activeConnections: ActiveWizardConnections;
  pendingSignRequest: PendingWizardSignRequest;
  initializedWalletId: number | null;
};

export const initialState: WizardConnectState = {
  manager: null,
  activeConnections: {},
  pendingSignRequest: null,
  initializedWalletId: null,
};

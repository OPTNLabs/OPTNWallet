import type { IWalletKit, WalletKitTypes } from '@reown/walletkit';
import type { SessionTypes } from '@walletconnect/types';

export type JsonRpcSuccess<T> = { id: number; jsonrpc: '2.0'; result: T };
export type JsonRpcError = {
  id: number;
  jsonrpc: '2.0';
  error: { code: number; message: string };
};
export type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

export interface WalletconnectState {
  web3wallet: IWalletKit | null;
  activeSessions: Record<string, SessionTypes.Struct> | null;
  pendingProposal: WalletKitTypes.SessionProposal | null;
  pendingSignMsg: WalletKitTypes.SessionRequest | null;
  pendingSignTx: WalletKitTypes.SessionRequest | null;
}

export type PendingProposalPayload = WalletconnectState['pendingProposal'];
export type PendingSignMsgPayload = WalletconnectState['pendingSignMsg'];
export type PendingSignTxPayload = WalletconnectState['pendingSignTx'];
export type ActiveSessionsPayload = Record<string, SessionTypes.Struct>;

export const initialState: WalletconnectState = {
  web3wallet: null,
  activeSessions: null,
  pendingProposal: null,
  pendingSignMsg: null,
  pendingSignTx: null,
};

export type SessionUpdateEmitter = {
  on: (event: 'session_update', listener: () => void) => void;
};

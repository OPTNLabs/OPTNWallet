import type { RootState } from '../store';

export const selectWalletConnectState = (state: RootState) => state.walletconnect;
export const selectWalletKit = (state: RootState) => state.walletconnect.web3wallet;
export const selectWalletConnectSessions = (state: RootState) =>
  state.walletconnect.activeSessions;
export const selectPendingProposal = (state: RootState) =>
  state.walletconnect.pendingProposal;
export const selectPendingSignMessage = (state: RootState) =>
  state.walletconnect.pendingSignMsg;
export const selectPendingSignTx = (state: RootState) =>
  state.walletconnect.pendingSignTx;

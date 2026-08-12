import { createAsyncThunk } from '@reduxjs/toolkit';
import type { WalletKitTypes } from '@reown/walletkit';
import { getSdkError } from '@walletconnect/utils';
import { Toast } from '@capacitor/toast';
import type { RootState } from '../store';
import KeyService from '../../services/KeyService';
import { SignedMessage } from '../../utils/signed';
import { signWalletConnectTransactionRequest } from './signing';
import {
  buildApprovedNamespacesForCurrentWallet,
  extractWalletConnectMessage,
  normalizeWalletAddressCandidate,
  respondSessionError,
  respondSessionResult,
} from './helpers';
import { PREFIX } from '../../utils/constants';
import { zeroize } from '../../utils/secureMemory';

export const approveSessionProposal = createAsyncThunk(
  'walletconnect/approveSessionProposal',
  async (_, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet!;
    const proposal = state.walletconnect.pendingProposal!;
    const approvedNamespaces = await buildApprovedNamespacesForCurrentWallet(
      state,
      proposal
    );

    return walletKit.approveSession({
      id: proposal.id,
      namespaces: approvedNamespaces,
    });
  }
);

export const rejectSessionProposal = createAsyncThunk(
  'walletconnect/rejectSessionProposal',
  async (_, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    const proposal = state.walletconnect.pendingProposal;
    if (!walletKit || !proposal) {
      throw new Error('No walletKit or proposal to reject.');
    }
    await Toast.show({ text: 'Rejecting session...' });

    await walletKit.rejectSession({
      id: proposal.id,
      reason: getSdkError('USER_REJECTED'),
    });
    return true;
  }
);

export const wcPair = createAsyncThunk(
  'walletconnect/pair',
  async (uri: string, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletKit not ready');
    await walletKit.pair({ uri });
    await Toast.show({ text: 'Paired. Waiting for proposal...' });
  }
);

export const disconnectSession = createAsyncThunk(
  'walletconnect/disconnectSession',
  async (topic: string, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletConnect not initialized');
    await walletKit.disconnectSession({
      topic,
      reason: getSdkError('USER_DISCONNECTED'),
    });
    return walletKit.getActiveSessions();
  }
);

export const respondWithMessageSignature = createAsyncThunk(
  'walletconnect/respondWithMessageSignature',
  async (signMsgRequest: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    const currentWalletId = state.wallet_id.currentWalletId;
    if (!walletKit) throw new Error('WalletKit not initialized');
    if (!currentWalletId) throw new Error('No wallet selected');
    const allKeys = await KeyService.retrieveKeys(currentWalletId);
    if (!allKeys.length) throw new Error('No keys in DB');
    const walletAddresses = new Set(allKeys.map((k) => k.address));
    const prefix = PREFIX[state.network.currentNetwork];
    const rawParams = signMsgRequest.params.request.params;
    const candidateValues: string[] = [];
    if (Array.isArray(rawParams)) {
      for (const item of rawParams) {
        if (typeof item === 'string') candidateValues.push(item);
      }
    } else if (rawParams && typeof rawParams === 'object') {
      const record = rawParams as Record<string, unknown>;
      for (const key of ['address', 'account', 'from']) {
        const value = record[key];
        if (typeof value === 'string') candidateValues.push(value);
      }
    }

    const requestedAddress = candidateValues
      .map((candidate) => normalizeWalletAddressCandidate(candidate, prefix))
      .find((candidate): candidate is string =>
        !!candidate && walletAddresses.has(candidate)
      );

    const address = requestedAddress ?? allKeys[0].address;
    const privKey = await KeyService.fetchAddressPrivateKey(address);
    if (!privKey) throw new Error('No private key found');
    try {
      const { id, topic } = signMsgRequest;
      const message = extractWalletConnectMessage(signMsgRequest);
      const signedMsgResult = await SignedMessage.sign(message, privKey);
      const base64Signature = signedMsgResult.signature;
      await respondSessionResult(walletKit, topic, id, base64Signature);
      return base64Signature;
    } finally {
      zeroize(privKey);
    }
  }
);

export const respondWithTxSignature = createAsyncThunk(
  'walletconnect/respondWithTxSignature',
  async (signTxRequest: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletConnect not initialized');
    const { id, topic, signedTxObject } =
      await signWalletConnectTransactionRequest(signTxRequest, state);
    await walletKit.respondSessionRequest({
      topic,
      response: { id, jsonrpc: '2.0', result: signedTxObject },
    });

    return signedTxObject;
  }
);

export const respondWithTxError = createAsyncThunk(
  'walletconnect/respondWithTxError',
  async (signTxRequest: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletKit not initialized');
    const { id, topic } = signTxRequest;
    return await respondSessionError(
      walletKit,
      topic,
      id,
      'User rejected transaction signing'
    );
  }
);

export const respondWithMessageError = createAsyncThunk(
  'walletconnect/respondWithMessageError',
  async (signMsgRequest: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletKit not initialized');
    const { id, topic } = signMsgRequest;
    return await respondSessionError(
      walletKit,
      topic,
      id,
      'User rejected message signing'
    );
  }
);

export const checkAndDisconnectExpiredSessions = createAsyncThunk(
  'walletconnect/checkAndDisconnectExpiredSessions',
  async (_, { getState, dispatch }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    const activeSessions = state.walletconnect.activeSessions;
    if (!walletKit || !activeSessions) return;

    const currentTime = Math.floor(Date.now() / 1000);
    const expiredTopics = Object.entries(activeSessions)
      .filter(([, session]) => session.expiry && currentTime >= session.expiry)
      .map(([topic]) => topic);
    await Promise.allSettled(
      expiredTopics.map((topic) => dispatch(disconnectSession(topic)))
    );
  }
);

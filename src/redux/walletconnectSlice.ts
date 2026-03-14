// src/redux/walletconnectSlice.ts

import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { Core } from '@walletconnect/core';
import {
  WalletKit,
  type WalletKitTypes,
} from '@reown/walletkit';
import type { RootState } from './store';
import KeyService from '../services/KeyService';
import {
  ActiveSessionsPayload,
  initialState,
  JsonRpcResponse,
  PendingProposalPayload,
  PendingSignMsgPayload,
  PendingSignTxPayload,
} from './walletconnect/types';
import {
  approveSessionProposal,
  checkAndDisconnectExpiredSessions,
  disconnectSession,
  rejectSessionProposal,
  respondWithMessageError,
  respondWithMessageSignature,
  respondWithTxError,
  respondWithTxSignature,
  wcPair,
} from './walletconnect/thunks';
import { registerWalletConnectListeners } from './walletconnect/helpers';
import { logError } from '../utils/errorHandling';

// 1) Initialize WalletConnect
export const initWalletConnect = createAsyncThunk(
  'walletconnect/init',
  async (_, { dispatch }) => {
    // console.log('[walletconnectSlice] initWalletConnect triggered');

    const projectId = import.meta.env.VITE_WC_PROJECT_ID;
    // console.log('[walletconnectSlice] Using projectId:', projectId);

    const core = new Core({ projectId });
    // console.log('[walletconnectSlice] Created Core instance');

    const metadata = {
      name: 'OPTN Wallet',
      description: 'OPTN WalletConnect Integration',
      url: 'https://optnlabs.com',
      icons: ['https://optnlabs.com/logo.png'],
    };
    // console.log('[walletconnectSlice] Using metadata:', metadata);

    const web3wallet = await WalletKit.init({ core, metadata });
    // console.log('[walletconnectSlice] WalletKit initialized');

    const activeSessions = web3wallet.getActiveSessions();
    // console.log(
    //   '[walletconnectSlice] Active sessions at init:',
    //   activeSessions
    // );

    registerWalletConnectListeners(web3wallet, {
      onProposal: (proposal) => dispatch(setPendingProposal(proposal)),
      onSessionUpdate: () =>
        dispatch(setActiveSessions(web3wallet.getActiveSessions())),
      onSessionRequest: (sessionEvent) =>
        dispatch(handleWcRequest(sessionEvent)),
    });

    return { web3wallet, activeSessions };
  }
);

// 3) Handle session requests (e.g. bch_getAddresses, bch_signMessage, bch_signTransaction)
export const handleWcRequest = createAsyncThunk(
  'walletconnect/request',
  async (
    sessionEvent: WalletKitTypes.SessionRequest,
    { getState, dispatch }
  ) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletConnect not initialized');
    const currentWalletId = state.wallet_id.currentWalletId;
    if (!currentWalletId) throw new Error('No wallet selected');

    const { topic, params, id } = sessionEvent;
    const { request } = params;
    const method = request.method;
    // console.log('[handleWcRequest] method =>', method);

    let response: JsonRpcResponse<unknown> | undefined;

    switch (method) {
      case 'bch_getAccounts':
      case 'bch_getAddresses': {
        const allKeys = await KeyService.retrieveKeys(currentWalletId);
        const addresses = allKeys.map((k) => k.address);
        response = { id, jsonrpc: '2.0', result: addresses };
        break;
      }
      case 'bch_signMessage':
      case 'personal_sign': {
        dispatch(setPendingSignMsg(sessionEvent));
        return;
      }
      case 'bch_signTransaction': {
        const existing = state.walletconnect.pendingSignTx;
        if (existing?.id === sessionEvent.id && existing.topic === sessionEvent.topic) {
          return;
        }
        dispatch(setPendingSignTx(sessionEvent));
        return;
      }
      default: {
        response = {
          id,
          jsonrpc: '2.0',
          error: { code: 1001, message: `Unsupported method: ${method}` },
        };
      }
    }
    if (response) {
      // console.log('[handleWcRequest] responding =>', response);
      await walletKit.respondSessionRequest({ topic, response });
    }
  }
);

// Reducer actions for setting pending sign requests
const walletconnectSlice = createSlice({
  name: 'walletconnect',
  initialState,
  reducers: {
    setPendingProposal: (
      state,
      action: PayloadAction<PendingProposalPayload>
    ) => {
      // console.log('[walletconnectSlice] setPendingProposal =>', action.payload);
      state.pendingProposal = action.payload;
    },
    clearPendingProposal: (state) => {
      // console.log('[walletconnectSlice] clearPendingProposal.');
      state.pendingProposal = null;
    },
    setPendingSignMsg: (
      state,
      action: PayloadAction<PendingSignMsgPayload>
    ) => {
      // console.log('[walletconnectSlice] setPendingSignMsg =>', action.payload);
      state.pendingSignMsg = action.payload;
    },
    clearPendingSignMsg: (state) => {
      // console.log('[walletconnectSlice] clearPendingSignMsg.');
      state.pendingSignMsg = null;
    },
    setPendingSignTx: (
      state,
      action: PayloadAction<PendingSignTxPayload>
    ) => {
      // console.log('[walletconnectSlice] setPendingSignTx =>', action.payload);
      state.pendingSignTx = action.payload;
    },
    clearPendingSignTx: (state) => {
      // console.log('[walletconnectSlice] clearPendingSignTx.');
      state.pendingSignTx = null;
    },
    setActiveSessions: (
      state,
      action: PayloadAction<ActiveSessionsPayload>
    ) => {
      state.activeSessions = action.payload;
    },
  },
  extraReducers: (builder) => {
    // Initialization
    builder.addCase(initWalletConnect.fulfilled, (state, action) => {
      // console.log('[initWalletConnect.fulfilled]');
      state.web3wallet = action.payload.web3wallet;
      state.activeSessions = action.payload.activeSessions;
    });
    builder.addCase(initWalletConnect.rejected, (_, action) => {
      logError('walletconnect.init.rejected', action.error);
    });

    // Approve proposal
    builder.addCase(approveSessionProposal.fulfilled, (state) => {
      // console.log('[approveSessionProposal.fulfilled] => session approved');
      state.pendingProposal = null;
      // pull in the newly‑approved session so the UI updates immediately:
      if (state.web3wallet) {
        state.activeSessions = state.web3wallet.getActiveSessions();
      }
    });

    builder.addCase(approveSessionProposal.rejected, (_, action) => {
      logError('walletconnect.approveSessionProposal.rejected', action.error);
    });

    // Reject proposal
    builder.addCase(rejectSessionProposal.fulfilled, (state) => {
      // console.log('[rejectSessionProposal.fulfilled] => session rejected');
      state.pendingProposal = null;
      // pull in the newly‑approved session:
      if (state.web3wallet) {
        state.activeSessions = state.web3wallet.getActiveSessions();
      }
    });
    builder.addCase(rejectSessionProposal.rejected, (_, action) => {
      logError('walletconnect.rejectSessionProposal.rejected', action.error);
    });

    // Session requests
    builder.addCase(handleWcRequest.rejected, (_, action) => {
      logError('walletconnect.handleWcRequest.rejected', action.error);
    });

    // Pairing
    builder.addCase(wcPair.rejected, (_, action) => {
      logError('walletconnect.wcPair.rejected', action.error);
    });

    // disconnect session
    builder.addCase(disconnectSession.fulfilled, (state, action) => {
      // console.log(
      //   '[disconnectSession.fulfilled] Updated active sessions',
      //   action.payload
      // );
      state.activeSessions = action.payload;
    });
    builder.addCase(disconnectSession.rejected, (_, action) => {
      logError('walletconnect.disconnectSession.rejected', action.error);
    });

    builder
      .addCase(respondWithMessageSignature.fulfilled, (s) => {
        s.pendingSignMsg = null;
      })
      .addCase(respondWithMessageError.fulfilled, (s) => {
        s.pendingSignMsg = null;
      })
      .addCase(respondWithTxSignature.fulfilled, (s) => {
        s.pendingSignTx = null;
      })
      .addCase(respondWithTxError.fulfilled, (s) => {
        s.pendingSignTx = null;
      });
  },
});

export const {
  setPendingProposal,
  setActiveSessions,
  clearPendingProposal,
  setPendingSignMsg,
  clearPendingSignMsg,
  setPendingSignTx,
  clearPendingSignTx,
} = walletconnectSlice.actions;
export {
  approveSessionProposal,
  rejectSessionProposal,
  wcPair,
  disconnectSession,
  respondWithMessageSignature,
  respondWithTxSignature,
  respondWithTxError,
  respondWithMessageError,
  checkAndDisconnectExpiredSessions,
};
export default walletconnectSlice.reducer;

import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { Core } from '@walletconnect/core';
import {
  WalletKit,
  type IWalletKit,
  type WalletKitTypes,
} from '@reown/walletkit';

import type { AppDispatch, RootState } from '../store';
import KeyService from '../../services/KeyService';
import {
  ActiveSessionsPayload,
  initialState,
  JsonRpcResponse,
  PendingProposalPayload,
  PendingSignMsgPayload,
  PendingSignTxPayload,
} from '../../redux/walletconnect/types';
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
} from '../../redux/walletconnect/thunks';
import { registerWalletConnectListeners } from '../../redux/walletconnect/helpers';
import { logError } from '../../utils/errorHandling';

let walletKitSingleton: IWalletKit | null = null;
let walletKitInitPromise: Promise<{
  web3wallet: IWalletKit;
  activeSessions: ActiveSessionsPayload;
}> | null = null;
let walletKitListenersRegistered = false;

async function initializeWalletConnect(dispatch: AppDispatch) {
  if (!walletKitSingleton) {
    const projectId = import.meta.env.VITE_WC_PROJECT_ID;
    const core = new Core({ projectId });
    const metadataUrl =
      (typeof window !== 'undefined' && window.location?.origin) ||
      import.meta.env.VITE_WC_METADATA_URL ||
      'https://optnlabs.com';
    const metadata = {
      name: 'OPTN Wallet',
      description: 'OPTN WalletConnect Integration',
      url: metadataUrl,
      icons: ['https://optnlabs.com/logo.png'],
    };

    walletKitSingleton = await WalletKit.init({ core, metadata });
  }

  if (!walletKitListenersRegistered) {
    registerWalletConnectListeners(walletKitSingleton, {
      onProposal: (proposal) => dispatch(setPendingProposal(proposal)),
      onSessionUpdate: () =>
        dispatch(setActiveSessions(walletKitSingleton!.getActiveSessions())),
      onSessionRequest: (sessionEvent) =>
        dispatch(handleWcRequest(sessionEvent)),
    });
    walletKitListenersRegistered = true;
  }

  return {
    web3wallet: walletKitSingleton,
    activeSessions: walletKitSingleton.getActiveSessions(),
  };
}

export const initWalletConnect = createAsyncThunk(
  'walletconnect/init',
  async (_, { dispatch }) => {
    if (walletKitSingleton) {
      return initializeWalletConnect(dispatch as AppDispatch);
    }

    if (!walletKitInitPromise) {
      walletKitInitPromise = initializeWalletConnect(dispatch as AppDispatch).finally(() => {
        walletKitInitPromise = null;
      });
    }

    return walletKitInitPromise;
  }
);

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
      await walletKit.respondSessionRequest({ topic, response });
    }
  }
);

const walletconnectSlice = createSlice({
  name: 'walletconnect',
  initialState,
  reducers: {
    setPendingProposal: (
      state,
      action: PayloadAction<PendingProposalPayload>
    ) => {
      state.pendingProposal = action.payload;
    },
    clearPendingProposal: (state) => {
      state.pendingProposal = null;
    },
    setPendingSignMsg: (
      state,
      action: PayloadAction<PendingSignMsgPayload>
    ) => {
      state.pendingSignMsg = action.payload;
    },
    clearPendingSignMsg: (state) => {
      state.pendingSignMsg = null;
    },
    setPendingSignTx: (
      state,
      action: PayloadAction<PendingSignTxPayload>
    ) => {
      state.pendingSignTx = action.payload;
    },
    clearPendingSignTx: (state) => {
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
    builder.addCase(initWalletConnect.fulfilled, (state, action) => {
      state.web3wallet = action.payload.web3wallet;
      state.activeSessions = action.payload.activeSessions;
    });
    builder.addCase(initWalletConnect.rejected, (_, action) => {
      logError('walletconnect.init.rejected', action.error);
    });

    builder.addCase(approveSessionProposal.fulfilled, (state) => {
      state.pendingProposal = null;
      if (state.web3wallet) {
        state.activeSessions = state.web3wallet.getActiveSessions();
      }
    });

    builder.addCase(approveSessionProposal.rejected, (_, action) => {
      logError('walletconnect.approveSessionProposal.rejected', action.error);
    });

    builder.addCase(rejectSessionProposal.fulfilled, (state) => {
      state.pendingProposal = null;
      if (state.web3wallet) {
        state.activeSessions = state.web3wallet.getActiveSessions();
      }
    });
    builder.addCase(rejectSessionProposal.rejected, (_, action) => {
      logError('walletconnect.rejectSessionProposal.rejected', action.error);
    });

    builder.addCase(handleWcRequest.rejected, (_, action) => {
      logError('walletconnect.handleWcRequest.rejected', action.error);
    });

    builder.addCase(wcPair.rejected, (_, action) => {
      logError('walletconnect.wcPair.rejected', action.error);
    });

    builder.addCase(disconnectSession.fulfilled, (state, action) => {
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

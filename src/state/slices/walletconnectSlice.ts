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
import { enqueueNotification } from './notificationsSlice';
import {
  approveSessionProposal,
  checkAndDisconnectExpiredSessions,
  disconnectSession,
  rejectSessionProposal,
  respondWithMessageError,
  respondWithMessageSignature,
  respondWithTxError,
  respondWithTxSignature,
  syncWalletConnectSessions,
  wcPair,
} from '../../redux/walletconnect/thunks';
import { registerWalletConnectListeners } from '../../redux/walletconnect/helpers';
import { logError } from '../../utils/errorHandling';
import {
  getWalletConnectMetadataUrl,
  getWalletConnectProjectId,
} from '../../utils/walletconnectConfig';

let walletKitSingleton: IWalletKit | null = null;
let walletKitInitPromise: Promise<{
  web3wallet: IWalletKit;
  activeSessions: ActiveSessionsPayload;
}> | null = null;
let walletKitListenersRegistered = false;

const walletConnectBootstrap =
  (globalThis as typeof globalThis & {
    __optnWalletConnectBootstrap?: {
      walletKitSingleton: IWalletKit | null;
      walletKitInitPromise: Promise<{
        web3wallet: IWalletKit;
        activeSessions: ActiveSessionsPayload;
      }> | null;
      walletKitListenersRegistered: boolean;
    };
  }).__optnWalletConnectBootstrap ??= {
    walletKitSingleton,
    walletKitInitPromise,
    walletKitListenersRegistered,
  };

walletKitSingleton = walletConnectBootstrap.walletKitSingleton;
walletKitInitPromise = walletConnectBootstrap.walletKitInitPromise;
walletKitListenersRegistered = walletConnectBootstrap.walletKitListenersRegistered;

async function initializeWalletConnect(
  dispatch: AppDispatch,
  getState: () => RootState
) {
  if (!walletKitSingleton) {
    const projectId = getWalletConnectProjectId();
    const core = new Core({
      projectId,
      relayUrl: 'wss://relay.walletconnect.com',
      telemetryEnabled: false,
    });
    const metadata = {
      name: 'OPTN Wallet',
      description: 'OPTN WalletConnect Integration',
      url: getWalletConnectMetadataUrl(),
      icons: ['https://optnlabs.com/logo.png'],
    };

    walletKitSingleton = await WalletKit.init({ core, metadata });
    walletConnectBootstrap.walletKitSingleton = walletKitSingleton;
  }

  if (!walletKitListenersRegistered) {
    registerWalletConnectListeners(walletKitSingleton, {
      onProposal: (proposal) => {
        dispatch(setPendingProposal(proposal));
        dispatch(
          enqueueNotification({
            id: `walletconnect:proposal:${proposal.id}`,
            kind: 'walletconnect',
            title: 'WalletConnect session request',
            body: proposal.params.proposer.metadata?.name
              ? `Session request from ${proposal.params.proposer.metadata.name}.`
              : 'A dApp requested a WalletConnect session.',
            createdAt: Date.now(),
          })
        );
      },
      onProposalExpire: (proposalId) => {
        const pendingProposal = getState().walletconnect.pendingProposal;
        if (pendingProposal?.id !== proposalId) return;
        dispatch(clearPendingProposal());
        dispatch(
          enqueueNotification({
            id: `walletconnect:proposal:expired:${proposalId}`,
            kind: 'walletconnect',
            title: 'WalletConnect session request expired',
            body: 'The WalletConnect session request timed out before approval.',
            createdAt: Date.now(),
          })
        );
      },
      onSessionUpdate: () =>
        dispatch(setActiveSessions(walletKitSingleton!.getActiveSessions())),
      onSessionDelete: (topic) => {
        const session = walletKitSingleton!.getActiveSessions()[topic];
        dispatch(setActiveSessions(walletKitSingleton!.getActiveSessions()));
        dispatch(clearPendingSignMsgForTopic(topic));
        dispatch(clearPendingSignTxForTopic(topic));
        dispatch(
          enqueueNotification({
            id: `walletconnect:session:deleted:${topic}`,
            kind: 'walletconnect',
            title: 'WalletConnect session disconnected',
            body: session?.peer?.metadata?.name
              ? `Disconnected from ${session.peer.metadata.name}.`
              : 'A WalletConnect session was disconnected remotely.',
            createdAt: Date.now(),
          })
        );
      },
      onSessionRequestExpire: (requestId) => {
        const state = getState();
        const pendingMsg = state.walletconnect.pendingSignMsg;
        const pendingTx = state.walletconnect.pendingSignTx;
        const expiredMsg = pendingMsg?.id === requestId;
        const expiredTx = pendingTx?.id === requestId;
        if (!expiredMsg && !expiredTx) return;

        if (expiredMsg) {
          dispatch(clearPendingSignMsg());
        }
        if (expiredTx) {
          dispatch(clearPendingSignTx());
        }
        dispatch(
          enqueueNotification({
            id: `walletconnect:request:expired:${requestId}`,
            kind: 'walletconnect',
            title: 'WalletConnect request expired',
            body: 'The dApp request expired before it could be completed.',
            createdAt: Date.now(),
          })
        );
      },
      onSessionRequest: (sessionEvent) =>
        dispatch(handleWcRequest(sessionEvent)),
    });
    walletKitListenersRegistered = true;
    walletConnectBootstrap.walletKitListenersRegistered = true;
  }

  return {
    web3wallet: walletKitSingleton,
    activeSessions: walletKitSingleton.getActiveSessions(),
  };
}

export const initWalletConnect = createAsyncThunk(
  'walletconnect/init',
  async (_, { dispatch, getState }) => {
    if (walletKitSingleton) {
      return initializeWalletConnect(
        dispatch as AppDispatch,
        getState as () => RootState
      );
    }

    if (!walletKitInitPromise) {
      walletKitInitPromise = initializeWalletConnect(
        dispatch as AppDispatch,
        getState as () => RootState
      ).finally(() => {
        walletKitInitPromise = null;
        walletConnectBootstrap.walletKitInitPromise = null;
      });
      walletConnectBootstrap.walletKitInitPromise = walletKitInitPromise;
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
    clearPendingSignRequestsForRequestId: (
      state,
      action: PayloadAction<number>
    ) => {
      if (state.pendingSignMsg?.id === action.payload) {
        state.pendingSignMsg = null;
      }
      if (state.pendingSignTx?.id === action.payload) {
        state.pendingSignTx = null;
      }
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
    clearPendingSignMsgForTopic: (state, action: PayloadAction<string>) => {
      if (state.pendingSignMsg?.topic === action.payload) {
        state.pendingSignMsg = null;
      }
    },
    clearPendingSignTxForTopic: (state, action: PayloadAction<string>) => {
      if (state.pendingSignTx?.topic === action.payload) {
        state.pendingSignTx = null;
      }
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

    builder.addCase(syncWalletConnectSessions.fulfilled, (state, action) => {
      state.activeSessions = action.payload;
    });
    builder.addCase(syncWalletConnectSessions.rejected, (_, action) => {
      logError('walletconnect.syncWalletConnectSessions.rejected', action.error);
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
  clearPendingSignRequestsForRequestId,
  setPendingSignMsg,
  clearPendingSignMsg,
  setPendingSignTx,
  clearPendingSignTx,
  clearPendingSignMsgForTopic,
  clearPendingSignTxForTopic,
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
  syncWalletConnectSessions,
  checkAndDisconnectExpiredSessions,
};
export default walletconnectSlice.reducer;

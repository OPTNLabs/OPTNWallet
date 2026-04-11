import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { WalletConnectionManager, type PendingSignRequest } from '@wizardconnect/wallet';
import type { AppDispatch, RootState } from './store';
import { logError } from '../utils/errorHandling';
import { OptnWizardWalletAdapter } from '../services/wizardconnect/OptnWizardWalletAdapter';
import {
  disconnectAllWizardConnections,
  disconnectWizardConnection,
  wizardConnectPair,
} from './wizardconnect/thunks';
import { initialState, type ActiveWizardConnections } from './wizardconnect/types';

let wizardManagerSingleton: WalletConnectionManager | null = null;
let wizardAdapterSingleton: OptnWizardWalletAdapter | null = null;
let wizardInitPromise: Promise<{
  manager: WalletConnectionManager;
  activeConnections: ActiveWizardConnections;
  walletId: number;
}> | null = null;
let wizardListenersBoundWalletId: number | null = null;

function registerWizardListeners(manager: WalletConnectionManager, dispatch: AppDispatch) {
  manager.on('connectionsChanged', () => {
    dispatch(setActiveConnections(manager.getConnections()));
  });

  manager.on('connectionStatusChanged', () => {
    dispatch(setActiveConnections(manager.getConnections()));
  });

  manager.on('pendingSignRequest', (request) => {
    dispatch(setPendingSignRequest(request));
    dispatch(setActiveConnections(manager.getConnections()));
  });

  manager.on('remoteDisconnect', (connectionId) => {
    dispatch(clearPendingSignRequestForConnection(connectionId));
    dispatch(setActiveConnections(manager.getConnections()));
  });

  manager.on('signCancelled', (connectionId, sequence) => {
    dispatch(clearPendingSignRequestBySequence({ connectionId, sequence }));
  });
}

async function initializeWizardConnect(walletId: number, dispatch: AppDispatch) {
  if (wizardManagerSingleton && wizardListenersBoundWalletId === walletId) {
    return {
      manager: wizardManagerSingleton,
      activeConnections: wizardManagerSingleton.getConnections(),
      walletId,
    };
  }

  if (wizardManagerSingleton) {
    wizardManagerSingleton.disconnectAll();
  }

  wizardAdapterSingleton = await OptnWizardWalletAdapter.create(walletId);
  wizardManagerSingleton = new WalletConnectionManager(wizardAdapterSingleton);
  wizardListenersBoundWalletId = walletId;
  registerWizardListeners(wizardManagerSingleton, dispatch);

  return {
    manager: wizardManagerSingleton,
    activeConnections: wizardManagerSingleton.getConnections(),
    walletId,
  };
}

export const initWizardConnect = createAsyncThunk(
  'wizardconnect/init',
  async (walletId: number, { dispatch }) => {
    if (!wizardInitPromise) {
      wizardInitPromise = initializeWizardConnect(walletId, dispatch as AppDispatch).finally(() => {
        wizardInitPromise = null;
      });
    }
    return wizardInitPromise;
  }
);

export const respondToWizardConnectSignRequest = createAsyncThunk(
  'wizardconnect/respondToSignRequest',
  async (
    args: { connectionId: string; sequence: number; approve: boolean },
    { getState }
  ) => {
    const state = getState() as RootState;
    const manager = state.wizardconnect.manager;
    const pending = state.wizardconnect.pendingSignRequest;
    if (!manager || !wizardAdapterSingleton || !pending) {
      throw new Error('WizardConnect signing state is unavailable');
    }

    if (
      pending.connectionId !== args.connectionId ||
      pending.request.sequence !== args.sequence
    ) {
      throw new Error('WizardConnect signing request changed before response');
    }

    if (!args.approve) {
      await manager.sendSignError(
        args.connectionId,
        args.sequence,
        'User rejected transaction signing'
      );
      return { approved: false, connections: manager.getConnections() };
    }

    const result = await wizardAdapterSingleton.signTransaction(pending.request);
    await manager.sendSignResponse(
      args.connectionId,
      args.sequence,
      result.signedTransaction
    );
    return { approved: true, connections: manager.getConnections() };
  }
);

export const approveWizardSignRequest = createAsyncThunk(
  'wizardconnect/approveSignRequest',
  async (_, { dispatch, getState }) => {
    const state = getState() as RootState;
    const pending = state.wizardconnect.pendingSignRequest;
    if (!pending) throw new Error('No WizardConnect signing request pending');
    await dispatch(
      respondToWizardConnectSignRequest({
        connectionId: pending.connectionId,
        sequence: pending.request.sequence,
        approve: true,
      })
    ).unwrap();
    return true;
  }
);

export const rejectWizardSignRequest = createAsyncThunk(
  'wizardconnect/rejectSignRequest',
  async (_, { dispatch, getState }) => {
    const state = getState() as RootState;
    const pending = state.wizardconnect.pendingSignRequest;
    if (!pending) throw new Error('No WizardConnect signing request pending');
    await dispatch(
      respondToWizardConnectSignRequest({
        connectionId: pending.connectionId,
        sequence: pending.request.sequence,
        approve: false,
      })
    ).unwrap();
    return true;
  }
);

const wizardconnectSlice = createSlice({
  name: 'wizardconnect',
  initialState,
  reducers: {
    setActiveConnections: (
      state,
      action: PayloadAction<ActiveWizardConnections>
    ) => {
      state.activeConnections = action.payload;
    },
    setPendingSignRequest: (
      state,
      action: PayloadAction<PendingSignRequest>
    ) => {
      state.pendingSignRequest = action.payload as typeof state.pendingSignRequest;
    },
    clearPendingSignRequest: (state) => {
      state.pendingSignRequest = null;
    },
    clearPendingSignRequestForConnection: (
      state,
      action: PayloadAction<string>
    ) => {
      if (state.pendingSignRequest?.connectionId === action.payload) {
        state.pendingSignRequest = null;
      }
    },
    clearPendingSignRequestBySequence: (
      state,
      action: PayloadAction<{ connectionId: string; sequence: number }>
    ) => {
      const pending = state.pendingSignRequest;
      if (
        pending?.connectionId === action.payload.connectionId &&
        pending.request.sequence === action.payload.sequence
      ) {
        state.pendingSignRequest = null;
      }
    },
  },
  extraReducers: (builder) => {
    builder.addCase(initWizardConnect.fulfilled, (state, action) => {
      state.manager = action.payload.manager;
      state.activeConnections = action.payload.activeConnections;
      state.initializedWalletId = action.payload.walletId;
    });
    builder.addCase(initWizardConnect.rejected, (_, action) => {
      logError('wizardconnect.init.rejected', action.error);
    });

    builder.addCase(wizardConnectPair.fulfilled, (state, action) => {
      state.activeConnections = action.payload.connections;
    });
    builder.addCase(wizardConnectPair.rejected, (_, action) => {
      logError('wizardconnect.pair.rejected', action.error);
    });

    builder.addCase(disconnectWizardConnection.fulfilled, (state, action) => {
      state.activeConnections = action.payload;
    });
    builder.addCase(disconnectWizardConnection.rejected, (_, action) => {
      logError('wizardconnect.disconnect.rejected', action.error);
    });

    builder.addCase(disconnectAllWizardConnections.fulfilled, (state, action) => {
      state.activeConnections = action.payload;
      state.pendingSignRequest = null;
    });
    builder.addCase(disconnectAllWizardConnections.rejected, (_, action) => {
      logError('wizardconnect.disconnectAll.rejected', action.error);
    });

    builder
      .addCase(respondToWizardConnectSignRequest.fulfilled, (state, action) => {
        state.pendingSignRequest = null;
        state.activeConnections = action.payload.connections;
      })
      .addCase(respondToWizardConnectSignRequest.rejected, (_, action) => {
        logError('wizardconnect.respond.rejected', action.error);
      });

    builder
      .addCase(approveWizardSignRequest.rejected, (_, action) => {
        logError('wizardconnect.approve.rejected', action.error);
      })
      .addCase(rejectWizardSignRequest.rejected, (_, action) => {
        logError('wizardconnect.reject.rejected', action.error);
      });
  },
});

export const {
  clearPendingSignRequest,
  clearPendingSignRequestBySequence,
  clearPendingSignRequestForConnection,
  setActiveConnections,
  setPendingSignRequest,
} = wizardconnectSlice.actions;

export {
  disconnectAllWizardConnections,
  disconnectWizardConnection,
  wizardConnectPair,
};

export default wizardconnectSlice.reducer;

import {
  createAsyncThunk,
  createSlice,
  type PayloadAction,
} from '@reduxjs/toolkit';
import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
  SessionProposalResponse,
} from '@cashconnect-js/nostr';
import type { WalletSession } from '@cashconnect-js/nostr/wallet';
import {
  approveCashConnectAction,
  approveCashConnectProposal,
  bindCashConnectUi,
  disconnectCashConnectSession,
  pairCashConnect,
  rejectCashConnectAction,
  rejectCashConnectProposal,
  startCashConnect,
  stopCashConnect,
} from '../../services/cashconnect/CashConnectService';

type ActionPrompt = {
  session: WalletSession;
  request: ExecuteActionRequest;
  response: ExecuteActionResponse;
};

type CashConnectState = {
  sessions: Record<string, WalletSession>;
  pendingProposal: SessionProposalResponse | null;
  pendingAction: ActionPrompt | null;
  errorMessage: string | null;
  initializationRequestId: string | null;
  pairingRequestId: string | null;
};

const initialState: CashConnectState = {
  sessions: {},
  pendingProposal: null,
  pendingAction: null,
  errorMessage: null,
  initializationRequestId: null,
  pairingRequestId: null,
};

export const initCashConnect = createAsyncThunk(
  'cashconnect/init',
  async (walletId: number, { dispatch }) => {
    bindCashConnectUi({
      onSessions: (sessions) => dispatch(setCashConnectSessions(sessions)),
      onProposal: (proposal) => dispatch(setCashConnectProposal(proposal)),
      onAction: (payload) => dispatch(setCashConnectAction(payload)),
      onClearProposal: () => dispatch(setCashConnectProposal(null)),
      onClearAction: () => dispatch(setCashConnectAction(null)),
      onError: (message) => dispatch(setCashConnectError(message)),
    });
    await startCashConnect(walletId);
  }
);

export const stopCashConnectThunk = createAsyncThunk(
  'cashconnect/stop',
  async () => {
    await stopCashConnect();
  }
);

export const pairCashConnectThunk = createAsyncThunk(
  'cashconnect/pair',
  async (uri: string) => {
    await pairCashConnect(uri);
  }
);

export const disconnectCashConnectThunk = createAsyncThunk(
  'cashconnect/disconnect',
  async (dappPubkey: string) => {
    await disconnectCashConnectSession(dappPubkey);
  }
);

const cashconnectSlice = createSlice({
  name: 'cashconnect',
  initialState,
  reducers: {
    setCashConnectSessions(
      state,
      action: PayloadAction<Record<string, WalletSession>>
    ) {
      state.sessions = action.payload as never;
    },
    setCashConnectProposal(
      state,
      action: PayloadAction<SessionProposalResponse | null>
    ) {
      state.pendingProposal = action.payload as never;
      if (action.payload) state.errorMessage = null;
    },
    setCashConnectAction(state, action: PayloadAction<ActionPrompt | null>) {
      state.pendingAction = action.payload as never;
    },
    setCashConnectError(state, action: PayloadAction<string | null>) {
      state.errorMessage = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(initCashConnect.pending, (state, action) => {
      state.errorMessage = null;
      state.initializationRequestId = action.meta.requestId;
    });
    builder.addCase(pairCashConnectThunk.pending, (state, action) => {
      state.errorMessage = null;
      state.pairingRequestId = action.meta.requestId;
    });
    builder.addCase(initCashConnect.rejected, (state, action) => {
      if (state.initializationRequestId !== action.meta.requestId) return;
      state.initializationRequestId = null;
      state.errorMessage = 'Connection attempt failed';
    });
    builder.addCase(pairCashConnectThunk.rejected, (state, action) => {
      if (state.pairingRequestId !== action.meta.requestId) return;
      state.pairingRequestId = null;
      state.errorMessage = 'Connection attempt failed';
    });
    builder.addCase(stopCashConnectThunk.pending, () => initialState);
  },
});

export const {
  setCashConnectSessions,
  setCashConnectProposal,
  setCashConnectAction,
  setCashConnectError,
} = cashconnectSlice.actions;

export const approveCashConnectProposalAction = createAsyncThunk(
  'cashconnect/approveProposal',
  async (_, { dispatch }) => {
    approveCashConnectProposal();
    dispatch(setCashConnectProposal(null));
  }
);

export const rejectCashConnectProposalAction = createAsyncThunk(
  'cashconnect/rejectProposal',
  async (_, { dispatch }) => {
    rejectCashConnectProposal();
    dispatch(setCashConnectProposal(null));
  }
);

export const approveCashConnectActionAction = createAsyncThunk(
  'cashconnect/approveAction',
  async (_, { dispatch }) => {
    approveCashConnectAction();
    dispatch(setCashConnectAction(null));
  }
);

export const rejectCashConnectActionAction = createAsyncThunk(
  'cashconnect/rejectAction',
  async (_, { dispatch }) => {
    rejectCashConnectAction();
    dispatch(setCashConnectAction(null));
  }
);

export default cashconnectSlice.reducer;

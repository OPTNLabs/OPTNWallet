import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type UtxoNotification = {
  id: string;
  kind: 'utxo';
  address: string;
  value: number;
  txid: string;
  createdAt: number;
  height?: number;
};

export type WalletConnectNotification = {
  id: string;
  kind: 'walletconnect';
  title: string;
  body: string;
  createdAt: number;
};

export type AppNotification = UtxoNotification | WalletConnectNotification;

type NotificationsState = {
  queue: AppNotification[];
};

const initialState: NotificationsState = {
  queue: [],
};

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    enqueueNotification: (state, action: PayloadAction<AppNotification>) => {
      const n = action.payload;
      if (state.queue.some((q) => q.id === n.id)) return;
      if (n.kind === 'utxo' && typeof n.height === 'number' && n.height > 0) {
        return;
      }
      state.queue.push(n);
      if (state.queue.length > 10) state.queue.shift();
    },
    dequeueNotification: (state, action: PayloadAction<{ id: string }>) => {
      state.queue = state.queue.filter((n) => n.id !== action.payload.id);
    },
    clearNotifications: (state) => {
      state.queue = [];
    },
  },
});

export const { enqueueNotification, dequeueNotification, clearNotifications } =
  notificationsSlice.actions;

export default notificationsSlice.reducer;

// src/redux/notificationsSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type UtxoNotification = {
  id: string;
  kind: 'utxo';
  address: string;
  value: number; // sats
  txid: string;
  createdAt: number;
};

type NotificationsState = {
  queue: UtxoNotification[];
};

const initialState: NotificationsState = {
  queue: [],
};

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    enqueueNotification: (state, action: PayloadAction<UtxoNotification>) => {
      state.queue.push(action.payload);
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

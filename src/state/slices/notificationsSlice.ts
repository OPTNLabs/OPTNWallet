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
      const n = action.payload;
      if (typeof n.height === 'number' && n.height > 0) return;
      if (state.queue.some((q) => q.id === n.id)) return;
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

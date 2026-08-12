// src/redux/notificationsSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type UtxoNotification = {
  /** Use a deterministic key: `${txid}:${vout}` */
  id: string;
  kind: 'utxo';
  address: string;
  value: number; // sats
  txid: string;
  createdAt: number;
  /** Electrum height: -1/0 => unconfirmed, >0 => confirmed */
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

      // 🔒 Only allow unconfirmed items into the queue
      if (typeof n.height === 'number' && n.height > 0) return;

      // 🔁 De-dupe by deterministic id (txid:vout)
      if (state.queue.some((q) => q.id === n.id)) return;

      state.queue.push(n);
      if (state.queue.length > 10) state.queue.shift(); // cap
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

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type ServerNotification = {
  id: string;
  kind: 'incoming_bch' | 'incoming_token' | 'transaction_confirmed';
  txid: string;
  address: string | null;
  tokenCategory: string | null;
  blockHeight: number | null;
  createdAt: number;
};

type ServerNotificationsState = {
  queue: ServerNotification[];
};

const initialState: ServerNotificationsState = {
  queue: [],
};

const serverNotificationsSlice = createSlice({
  name: 'serverNotifications',
  initialState,
  reducers: {
    enqueueServerNotification: (state, action: PayloadAction<ServerNotification>) => {
      const notification = action.payload;
      if (state.queue.some((item) => item.id === notification.id)) return;
      state.queue.unshift(notification);
      if (state.queue.length > 10) state.queue.length = 10;
    },
    dequeueServerNotification: (state, action: PayloadAction<{ id: string }>) => {
      state.queue = state.queue.filter((item) => item.id !== action.payload.id);
    },
    clearServerNotifications: (state) => {
      state.queue = [];
    },
  },
});

export const {
  enqueueServerNotification,
  dequeueServerNotification,
  clearServerNotifications,
} = serverNotificationsSlice.actions;

export default serverNotificationsSlice.reducer;

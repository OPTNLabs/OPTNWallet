import { configureStore } from '@reduxjs/toolkit';
import walletReducer from './walletSlice';

const store = configureStore({
  reducer: {
    wallet_id: walletReducer,
  },
});

store.subscribe(() => console.log('Redux state updated:', store.getState()));

export type RootState = ReturnType<typeof store.getState>;

export type AppDispatch = typeof store.dispatch;

export { store };

// src/redux/store.ts

import { combineReducers, configureStore } from '@reduxjs/toolkit';
import transactionBuilderReducer from './transactionBuilderSlice';
import contractReducer from './contractSlice';
import networkReducer from './networkSlice';
import walletReducer from './walletSlice';
import utxoReducer from './utxoSlice';
import transactionReducer from './transactionSlice';
import priceFeedReducer from './priceFeedSlice';
import walletconnectReducer from './walletconnectSlice';
import { persistStore, persistReducer } from 'redux-persist';
// import storage from 'redux-persist/lib/storage'; // defaults to localStorage for web
import localForage from 'localforage'; // ✅ IndexedDB

localForage.config({ name: 'optn-wallet', storeName: 'persist' });

const persistConfig = {
  key: 'root',
  storage: localForage,
  whitelist: [
    'contract',
    'network',
    'transactionBuilder',
    // 'transations',
    // 'utxos',
    'wallet_id',
    // 'walletconnect'
  ],
  version: 2,
  migrate: async (state: any) => {
    if (!state) return state;
    // Ensure large slices aren't accidentally retained
    delete state.utxos;
    delete state.transactions;
    return state;
  },
};

const rootReducer = combineReducers({
  wallet_id: walletReducer,
  utxos: utxoReducer,
  transactions: transactionReducer,
  contract: contractReducer,
  network: networkReducer,
  transactionBuilder: transactionBuilderReducer,
  priceFeed: priceFeedReducer,
  walletconnect: walletconnectReducer,
});

const persistedReducer = persistReducer(persistConfig, rootReducer);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false, // Disable for redux-persist
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

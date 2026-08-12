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
import wizardconnectReducer from './wizardconnectSlice';
import preferencesReducer from './preferencesSlice';
import { persistStore, persistReducer } from 'redux-persist';
import type { PersistMigrate, PersistedState } from 'redux-persist/es/types';

import notificationsReducer from './notificationsSlice';
import serverNotificationsReducer from './serverNotificationsSlice';

// import storage from 'redux-persist/lib/storage'; 
// defaults to localStorage for web
import localForage from 'localforage'; // ✅ IndexedDB

type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<string>;
  removeItem: (key: string) => Promise<void>;
};

function createMemoryStorage(): AsyncStorageLike {
  const data = new Map<string, string>();
  return {
    async getItem(key) {
      return data.has(key) ? data.get(key)! : null;
    },
    async setItem(key, value) {
      data.set(key, value);
      return value;
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
}

function isTestEnvironment(): boolean {
  try {
    if (typeof process !== 'undefined') {
      if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
        return true;
      }
    }
  } catch {
    // ignore
  }

  return (
    typeof globalThis !== 'undefined' &&
    '__vitest_worker__' in (globalThis as Record<string, unknown>)
  );
}

const persistStorage: AsyncStorageLike = isTestEnvironment()
  ? createMemoryStorage()
  : (() => {
      localForage.config({ name: 'optn-wallet', storeName: 'persist' });
      return localForage;
    })();

const persistConfig = {
  key: 'root',
  storage: persistStorage,
  whitelist: [
    'contract',
    'network',
    'transactionBuilder',
    'preferences',
    // 'transations',
    // 'utxos',
    'wallet_id',
    // 'walletconnect'
  ],
  version: 2,
  migrate: (async (state: PersistedState) => {
    if (!state) return state;
    // Ensure large slices aren't accidentally retained
    const sanitizedState: PersistedState & { [key: string]: unknown } = {
      ...state,
    };
    delete sanitizedState.utxos;
    delete sanitizedState.transactions;
    return sanitizedState;
  }) as PersistMigrate,
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
  wizardconnect: wizardconnectReducer,
  notifications: notificationsReducer,
  serverNotifications: serverNotificationsReducer,
  preferences: preferencesReducer,
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

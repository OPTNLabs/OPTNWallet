import { combineReducers, configureStore } from '@reduxjs/toolkit';
import { persistReducer, persistStore } from 'redux-persist';
import type { PersistMigrate, PersistedState } from 'redux-persist/es/types';
import localForage from 'localforage';

import transactionBuilderReducer from '../state/slices/transactionBuilderSlice';
import contractReducer from '../state/slices/contractSlice';
import networkReducer from '../state/slices/networkSlice';
import walletReducer from '../state/slices/walletSlice';
import utxoReducer from '../state/slices/utxoSlice';
import transactionReducer from '../state/slices/transactionSlice';
import priceFeedReducer from '../state/slices/priceFeedSlice';
import walletconnectReducer from '../state/slices/walletconnectSlice';
import wizardconnectReducer from '../state/slices/wizardconnectSlice';
import preferencesReducer from '../state/slices/preferencesSlice';
import notificationsReducer from '../state/slices/notificationsSlice';
import serverNotificationsReducer from '../state/slices/serverNotificationsSlice';

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
  whitelist: ['contract', 'network', 'transactionBuilder', 'preferences', 'wallet_id'],
  version: 2,
  migrate: (async (state: PersistedState) => {
    if (!state) return state;
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
      serializableCheck: false,
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

import { configureStore, combineReducers } from '@reduxjs/toolkit';
import {
  persistStore,
  persistReducer,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
} from 'redux-persist';
import storage from 'redux-persist/lib/storage'; // defaults to localStorage for web
import walletReducer from './walletSlice';
import utxoReducer from './utxoSlice';
import transactionReducer from './transactionSlice';
import contractReducer from './contractSlice';
import networkReducer from './networkSlice'; // Import the new slice

const rootReducer = combineReducers({
  wallet_id: walletReducer,
  utxos: utxoReducer,
  transactions: transactionReducer,
  contract: contractReducer,
  network: networkReducer, // Add the new slice to the root reducer
});

const persistConfig = {
  key: 'root',
  storage,
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

const persistor = persistStore(store);

store.subscribe(() => console.log('Redux state updated:', store.getState()));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export { store, persistor };

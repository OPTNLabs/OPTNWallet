// src/redux/store.ts
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
import storage from 'redux-persist/lib/storage';
import walletReducer from './walletSlice';
import utxoReducer from './utxoSlice';
import transactionReducer from './transactionSlice';
import contractReducer from './contractSlice';
import networkReducer from './networkSlice';
import transactionBuilderReducer from './transactionBuilderSlice';
import priceFeedReducer from './priceFeedSlice'; // Import the price feed reducer

// Combine all reducers
const rootReducer = combineReducers({
  wallet_id: walletReducer,
  utxos: utxoReducer,
  transactions: transactionReducer,
  contract: contractReducer,
  network: networkReducer,
  transactionBuilder: transactionBuilderReducer,
  priceFeed: priceFeedReducer, // Add the price feed reducer
});

// Configure persistence for the Redux store
const persistConfig = {
  key: 'root',
  storage,
};

// Create persisted reducer
const persistedReducer = persistReducer(persistConfig, rootReducer);

// Configure the Redux store
const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      immutableCheck: false,
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

// Create persistor
const persistor = persistStore(store);

// Define types for state and dispatch
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Export store and persistor
export { store, persistor };

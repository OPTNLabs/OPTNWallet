// src/redux/store.ts

import { combineReducers, configureStore } from '@reduxjs/toolkit';
import transactionBuilderReducer from './transactionBuilderSlice';
import contractReducer from './contractSlice';
import networkReducer from './networkSlice';
import { persistStore, persistReducer } from 'redux-persist';
import storage from 'redux-persist/lib/storage'; // defaults to localStorage for web

const persistConfig = {
  key: 'root',
  storage,
  whitelist: ['transactionBuilder', 'contract', 'network'], // Add other slices here
};

const rootReducer = combineReducers({
  transactionBuilder: transactionBuilderReducer,
  contract: contractReducer,
  network: networkReducer,
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

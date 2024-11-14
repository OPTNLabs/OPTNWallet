// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { BrowserRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { store, persistor } from './redux/store';
import { updatePrices } from './redux/priceFeedSlice';
import startUTXOWorker from './workers/UTXOWorkerService';
import startTransactionWorker from './workers/TransactionWorkerService.ts';

// Initialize the worker directly
const priceFeedWorker = new Worker(
  new URL('./workers/priceFeedWorker.ts', import.meta.url),
  { type: 'module' } // Ensure worker uses module type
);

// Listen to messages from the worker
priceFeedWorker.onmessage = (event) => {
  const { type, data } = event.data;
  if (type === 'PRICE_UPDATE') {
    store.dispatch(updatePrices(data));
  } else if (type === 'PRICE_ERROR') {
    console.error('Price feed worker error:', data);
  }
};

// Start the UTXO worker service
startUTXOWorker();

// Start the TX History worker service
startTransactionWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </PersistGate>
    </Provider>
  </React.StrictMode>
);

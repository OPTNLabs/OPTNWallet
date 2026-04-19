// src/main.tsx
import './polyfills/node-globals';
// IMPORTANT: don't import 'dotenv/config' in the browser bundle.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App.tsx';
import './index.css';
import 'react-tooltip/dist/react-tooltip.css';
import { installProductionConsoleGuards } from './utils/productionConsole';
import { installBarcodeScannerUnhandledRejectionGuard } from './utils/barcodeScanner';
import { HashRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { store, persistor } from './redux/store';
import { ThemeProvider } from './context/ThemeContext';

installProductionConsoleGuards();
installBarcodeScannerUnhandledRejectionGuard();

if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('native-contained');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <ThemeProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ThemeProvider>
      </PersistGate>
    </Provider>
  </React.StrictMode>
);

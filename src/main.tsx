// src/main.tsx
import './polyfills/node-globals';
// IMPORTANT: don't import 'dotenv/config' in the browser bundle.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './app/AppShell';
import './index.css';
import 'react-tooltip/dist/react-tooltip.css';
import { installProductionConsoleGuards } from './utils/productionConsole';
import { installBarcodeScannerUnhandledRejectionGuard } from './utils/barcodeScanner';
import { HashRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { store } from './state/store';
import { ThemeProvider } from './app/theme/ThemeContext';
import { WalletConfirmProvider } from './components/WalletConfirmDialog';
import { I18nProvider } from './i18n/I18nProvider';

installProductionConsoleGuards();
installBarcodeScannerUnhandledRejectionGuard();

if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('native-contained');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <I18nProvider>
        <ThemeProvider>
          <HashRouter>
            <WalletConfirmProvider>
              <App />
            </WalletConfirmProvider>
          </HashRouter>
        </ThemeProvider>
      </I18nProvider>
    </Provider>
  </React.StrictMode>
);

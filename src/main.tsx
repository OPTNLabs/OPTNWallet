// src/main.tsx
import './polyfills/node-globals';
// IMPORTANT: don't import 'dotenv/config' in the browser bundle.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
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
import { ensureOptnCoreAsync } from './wasm/optn-core';
import { prepareTinySecp256k1Wasm } from './platform/web/tinySecp256k1Wasm';
import { showStartupStatus } from './platform/web/startupStatus';

installProductionConsoleGuards();
installBarcodeScannerUnhandledRejectionGuard();

if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('native-contained');
}

function renderApp(App: React.ComponentType) {
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

  if (Capacitor.isNativePlatform()) {
    requestAnimationFrame(() => {
      void SplashScreen.hide({ fadeOutDuration: 150 }).catch((error) => {
        console.warn('Native splash screen hide failed:', error);
      });
    });
  }
}

async function startApp() {
  const startupStatus = showStartupStatus();
  startupStatus.setMessage('Preparing wallet…');

  // These two WASM gates are independent. Starting them together removes the
  // serial compile penalty while keeping both ready before crypto consumers
  // enter the AppShell module graph.
  const coreInitialization = ensureOptnCoreAsync().catch((error) => {
    console.error('Shared wallet core initialization failed:', error);
  });
  startupStatus.setMessage('Loading security module…');
  const securityInitialization = prepareTinySecp256k1Wasm();
  await Promise.all([coreInitialization, securityInitialization]);

  // Keep crypto consumers out of the initial module graph. Native WebViews
  // need the async WASM compile above to finish before this synchronous API is
  // evaluated.
  startupStatus.setMessage('Opening wallet…');
  const { default: App } = await import('./app/AppShell');
  renderApp(App);
}

void startApp().catch((error: unknown) => {
  console.error('Wallet startup failed:', error);
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = '';
  const message = document.createElement('div');
  message.setAttribute('role', 'alert');
  message.setAttribute('aria-live', 'assertive');
  message.className = 'wallet-card m-4 p-4';
  message.textContent =
    'The wallet could not start. Check this device and try opening it again.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'wallet-btn-primary mt-3';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => window.location.reload());
  message.appendChild(retry);
  root.appendChild(message);
  if (Capacitor.isNativePlatform()) {
    void SplashScreen.hide({ fadeOutDuration: 150 }).catch(() => undefined);
  }
});

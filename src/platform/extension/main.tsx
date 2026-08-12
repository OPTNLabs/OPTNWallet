// Browser-extension popup entry point. Referenced directly by popup.html —
// a dedicated entry, not shared with src/main.tsx, so no module-swap plugin
// is needed to redirect it (unlike src/app/AppShell.tsx on desktop, which IS
// shared and swapped via vite.desktop.config.ts's resolveId plugin).
import '../../polyfills/node-globals';

import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../index.css';
import 'react-tooltip/dist/react-tooltip.css';
import { installProductionConsoleGuards } from '../../utils/productionConsole';
import { installBarcodeScannerUnhandledRejectionGuard } from '../../utils/barcodeScanner';
import { HashRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { store } from '../../state/store';
import { ThemeProvider } from '../../app/theme/ThemeContext';
import ExtensionAppShell from './ExtensionAppShell';

installProductionConsoleGuards();
installBarcodeScannerUnhandledRejectionGuard();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <ThemeProvider>
        <HashRouter>
          <ExtensionAppShell />
        </HashRouter>
      </ThemeProvider>
    </Provider>
  </React.StrictMode>
);

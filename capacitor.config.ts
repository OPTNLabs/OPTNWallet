import type { CapacitorConfig } from '@capacitor/cli';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

const config: CapacitorConfig = {
  appId: 'optn.wallet.app',
  appName: 'OPTN Wallet',
  webDir: 'dist',
  // bundledWebRuntime: false,
  plugins: {
    SplashScreen: {
      // Keep the branded splash in place until React is ready. Hiding it on a
      // fixed timer exposes a blank WebView while the WASM startup gates run.
      launchShowDuration: 0,
      launchAutoHide: false,
      backgroundColor: '#0d2a1fff',
      androidSplashResourceName: 'splash', // uses drawable named “splash”
      iosSplashResourceName: 'splash', // uses asset named “splash”
      showSpinner: false,
    },
    CapacitorHttp: {
      enabled: true,
    },
  },
  android: {
    buildOptions: {
      keystorePath: path.resolve(
        process.cwd(),
        process.env.KEYSTORE_PATH || ''
      ),
      keystorePassword: process.env.KEYSTORE_PASS,
      keystoreAlias: process.env.KEYSTORE_ALIAS,
      keystoreAliasPassword: process.env.KEYSTORE_ALIAS_PASS,
      releaseType: 'AAB',
    },
  },
};

export default config;

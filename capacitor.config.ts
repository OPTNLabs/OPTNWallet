import type { CapacitorConfig } from '@capacitor/cli';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

const config: CapacitorConfig = {
  appId: 'optn.wallet.app',
  appName: 'optn-wallet',
  webDir: 'dist',
  bundledWebRuntime: false,
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000, // time (ms) to show splash
      launchAutoHide: true, // auto‑hide after duration
      backgroundColor: '#ffffffff', // white background
      androidSplashResourceName: 'splash', // uses drawable named “splash”
      iosSplashResourceName: 'splash', // uses asset named “splash”
      showSpinner: false,
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

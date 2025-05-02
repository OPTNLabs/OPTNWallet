import type { CapacitorConfig } from '@capacitor/cli';

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
};

export default config;

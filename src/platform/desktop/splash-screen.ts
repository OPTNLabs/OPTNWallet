// Desktop shim for @capacitor/splash-screen — no-op (Tauri handles window show)

export const SplashScreen = {
  hide: async (options?: { fadeOutDuration?: number }) => {
    void options;
  },
  show: async (options?: {
    autoHide?: boolean;
    fadeInDuration?: number;
    fadeOutDuration?: number;
    showDuration?: number;
  }) => {
    void options;
  },
};

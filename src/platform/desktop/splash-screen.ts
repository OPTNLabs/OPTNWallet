// Desktop shim for @capacitor/splash-screen — no-op (Tauri handles window show)

export const SplashScreen = {
  hide: async (_options?: { fadeOutDuration?: number }) => {
    void _options;
  },
  show: async (_options?: { autoHide?: boolean; fadeInDuration?: number; fadeOutDuration?: number; showDuration?: number }) => {
    void _options;
  },
};

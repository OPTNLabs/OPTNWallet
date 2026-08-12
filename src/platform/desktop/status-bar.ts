// Desktop shim for @capacitor/status-bar — no-op (no status bar on desktop)

export const Style = {
  Default: 'DEFAULT',
  Dark: 'DARK',
  Light: 'LIGHT',
} as const;

export const Animation = {
  None: 'NONE',
  Slide: 'SLIDE',
  Fade: 'FADE',
} as const;

export const StatusBar = {
  setStyle: async () => {},
  setBackgroundColor: async () => {},
  show: async () => {},
  hide: async () => {},
  getInfo: async () => ({ visible: false, style: Style.Default, color: '#000000', overlays: false }),
  setOverlaysWebView: async () => {},
};

// Desktop shim for @capacitor/app. Deep links are a native-only path.

export const App = {
  async getLaunchUrl(): Promise<{ url: string } | undefined> {
    return undefined;
  },
  addListener(_event: string, _handler: (data: { url: string }) => void) {
    void _event;
    void _handler;
    return Promise.resolve({ remove: async () => {} });
  },
  async removeAllListeners() {},
};

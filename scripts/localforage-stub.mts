/** In-memory localforage so chat-cli does not need IndexedDB. */
function makeStore() {
  const store = new Map<string, unknown>();
  return {
    async getItem<T>(key: string): Promise<T | null> {
      return (store.has(key) ? (store.get(key) as T) : null) ?? null;
    },
    async setItem<T>(key: string, value: T): Promise<T> {
      store.set(key, value);
      return value;
    },
    async removeItem(key: string): Promise<void> {
      store.delete(key);
    },
    async clear(): Promise<void> {
      store.clear();
    },
    async keys(): Promise<string[]> {
      return [...store.keys()];
    },
  };
}

const api = {
  ...makeStore(),
  createInstance(_opts?: unknown) {
    void _opts;
    return makeStore();
  },
  config(_opts?: unknown) {
    void _opts;
  },
};

export default api;

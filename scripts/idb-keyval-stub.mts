/** In-memory idb-keyval so chat-cli does not need IndexedDB. */
const mem = new Map<IDBValidKey, unknown>();

export async function get<T = unknown>(
  key: IDBValidKey
): Promise<T | undefined> {
  return mem.get(key) as T | undefined;
}

export async function set<T = unknown>(key: IDBValidKey, value: T): Promise<T> {
  mem.set(key, value);
  return value;
}

export async function del(key: IDBValidKey): Promise<void> {
  mem.delete(key);
}

export async function keys(): Promise<IDBValidKey[]> {
  return [...mem.keys()];
}

export async function clear(): Promise<void> {
  mem.clear();
}

/**
 * Optional host-provided cross-context lock for read-modify-write storage.
 * Web Locks are used when available; test and older-platform adapters can
 * provide no lock and retain the in-process queue behavior.
 */
export type AddonStorageLock = {
  /** True only when the primitive coordinates independent execution contexts. */
  crossContext: boolean;
  withLock<T>(task: () => Promise<T>): Promise<T>;
};

const localQueues = new Map<string, Promise<unknown>>();

function withLocalLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = localQueues.get(name) ?? Promise.resolve();
  const current = previous.then(task, task);
  // Keep the queue alive after either success or failure, while preserving the
  // original result for the caller.
  const queueTail = current.then(() => undefined, () => undefined);
  localQueues.set(name, queueTail);
  void queueTail.then(() => {
    if (localQueues.get(name) === queueTail) localQueues.delete(name);
  });
  return current;
}

export function createAddonStorageLock(name: string): AddonStorageLock {
  return {
    get crossContext() {
      return Boolean(globalThis.navigator?.locks);
    },
    async withLock<T>(task: () => Promise<T>): Promise<T> {
      const locks = globalThis.navigator?.locks;
      if (!locks) return withLocalLock(name, task);
      return locks.request(name, { mode: 'exclusive' }, task);
    },
  };
}

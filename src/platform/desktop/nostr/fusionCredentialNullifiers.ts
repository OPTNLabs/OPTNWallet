const PREFIX = 'optn:p2p-fusion:v3:nullifiers:';
const HEX_64 = /^[0-9a-f]{64}$/;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const volatile = new Map<string, Set<string>>();

function read(session: string, storage?: Storage): Set<string> {
  const key = PREFIX + session;
  if (!storage) return new Set(volatile.get(key) ?? []);
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter(
            (item): item is string =>
              typeof item === 'string' && HEX_64.test(item)
          )
        : []
    );
  } catch {
    return new Set();
  }
}

/** Synchronously validate and consume a whole output batch as one operation. */
export function consumeOutputNullifiers(
  session: string,
  serials: string[],
  storage: Storage | undefined = defaultStorage()
): boolean {
  const normalized = serials.map((serial) => serial.toLowerCase());
  if (
    normalized.length === 0 ||
    normalized.some((serial) => !HEX_64.test(serial)) ||
    new Set(normalized).size !== normalized.length
  ) {
    return false;
  }
  const used = read(session, storage);
  if (normalized.some((serial) => used.has(serial))) return false;
  normalized.forEach((serial) => used.add(serial));
  const key = PREFIX + session;
  if (storage) storage.setItem(key, JSON.stringify([...used].sort()));
  else volatile.set(key, used);
  return true;
}

/** Call only after the round has succeeded or irreversibly aborted. */
export function clearRoundNullifiers(
  session: string,
  storage: Storage | undefined = defaultStorage()
): void {
  const key = PREFIX + session;
  if (storage) storage.removeItem(key);
  volatile.delete(key);
}

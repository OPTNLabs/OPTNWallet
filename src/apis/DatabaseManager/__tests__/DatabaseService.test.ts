import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createFakeDatabase(exportBytes: number[]) {
  return class FakeDatabase {
    version = 0;

    prepare() {
      return {
        step: () => false,
        getAsObject: () => ({}),
        run: vi.fn(),
        free: vi.fn(),
      };
    }

    run(sql: string) {
      const m = sql.match(/PRAGMA user_version = (\d+)/);
      if (m) this.version = Number(m[1]);
    }

    exec(sql: string) {
      if (sql.includes('PRAGMA user_version;')) {
        return [{ values: [[this.version]] }];
      }
      return [];
    }

    export() {
      return new Uint8Array(exportBytes);
    }
  };
}

describe('DatabaseService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('resultToJSON handles empty and populated tuples', async () => {
    const mod = await import('../DatabaseService');
    const svc = mod.default();

    expect(svc.resultToJSON([])).toEqual({ mnemonic: '', passphrase: '' });
    expect(svc.resultToJSON(['mn', undefined])).toEqual({
      mnemonic: 'mn',
      passphrase: '',
    });
    expect(svc.resultToJSON(['mn', 'pw'])).toEqual({
      mnemonic: 'mn',
      passphrase: 'pw',
    });
  });

  it('startDatabase initializes DB, runs migrations, and persists once', async () => {
    const idbGet = vi.fn(async () => null);
    const idbSet = vi.fn(async () => {});

    vi.doMock('idb-keyval', () => ({
      get: idbGet,
      set: idbSet,
    }));

    const createTables = vi.fn();
    const createTransactionDetailsTable = vi.fn();
    vi.doMock('../../../utils/schema/schema', () => ({
      createTables,
      createTransactionDetailsTable,
    }));

    const initSqlJs = vi.fn(async () => ({
      Database: createFakeDatabase([1, 2, 3]),
    }));

    vi.doMock('sql.js', () => ({
      default: initSqlJs,
    }));

    const mod = await import('../DatabaseService');
    const svc = mod.default();

    const db = await svc.startDatabase();
    expect(db).toBeTruthy();
    expect(createTables).toHaveBeenCalledTimes(1);
    expect(idbSet).toHaveBeenCalledTimes(1);
  });

  it('saveDatabaseToFile debounces multiple save calls', async () => {
    const idbGet = vi.fn(async () => null);
    const idbSet = vi.fn(async () => {});

    vi.doMock('idb-keyval', () => ({
      get: idbGet,
      set: idbSet,
    }));

    vi.doMock('../../../utils/schema/schema', () => ({
      createTables: vi.fn(),
      createTransactionDetailsTable: vi.fn(),
    }));

    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => ({ Database: createFakeDatabase([9, 9, 9]) })),
    }));

    const mod = await import('../DatabaseService');
    const svc = mod.default();

    await svc.startDatabase();
    expect(idbSet).toHaveBeenCalledTimes(1); // initial save after migrations

    const p1 = svc.saveDatabaseToFile();
    const p2 = svc.saveDatabaseToFile();

    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([p1, p2]);

    expect(idbSet).toHaveBeenCalledTimes(2); // only one debounced save increment
  });

  it('scheduleDatabaseSave coalesces and flushDatabaseToFile flushes immediately', async () => {
    const idbGet = vi.fn(async () => null);
    const idbSet = vi.fn(async () => {});

    vi.doMock('idb-keyval', () => ({
      get: idbGet,
      set: idbSet,
    }));

    vi.doMock('../../../utils/schema/schema', () => ({
      createTables: vi.fn(),
      createTransactionDetailsTable: vi.fn(),
    }));

    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => ({ Database: createFakeDatabase([7, 7, 7]) })),
    }));

    const mod = await import('../DatabaseService');
    const svc = mod.default();

    await svc.startDatabase();
    expect(idbSet).toHaveBeenCalledTimes(1);

    svc.scheduleDatabaseSave();
    svc.scheduleDatabaseSave();
    expect(idbSet).toHaveBeenCalledTimes(1);

    await svc.flushDatabaseToFile();
    expect(idbSet).toHaveBeenCalledTimes(2);
  });

  it('scheduleDatabaseSave works without a window global', async () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, 'window');

    const idbGet = vi.fn(async () => null);
    const idbSet = vi.fn(async () => {});

    vi.doMock('idb-keyval', () => ({
      get: idbGet,
      set: idbSet,
    }));

    vi.doMock('../../../utils/schema/schema', () => ({
      createTables: vi.fn(),
      createTransactionDetailsTable: vi.fn(),
    }));

    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => ({ Database: createFakeDatabase([5, 5, 5]) })),
    }));

    const mod = await import('../DatabaseService');
    const svc = mod.default();

    await svc.startDatabase();
    expect(idbSet).toHaveBeenCalledTimes(1);

    svc.scheduleDatabaseSave();
    await vi.advanceTimersByTimeAsync(500);

    expect(idbSet).toHaveBeenCalledTimes(2);
  });
});

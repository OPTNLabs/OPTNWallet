import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    class FakeDatabase {
      version = 0;
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
        return new Uint8Array([1, 2, 3]);
      }
    }

    const initSqlJs = vi.fn(async () => ({
      Database: FakeDatabase,
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

    class FakeDatabase {
      version = 0;
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
        return new Uint8Array([9, 9, 9]);
      }
    }

    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => ({ Database: FakeDatabase })),
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

    class FakeDatabase {
      version = 0;
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
        return new Uint8Array([7, 7, 7]);
      }
    }

    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => ({ Database: FakeDatabase })),
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
});

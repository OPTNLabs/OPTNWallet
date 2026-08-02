import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTables } from '../../../utils/schema/schema';

describe('DatabaseService multi-window persistence', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('merges wallet-scoped saves after legacy secret migration without dropping either wallet keys', async () => {
    const SQL = await initSqlJs();
    const seed = new SQL.Database();
    createTables(seed);
    seed.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT');
    seed.run('ALTER TABLE wallets ADD COLUMN birth_height INT');
    seed.run('PRAGMA user_version = 7');
    seed.run(
      `INSERT INTO wallets
        (id, wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES
        (1, 'wallet5', 'legacy plaintext seed', '', 'chipnet', 'standard', 0),
        (4, 'wallet6', '', '', 'chipnet', 'standard', 0)`
    );
    seed.run(
      `INSERT INTO keys
        (wallet_id, address, token_address, account_index, change_index, address_index)
       VALUES
        (1, 'bchtest:q5-old', 'bchtest:z5-old', 0, 0, 0),
        (4, 'bchtest:q6-old', 'bchtest:z6-old', 0, 0, 0)`
    );
    let persisted = seed.export();
    seed.close();

    const idbGet = vi.fn(async () => new Uint8Array(persisted));
    const idbSet = vi.fn(async (_key: string, value: Uint8Array) => {
      persisted = new Uint8Array(value);
    });
    vi.doMock('idb-keyval', () => ({
      get: idbGet,
      set: idbSet,
    }));
    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => SQL),
    }));

    const moduleA = await import('../DatabaseService');
    const wallet5Window = moduleA.default();
    await wallet5Window.startDatabase();
    const wallet5Handle = wallet5Window.getDatabase();

    vi.resetModules();
    const moduleB = await import('../DatabaseService');
    const wallet6Window = moduleB.default();
    await wallet6Window.startDatabase();

    wallet6Window.getDatabase()!.run(
      `INSERT INTO keys
        (wallet_id, address, token_address, account_index, change_index, address_index)
       VALUES (4, 'bchtest:q6-fusion', 'bchtest:z6-fusion', 0, 0, 12)`
    );
    await wallet6Window.flushDatabaseToFile(4);

    wallet5Window.getDatabase()!.run(
      `INSERT INTO keys
        (wallet_id, address, token_address, account_index, change_index, address_index)
       VALUES (1, 'bchtest:q5-fusion', 'bchtest:z5-fusion', 0, 0, 12)`
    );
    wallet5Window.getDatabase()!.run(
      `INSERT INTO bcmr
        (authbase, registryUri, lastFetch, registryHash, registryData)
       VALUES ('wallet5-bcmr', 'https://example.test/bcmr.json', 'now', 'hash', '{}')`
    );
    // A global metadata save can already be queued when key creation requests
    // an immediate wallet-scoped flush. The scoped merge must still run.
    wallet5Window.scheduleDatabaseSave();
    await wallet5Window.flushDatabaseToFile(1);
    expect(wallet5Window.getDatabase()).toBe(wallet5Handle);

    const result = new SQL.Database(persisted);
    expect(
      result.exec(
        'SELECT wallet_id, address FROM keys ORDER BY wallet_id, address'
      )[0].values
    ).toEqual([
      [1, 'bchtest:q5-fusion'],
      [1, 'bchtest:q5-old'],
      [4, 'bchtest:q6-fusion'],
      [4, 'bchtest:q6-old'],
    ]);
    expect(
      result.exec("SELECT authbase FROM bcmr WHERE authbase = 'wallet5-bcmr'")[0]
        .values
    ).toEqual([['wallet5-bcmr']]);
    result.close();
  });

  it('does not let a stale generic save overwrite another window wallet metadata', async () => {
    const SQL = await initSqlJs();
    const seed = new SQL.Database();
    createTables(seed);
    seed.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT');
    seed.run('ALTER TABLE wallets ADD COLUMN birth_height INT');
    seed.run('PRAGMA user_version = 7');
    seed.run(
      `INSERT INTO wallets
        (id, wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES
        (1, 'wallet5', '', '', 'chipnet', 'standard', 0),
        (4, 'wallet6', '', '', 'chipnet', 'standard', 0)`
    );
    seed.run(
      `INSERT INTO keys
        (wallet_id, address, token_address, account_index, change_index, address_index)
       VALUES
        (1, 'bchtest:q5-old', 'bchtest:z5-old', 0, 0, 0),
        (4, 'bchtest:q6-old', 'bchtest:z6-old', 0, 0, 0)`
    );
    let persisted = seed.export();
    seed.close();

    vi.doMock('idb-keyval', () => ({
      get: vi.fn(async () => new Uint8Array(persisted)),
      set: vi.fn(async (_key: string, value: Uint8Array) => {
        persisted = new Uint8Array(value);
      }),
    }));
    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => SQL),
    }));

    const wallet5Window = (await import('../DatabaseService')).default();
    await wallet5Window.startDatabase();

    vi.resetModules();
    const wallet6Window = (await import('../DatabaseService')).default();
    await wallet6Window.startDatabase();
    wallet6Window
      .getDatabase()!
      .run("UPDATE wallets SET kdf_salt = 'wallet6-new' WHERE id = 4");
    wallet6Window.getDatabase()!.run(
      `INSERT INTO UTXOs
        (wallet_id, address, height, tx_hash, tx_pos, amount, prefix)
       VALUES (4, 'bchtest:q6-old', 123, 'wallet6-new-utxo', 0, 5000, 'bchtest')`
    );
    wallet6Window.getDatabase()!.run(
      `INSERT INTO transactions
        (wallet_id, tx_hash, height, timestamp, amount)
       VALUES (4, 'wallet6-new-tx', 123, 'now', 5000)`
    );
    await wallet6Window.flushDatabaseToFile(4);

    await wallet5Window.flushDatabaseToFile();

    const result = new SQL.Database(persisted);
    expect(
      result.exec('SELECT kdf_salt FROM wallets WHERE id = 4')[0].values[0][0]
    ).toBe('wallet6-new');
    expect(
      result.exec(
        "SELECT tx_hash, amount FROM UTXOs WHERE wallet_id = 4 AND tx_hash = 'wallet6-new-utxo'"
      )[0].values
    ).toEqual([['wallet6-new-utxo', 5000]]);
    expect(
      result.exec(
        "SELECT tx_hash, amount FROM transactions WHERE wallet_id = 4 AND tx_hash = 'wallet6-new-tx'"
      )[0].values
    ).toEqual([['wallet6-new-tx', 5000]]);
    result.close();
  });

  it('lets a locked window recover instead of refusing every save forever', async () => {
    // The balance-disappears bug. A window loads the database once at startup;
    // locking a wallet leaves that copy and its save baselines untouched. Another
    // window writes, and from then on EVERY save from the first window is refused
    // — including the UTXO write — so the wallet reports a good sync and shows
    // nothing. Before the resync there was no way out but restarting the app.
    const SQL = await initSqlJs();
    const seed = new SQL.Database();
    createTables(seed);
    seed.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT');
    seed.run('ALTER TABLE wallets ADD COLUMN birth_height INT');
    seed.run('PRAGMA user_version = 7');
    seed.run(
      `INSERT INTO wallets
        (id, wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES (1, 'wallet5', '', '', 'chipnet', 'standard', 0)`
    );
    let persisted = seed.export();
    seed.close();

    vi.doMock('idb-keyval', () => ({
      get: vi.fn(async () => new Uint8Array(persisted)),
      set: vi.fn(async (_key: string, value: Uint8Array) => {
        persisted = new Uint8Array(value);
      }),
    }));
    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => SQL),
    }));

    const lockedWindow = (await import('../DatabaseService')).default();
    await lockedWindow.startDatabase();
    vi.resetModules();
    const otherWindow = (await import('../DatabaseService')).default();
    await otherWindow.startDatabase();

    // While this window sits locked, another one writes the same wallet.
    otherWindow.getDatabase()!.run(
      `INSERT INTO keys
        (wallet_id, address, token_address, account_index, change_index, address_index)
       VALUES (1, 'bchtest:other-window', 'bchtest:z-other-window', 0, 0, 1)`
    );
    await otherWindow.flushDatabaseToFile(1);

    // Reopening the wallet and syncing stores a coin. This is the save the user
    // never sees succeed.
    const storeSyncedCoin = () =>
      lockedWindow.getDatabase()!.run(
        `INSERT INTO UTXOs
          (wallet_id, address, height, tx_hash, tx_pos, amount, prefix)
         VALUES (1, 'bchtest:mine', 5, 'restored-utxo', 0, 4200, 'bchtest')`
      );

    storeSyncedCoin();
    await expect(lockedWindow.flushDatabaseToFile(1)).rejects.toThrow(
      'changed in another window'
    );

    // What locking now does. Rebasing drops our stale rows too, which is why it
    // is only safe with no wallet open — the coins come back from the chain.
    await lockedWindow.resyncDatabaseFromDisk();
    storeSyncedCoin();
    await lockedWindow.flushDatabaseToFile(1);

    const result = new SQL.Database(persisted);
    expect(
      result.exec("SELECT amount FROM UTXOs WHERE tx_hash = 'restored-utxo'")[0]
        .values
    ).toEqual([[4200]]);
    // and the other window's work was not trampled on the way out.
    expect(
      result.exec('SELECT address FROM keys WHERE wallet_id = 1')[0].values
    ).toEqual([['bchtest:other-window']]);
    result.close();
  });

  it('rejects a stale second window before it can replace the same wallet', async () => {
    const SQL = await initSqlJs();
    const seed = new SQL.Database();
    createTables(seed);
    seed.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT');
    seed.run('ALTER TABLE wallets ADD COLUMN birth_height INT');
    seed.run('PRAGMA user_version = 7');
    seed.run(
      `INSERT INTO wallets
        (id, wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES
        (1, 'wallet5', '', '', 'chipnet', 'standard', 0),
        (4, 'wallet6', '', '', 'chipnet', 'standard', 0)`
    );
    let persisted = seed.export();
    seed.close();

    vi.doMock('idb-keyval', () => ({
      get: vi.fn(async () => new Uint8Array(persisted)),
      set: vi.fn(async (_key: string, value: Uint8Array) => {
        persisted = new Uint8Array(value);
      }),
    }));
    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => SQL),
    }));

    const firstWindow = (await import('../DatabaseService')).default();
    await firstWindow.startDatabase();
    vi.resetModules();
    const staleWindow = (await import('../DatabaseService')).default();
    await staleWindow.startDatabase();

    firstWindow.getDatabase()!.run(
      `INSERT INTO keys
        (wallet_id, address, token_address, account_index, change_index, address_index)
       VALUES (1, 'bchtest:first-window', 'bchtest:z-first-window', 0, 0, 1)`
    );
    await firstWindow.flushDatabaseToFile(1);

    staleWindow.getDatabase()!.run(
      `INSERT INTO keys
        (wallet_id, address, token_address, account_index, change_index, address_index)
       VALUES (1, 'bchtest:stale-window', 'bchtest:z-stale-window', 0, 0, 2)`
    );
    await expect(staleWindow.flushDatabaseToFile(1)).rejects.toThrow(
      'changed in another window'
    );

    staleWindow.getDatabase()!.run(
      `INSERT INTO keys
        (wallet_id, address, token_address, account_index, change_index, address_index)
       VALUES (4, 'bchtest:wallet6-safe', 'bchtest:z-wallet6-safe', 0, 0, 1)`
    );
    staleWindow.scheduleDatabaseSave(1);
    await expect(staleWindow.flushDatabaseToFile(4)).rejects.toThrow(
      'changed in another window'
    );

    const result = new SQL.Database(persisted);
    expect(
      result.exec('SELECT wallet_id, address FROM keys ORDER BY wallet_id')[0]
        .values
    ).toEqual([
      [1, 'bchtest:first-window'],
      [4, 'bchtest:wallet6-safe'],
    ]);
    result.close();
  });

  it('rejects a stale save after another window changes an encrypted wallet secret', async () => {
    const SQL = await initSqlJs();
    const seed = new SQL.Database();
    createTables(seed);
    seed.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT');
    seed.run('ALTER TABLE wallets ADD COLUMN birth_height INT');
    seed.run('PRAGMA user_version = 7');
    seed.run(
      `INSERT INTO wallets
        (id, wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES
        (1, 'wallet5', 'enc:v1:seed', '', 'chipnet', 'standard', 0)`
    );
    let persisted = seed.export();
    seed.close();

    vi.doMock('idb-keyval', () => ({
      get: vi.fn(async () => new Uint8Array(persisted)),
      set: vi.fn(async (_key: string, value: Uint8Array) => {
        persisted = new Uint8Array(value);
      }),
    }));
    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => SQL),
    }));

    const firstWindow = (await import('../DatabaseService')).default();
    await firstWindow.startDatabase();
    vi.resetModules();
    const staleWindow = (await import('../DatabaseService')).default();
    await staleWindow.startDatabase();

    firstWindow
      .getDatabase()!
      .run("UPDATE wallets SET mnemonic = 'enc:v1:first-window-secret' WHERE id = 1");
    await firstWindow.flushDatabaseToFile(1);

    staleWindow
      .getDatabase()!
      .run("UPDATE wallets SET wallet_name = 'stale-window-name' WHERE id = 1");
    await expect(staleWindow.flushDatabaseToFile(1)).rejects.toThrow(
      'changed in another window'
    );

    const result = new SQL.Database(persisted);
    expect(result.exec('SELECT mnemonic, wallet_name FROM wallets WHERE id = 1')[0].values).toEqual([
      ['enc:v1:first-window-secret', 'wallet5'],
    ]);
    result.close();
  });

  it('does not resurrect a wallet deleted by another window during a generic save', async () => {
    const SQL = await initSqlJs();
    const seed = new SQL.Database();
    createTables(seed);
    seed.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT');
    seed.run('ALTER TABLE wallets ADD COLUMN birth_height INT');
    seed.run('PRAGMA user_version = 7');
    seed.run(
      `INSERT INTO wallets
        (id, wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES
        (1, 'wallet5', '', '', 'chipnet', 'standard', 0),
        (4, 'wallet6', '', '', 'chipnet', 'standard', 0)`
    );
    let persisted = seed.export();
    seed.close();

    vi.doMock('idb-keyval', () => ({
      get: vi.fn(async () => new Uint8Array(persisted)),
      set: vi.fn(async (_key: string, value: Uint8Array) => {
        persisted = new Uint8Array(value);
      }),
    }));
    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => SQL),
    }));

    const deletingWindow = (await import('../DatabaseService')).default();
    await deletingWindow.startDatabase();
    vi.resetModules();
    const staleWindow = (await import('../DatabaseService')).default();
    await staleWindow.startDatabase();

    deletingWindow.getDatabase()!.run('DELETE FROM wallets WHERE id = 1');
    await deletingWindow.deleteWalletFromFile(1);

    staleWindow.getDatabase()!.run(
      `INSERT INTO bcmr
        (authbase, registryUri, lastFetch, registryHash, registryData)
       VALUES ('stale-global-save', 'https://example.test', 'now', 'hash', '{}')`
    );
    await staleWindow.flushDatabaseToFile();

    const result = new SQL.Database(persisted);
    expect(result.exec('SELECT id FROM wallets ORDER BY id')[0].values).toEqual([
      [4],
    ]);
    expect(
      result.exec(
        "SELECT authbase FROM bcmr WHERE authbase = 'stale-global-save'"
      )[0].values
    ).toEqual([['stale-global-save']]);
    result.close();
  });

  it('reassigns colliding wallet ids when two windows create concurrently', async () => {
    const SQL = await initSqlJs();
    const seed = new SQL.Database();
    createTables(seed);
    seed.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT');
    seed.run('ALTER TABLE wallets ADD COLUMN birth_height INT');
    seed.run('PRAGMA user_version = 7');
    seed.run(
      `INSERT INTO wallets
        (id, wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES (4, 'wallet6', '', '', 'chipnet', 'standard', 0)`
    );
    let persisted = seed.export();
    seed.close();

    vi.doMock('idb-keyval', () => ({
      get: vi.fn(async () => new Uint8Array(persisted)),
      set: vi.fn(async (_key: string, value: Uint8Array) => {
        persisted = new Uint8Array(value);
      }),
    }));
    vi.doMock('sql.js', () => ({
      default: vi.fn(async () => SQL),
    }));

    const firstWindow = (await import('../DatabaseService')).default();
    await firstWindow.startDatabase();
    vi.resetModules();
    const secondWindow = (await import('../DatabaseService')).default();
    await secondWindow.startDatabase();

    firstWindow.getDatabase()!.run(
      `INSERT INTO wallets
        (wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES ('new-a', '', '', 'chipnet', 'standard', 0)`
    );
    secondWindow.getDatabase()!.run(
      `INSERT INTO wallets
        (wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES ('new-b', '', '', 'chipnet', 'standard', 0)`
    );

    expect(await firstWindow.persistNewWalletToFile(5)).toBe(5);
    expect(await secondWindow.persistNewWalletToFile(5)).toBe(6);

    const result = new SQL.Database(persisted);
    expect(
      result.exec(
        "SELECT id, wallet_name FROM wallets WHERE wallet_name LIKE 'new-%' ORDER BY id"
      )[0].values
    ).toEqual([
      [5, 'new-a'],
      [6, 'new-b'],
    ]);
    expect(
      secondWindow
        .getDatabase()!
        .exec("SELECT id FROM wallets WHERE wallet_name = 'new-b'")[0].values
    ).toEqual([[6]]);
    result.close();
  });
});

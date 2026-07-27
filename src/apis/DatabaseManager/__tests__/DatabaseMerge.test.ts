import initSqlJs, { type Database } from 'sql.js';
import { describe, expect, it } from 'vitest';

function createDatabase(SQL: Awaited<ReturnType<typeof initSqlJs>>): Database {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_name TEXT,
      networkType TEXT
    );
    CREATE TABLE keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER,
      address TEXT UNIQUE,
      private_key BLOB
    );
    CREATE TABLE addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER,
      address TEXT UNIQUE
    );
    CREATE TABLE UTXOs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER,
      address TEXT,
      tx_hash TEXT,
      tx_pos INTEGER,
      amount INTEGER,
      UNIQUE(wallet_id, address, tx_hash, tx_pos)
    );
  `);
  db.run(
    "INSERT INTO wallets (id, wallet_name, networkType) VALUES (1, 'wallet5', 'chipnet'), (4, 'wallet6', 'chipnet')"
  );
  db.run(
    "INSERT INTO keys (wallet_id, address, private_key) VALUES (1, 'bchtest:q5-old', X'01'), (4, 'bchtest:q6-old', X'02')"
  );
  db.run(
    "INSERT INTO addresses (wallet_id, address) VALUES (1, 'bchtest:q5-old'), (4, 'bchtest:q6-old')"
  );
  db.run(
    "INSERT INTO UTXOs (wallet_id, address, tx_hash, tx_pos, amount) VALUES (1, 'bchtest:q5-old', 'spent', 0, 10), (4, 'bchtest:q6-old', 'keep', 0, 20)"
  );
  return db;
}

function columnValues(
  db: Database,
  sql: string
): Array<Array<string | number | Uint8Array | null>> {
  return (db.exec(sql)[0]?.values ?? []) as Array<
    Array<string | number | Uint8Array | null>
  >;
}

describe('mergeWalletScope', () => {
  it('replaces one wallet from its window while preserving another window changes', async () => {
    const SQL = await initSqlJs();
    const base = createDatabase(SQL);
    const localWallet5 = new SQL.Database(base.export());
    const latestShared = new SQL.Database(base.export());

    localWallet5.run(
      "INSERT INTO keys (wallet_id, address, private_key) VALUES (1, 'bchtest:q5-fusion', X'05')"
    );
    localWallet5.run(
      "INSERT INTO addresses (wallet_id, address) VALUES (1, 'bchtest:q5-fusion')"
    );
    localWallet5.run('DELETE FROM UTXOs WHERE wallet_id = 1');
    localWallet5.run(
      "INSERT INTO UTXOs (wallet_id, address, tx_hash, tx_pos, amount) VALUES (1, 'bchtest:q5-fusion', 'fusion', 2, 125000)"
    );

    latestShared.run(
      "INSERT INTO keys (wallet_id, address, private_key) VALUES (4, 'bchtest:q6-fusion', X'06')"
    );
    latestShared.run(
      "INSERT INTO addresses (wallet_id, address) VALUES (4, 'bchtest:q6-fusion')"
    );

    const { mergeWalletScope } = await import('../DatabaseMerge');
    mergeWalletScope(latestShared, localWallet5, 1);

    expect(
      columnValues(
        latestShared,
        'SELECT wallet_id, address FROM keys ORDER BY wallet_id, address'
      )
    ).toEqual([
      [1, 'bchtest:q5-fusion'],
      [1, 'bchtest:q5-old'],
      [4, 'bchtest:q6-fusion'],
      [4, 'bchtest:q6-old'],
    ]);
    expect(
      columnValues(
        latestShared,
        'SELECT wallet_id, address FROM addresses ORDER BY wallet_id, address'
      )
    ).toEqual([
      [1, 'bchtest:q5-fusion'],
      [1, 'bchtest:q5-old'],
      [4, 'bchtest:q6-fusion'],
      [4, 'bchtest:q6-old'],
    ]);
    expect(
      columnValues(
        latestShared,
        'SELECT wallet_id, tx_hash, amount FROM UTXOs ORDER BY wallet_id, tx_hash'
      )
    ).toEqual([
      [1, 'fusion', 125000],
      [4, 'keep', 20],
    ]);

    base.close();
    localWallet5.close();
    latestShared.close();
  });
});

describe('mergeGlobalChanges', () => {
  it('applies local-only metadata changes without overwriting concurrent rows', async () => {
    const SQL = await initSqlJs();
    const base = new SQL.Database();
    base.run(`
      CREATE TABLE bcmr (
        authbase TEXT PRIMARY KEY,
        registryUri TEXT NOT NULL,
        lastFetch TEXT NOT NULL,
        registryHash TEXT NOT NULL,
        registryData TEXT NOT NULL
      );
      INSERT INTO bcmr
        (authbase, registryUri, lastFetch, registryHash, registryData)
      VALUES ('existing', 'base', 'base', 'base', '{}');
    `);
    const local = new SQL.Database(base.export());
    const latest = new SQL.Database(base.export());
    const { mergeGlobalChanges, snapshotGlobalTables } =
      await import('../DatabaseMerge');
    const baseline = snapshotGlobalTables(local);

    local.run("UPDATE bcmr SET registryUri = 'local' WHERE authbase = 'existing'");
    latest.run(
      "UPDATE bcmr SET registryUri = 'concurrent' WHERE authbase = 'existing'"
    );
    local.run(
      "INSERT INTO bcmr VALUES ('collision', 'local', 'now', 'hash', '{}')"
    );
    latest.run(
      "INSERT INTO bcmr VALUES ('collision', 'concurrent', 'now', 'hash', '{}')"
    );
    local.run(
      "INSERT INTO bcmr VALUES ('local-only', 'local', 'now', 'hash', '{}')"
    );

    mergeGlobalChanges(latest, local, baseline);

    expect(
      columnValues(
        latest,
        'SELECT authbase, registryUri FROM bcmr ORDER BY authbase'
      )
    ).toEqual([
      ['collision', 'concurrent'],
      ['existing', 'concurrent'],
      ['local-only', 'local'],
    ]);

    base.close();
    local.close();
    latest.close();
  });
});

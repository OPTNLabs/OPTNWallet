import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTables } from '../../../utils/schema/schema';

const publicMetadata = [
  'public-account-xpub-fixture',
  '0123abcd',
  '{ "version": 1, "threshold": 2, "cosigners": ["public-a", "public-b"] }',
];
const columns = ['account_xpub', 'master_fingerprint', 'multisig_policy'];
const selectMetadata = `SELECT ${columns.join(', ')} FROM wallets WHERE id = 1`;

describe('DatabaseService watch-only persistence', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function setup(existingColumns: number) {
    const SQL = await initSqlJs();
    const seed = new SQL.Database();
    createTables(seed);
    seed.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT');
    seed.run('ALTER TABLE wallets ADD COLUMN birth_height INT');
    seed.run('PRAGMA user_version = 7');
    seed.run(
      `INSERT INTO wallets
        (id, wallet_name, mnemonic, passphrase, networkType, walletType, balance)
       VALUES (1, 'watch-only', '', '', 'chipnet', 'watch-only', 0)`
    );
    for (const [index, column] of columns.slice(0, existingColumns).entries()) {
      seed.run(`ALTER TABLE wallets ADD COLUMN ${column} TEXT`);
      seed.run(`UPDATE wallets SET ${column} = ? WHERE id = 1`, [
        publicMetadata[index],
      ]);
    }
    const legacy = seed.export();
    seed.close();
    let persisted = legacy;
    vi.doMock('idb-keyval', () => ({
      get: vi.fn(async () => new Uint8Array(persisted)),
      set: vi.fn(async (_key: string, value: Uint8Array) => {
        persisted = new Uint8Array(value);
      }),
    }));
    vi.doMock('sql.js', () => ({ default: vi.fn(async () => SQL) }));
    const service = (await import('../DatabaseService')).default();
    await service.startDatabase();
    return {
      SQL,
      service,
      persisted: () => persisted,
      restoreLegacySnapshot: () => {
        persisted = legacy;
      },
    };
  }

  it.each([0, 1, 3])(
    'preserves exact public metadata through scoped save/reload with %i lazy columns already present',
    async (existingColumns) => {
      const { SQL, service, persisted, restoreLegacySnapshot } =
        await setup(existingColumns);
      expect(service.getDatabase()!.exec(selectMetadata)[0].values).toEqual([
        publicMetadata.map((value, index) =>
          index < existingColumns ? value : null
        ),
      ]);
      // The existing lazy helper must remain compatible with migrated databases.
      const { ensureWatchOnlyWalletColumns } = await import(
        '../../../services/watchOnlySchema'
      );
      await ensureWatchOnlyWalletColumns();
      service
        .getDatabase()!
        .run(
          'UPDATE wallets SET account_xpub = ?, master_fingerprint = ?, multisig_policy = ?, balance = 1 WHERE id = 1',
          publicMetadata
        );
      // Exercise migrations on the persisted merge target as well as startup.
      restoreLegacySnapshot();
      await service.flushDatabaseToFile(1);
      const saved = new SQL.Database(persisted());
      expect(saved.exec(selectMetadata)[0].values).toEqual([publicMetadata]);
      saved.close();

      vi.resetModules();
      const reopened = (await import('../DatabaseService')).default();
      await reopened.startDatabase();
      expect(reopened.getDatabase()!.exec(selectMetadata)[0].values).toEqual([
        publicMetadata,
      ]);
      await reopened.flushDatabaseToFile(1);
      reopened.getDatabase()!.close();
      service.getDatabase()!.close();
    }
  );

  it('migrates a resynced legacy snapshot before exposing it and taking save baselines', async () => {
    const { SQL, service, persisted, restoreLegacySnapshot } = await setup(1);
    restoreLegacySnapshot();
    await service.resyncDatabaseFromDisk();
    expect(service.getDatabase()!.exec(selectMetadata)[0].values).toEqual([
      [publicMetadata[0], null, null],
    ]);
    service
      .getDatabase()!
      .run(
        'UPDATE wallets SET account_xpub = ?, master_fingerprint = ?, multisig_policy = ? WHERE id = 1',
        publicMetadata
      );
    await service.flushDatabaseToFile(1);
    const saved = new SQL.Database(persisted());
    expect(saved.exec(selectMetadata)[0].values).toEqual([publicMetadata]);
    saved.close();
    service.getDatabase()!.close();
  });
});

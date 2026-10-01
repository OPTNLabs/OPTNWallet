import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handle: vi.fn(),
  desktop: vi.fn(),
  getDatabase: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../walletFile', () => ({
  findWalletFileRelForSourceId: mocks.handle,
}));
vi.mock('../../../utils/platform', () => ({
  isDesktopPlatform: mocks.desktop,
}));
vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ getDatabase: mocks.getDatabase }),
}));

import { openWalletInEngine } from '../engineWalletBridge';

const session = { active: 'selected.optn', epoch: 42 };
const accountPath = "m/44'/145'/4'";
let sql: SqlJsStatic;
let db: Database;
let events: string[];
let queries: Array<{ sql: string; params: unknown; free: () => boolean }>;

beforeAll(async () => {
  sql = await initSqlJs();
});

beforeEach(() => {
  vi.resetAllMocks();
  events = [];
  queries = [];
  db = new sql.Database();
  // A disposable public-only database: no wallet files, secrets, or app state.
  db.run(`CREATE TABLE wallets (id INTEGER PRIMARY KEY, derivation_path TEXT);
    CREATE TABLE keys (wallet_id INT, address TEXT, account_index INT,
      change_index INT, address_index INT);`);
  db.run('INSERT INTO wallets VALUES (?, ?)', [7, accountPath]);
  mocks.desktop.mockReturnValue(true);
  mocks.handle.mockResolvedValue('wallets/selected.optn');
  mocks.getDatabase.mockReturnValue({ prepare: mocks.prepare });
  mocks.prepare.mockImplementation((text: string) => {
    events.push('read');
    const statement = db.prepare(text);
    const query = {
      sql: text.replace(/\s+/g, ' ').trim(),
      params: undefined as unknown,
      free: vi.spyOn(statement, 'free'),
    };
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, 'bind').mockImplementation((params) => {
      query.params = params;
      return bind(params);
    });
    queries.push(query);
    return statement;
  });
  mocks.invoke.mockImplementation(async (_command, args) => {
    events.push(args.request?.command ?? args.action.action.type);
    return session;
  });
});

afterEach(() => {
  for (const query of queries) expect(query.free).toHaveBeenCalledOnce();
  db.close();
});

const importCalls = () =>
  mocks.invoke.mock.calls.filter(
    ([, args]) => args?.request?.command === 'import_hd_inventory'
  );

describe('legacy public HD inventory handoff', () => {
  it('opens first, then imports only the highest public address of each selected wallet/account branch', async () => {
    for (const branch of [0, 1, 7, 2]) {
      for (const index of [100, 2, 9]) {
        db.run('INSERT INTO keys VALUES (?, ?, ?, ?, ?)', [
          7,
          `public-${branch}-${index}`,
          4,
          branch,
          index,
        ]);
      }
      db.run('INSERT INTO keys VALUES (?, ?, ?, ?, ?)', [
        9,
        'other-wallet',
        0,
        branch,
        999,
      ]);
    }
    expect(await openWalletInEngine(7, 'test-password', 15)).toEqual({
      opened: true,
    });
    expect(mocks.handle).toHaveBeenCalledWith(7);
    expect(mocks.invoke.mock.calls[1]).toEqual([
      'optn_wallet_security',
      {
        request: {
          command: 'open',
          handle: session.active,
          password: 'test-password',
        },
      },
    ]);
    expect(events.slice(0, 3)).toEqual([
      'set_auto_lock_minutes',
      'open',
      'read',
    ]);
    expect(events.slice(-2)).toEqual(['status', 'import_hd_inventory']);
    expect(importCalls()).toEqual([
      [
        'optn_wallet_security',
        {
          request: {
            command: 'import_hd_inventory',
            epoch: 42,
            account_path: accountPath,
            addresses: [0, 1, 7, 2].map((branch) => ({
              branch,
              index: 100,
              address: `public-${branch}-100`,
            })),
          },
        },
      ],
    ]);
    expect(queries[0]).toMatchObject({
      sql: 'SELECT derivation_path FROM wallets WHERE id = ? LIMIT 1',
      params: [7],
    });
    expect(
      queries.filter((query) => query.sql.includes('ORDER BY'))
    ).toMatchObject(
      [0, 1, 7, 2].map((branch) => ({
        sql: 'SELECT address, account_index, change_index, address_index FROM keys WHERE wallet_id = ? AND account_index = ? AND change_index = ? ORDER BY address_index DESC LIMIT 1',
        params: [7, 4, branch],
      }))
    );
    for (const query of queries) {
      expect(query.sql).not.toMatch(
        /\*|mnemonic|passphrase|private_key|public_key/i
      );
      expect(query.sql).toContain('LIMIT 1');
    }
  });

  it('treats an empty selected inventory as a no-op, without reading another wallet', async () => {
    db.run("INSERT INTO keys VALUES (9, 'other-wallet', 8, 0, 99)");
    expect(await openWalletInEngine(7, 'test-password')).toEqual({
      opened: true,
    });
    expect(importCalls()).toEqual([]);
  });

  it('keeps RPA keys and other contract branches outside the HD handoff', async () => {
    db.run("INSERT INTO keys VALUES (7, 'public-address', 4, 0, 50)");
    db.run("INSERT INTO keys VALUES (7, 'rpa-key', 0, 3, 1)");
    db.run("INSERT INTO keys VALUES (7, 'contract-key', 0, 8, 1)");
    expect(await openWalletInEngine(7, 'test-password')).toEqual({
      opened: true,
    });
    expect(importCalls()[0][1].request.addresses).toEqual([
      { branch: 0, index: 50, address: 'public-address' },
    ]);
  });

  it.each([0, 5, null, 'invalid-account'])(
    'reports unsupported account %s instead of claiming full coverage',
    async (account) => {
      db.run('INSERT INTO keys VALUES (7, ?, ?, 0, 1)', [
        'public-address',
        account,
      ]);
      expect(await openWalletInEngine(7, 'test-password')).toEqual({
        opened: false,
        reason: 'Wallet opened, but legacy HD inventory migration failed',
      });
      expect(importCalls()).toEqual([]);
    }
  );

  it.each([
    [null, 1, 'public-address'],
    [0, -1, 'public-address'],
    [0, 0x80000000, 'public-address'],
    [0, 1.5, 'public-address'],
    [0, null, 'public-address'],
    [0, 1, null],
    [0, 1, '  '],
    [0, 1, 'a'.repeat(256)],
  ])(
    'reports malformed/unsupported inventory (%s, %s)',
    async (branch, index, address) => {
      // Even malformed rows below the highest index must not disappear silently.
      db.run("INSERT INTO keys VALUES (7, 'valid-highest', 4, 0, 50)");
      db.run('INSERT INTO keys VALUES (7, ?, 4, ?, ?)', [
        address,
        branch,
        index,
      ]);
      expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
        opened: false,
        reason: 'Wallet opened, but legacy HD inventory migration failed',
      });
      expect(importCalls()).toEqual([]);
    }
  );

  it.each([null, '', "m/44'/145'/4'/0/1"])(
    'reports missing/invalid public account path %s',
    async (path) => {
      db.run('UPDATE wallets SET derivation_path = ? WHERE id = 7', [path]);
      expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
        opened: false,
        reason: expect.stringContaining('inventory migration failed'),
      });
      expect(importCalls()).toEqual([]);
    }
  );

  it.each(['unavailable', 'read failure', 'missing wallet'])(
    'does not claim migration on public database %s',
    async (failure) => {
      if (failure === 'unavailable') mocks.getDatabase.mockReturnValue(null);
      if (failure === 'read failure')
        mocks.prepare.mockImplementation(() => {
          throw new Error('public read failed');
        });
      if (failure === 'missing wallet') db.run('DELETE FROM wallets');
      expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
        opened: false,
        reason: expect.stringContaining('inventory migration failed'),
      });
      expect(importCalls()).toEqual([]);
    }
  );

  it.each([
    null,
    { ...session, active: 'other.optn' },
    { ...session, epoch: -1 },
    { ...session, epoch: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    'rejects invalid open session %j before any public read',
    async (opened) => {
      mocks.invoke.mockResolvedValueOnce(opened);
      expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
        opened: false,
      });
      expect(mocks.getDatabase).not.toHaveBeenCalled();
      expect(importCalls()).toEqual([]);
    }
  );

  it.each([{ active: null }, { active: 'other.optn' }, { epoch: 43 }])(
    'does not import after a wallet switch/lock %j',
    async (changed) => {
      db.run("INSERT INTO keys VALUES (7, 'public-address', 4, 0, 50)");
      mocks.invoke
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce({ ...session, ...changed });
      expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
        opened: false,
        reason: 'Wallet opened, but legacy HD inventory migration failed',
      });
      expect(importCalls()).toEqual([]);
    }
  );

  it.each(['ownership rejected', 'persistence failed', 'stale epoch'])(
    'surfaces Rust import failure: %s',
    async (failure) => {
      db.run("INSERT INTO keys VALUES (7, 'public-address', 4, 0, 50)");
      mocks.invoke
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(session)
        .mockRejectedValueOnce(new Error(failure));
      expect(await openWalletInEngine(7, 'test-password')).toEqual({
        opened: false,
        reason: 'Wallet opened, but legacy HD inventory migration failed',
      });
      expect(importCalls()).toHaveLength(1);
    }
  );

  it('does not claim success on an import response from a different session', async () => {
    db.run("INSERT INTO keys VALUES (7, 'public-address', 4, 0, 50)");
    mocks.invoke
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, epoch: 43 });
    expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
      opened: false,
      reason: 'Wallet opened, but legacy HD inventory migration failed',
    });
  });

  it('does not read inventory after a failed open or when the bridge is unavailable', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('open refused'));
    expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
      opened: false,
    });
    mocks.handle.mockResolvedValueOnce(null);
    expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
      opened: false,
    });
    mocks.desktop.mockReturnValue(false);
    expect(await openWalletInEngine(7, 'test-password')).toMatchObject({
      opened: false,
    });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it.each(['lookup', 'open', 'inventory'])(
    'keeps %s error details out of renderer messages',
    async (stage) => {
      const detail = 'private native diagnostics must not leave the adapter';
      if (stage === 'lookup')
        mocks.handle.mockRejectedValueOnce(new Error(detail));
      if (stage === 'open')
        mocks.invoke.mockRejectedValueOnce(new Error(detail));
      if (stage === 'inventory')
        mocks.getDatabase.mockImplementationOnce(() => {
          throw new Error(detail);
        });
      const result = await openWalletInEngine(7, 'test-password');
      expect(result).toEqual({
        opened: false,
        reason:
          stage === 'inventory'
            ? 'Wallet opened, but legacy HD inventory migration failed'
            : 'Engine wallet open failed',
      });
      expect(JSON.stringify(result)).not.toContain(detail);
      expect(importCalls()).toEqual([]);
    }
  );
});

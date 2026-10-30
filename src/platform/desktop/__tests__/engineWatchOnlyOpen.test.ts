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

// Public data only. The engine is mocked here and never parses it.
const xpub =
  'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
let sql: SqlJsStatic;
let db: Database;
let requests: Array<Record<string, unknown>>;
let engineFiles: Array<{ handle: string; legacy_source_id: number | null }>;

beforeAll(async () => {
  sql = await initSqlJs();
});

beforeEach(() => {
  vi.resetAllMocks();
  requests = [];
  engineFiles = [];
  // A disposable public-only database: no wallet files, secrets, or app state.
  db = new sql.Database();
  db.run(`CREATE TABLE wallets (id INTEGER PRIMARY KEY, wallet_name TEXT,
    networkType TEXT, walletType TEXT, derivation_path TEXT,
    account_xpub TEXT, master_fingerprint TEXT)`);
  db.run('INSERT INTO wallets VALUES (?, ?, ?, ?, ?, ?, ?)', [
    7,
    'SeedCash watch',
    'chipnet',
    'watch-only',
    "m/44'/1'/0'",
    xpub,
    'a1b2c3d4',
  ]);
  mocks.desktop.mockReturnValue(true);
  // Watch-only wallets have no seed file mirror.
  mocks.handle.mockResolvedValue(null);
  mocks.getDatabase.mockReturnValue(db);
  mocks.invoke.mockImplementation(async (_command, args) => {
    const request = args.request as Record<string, unknown>;
    requests.push(request);
    if (request.command === 'status') {
      return { active: null, epoch: 3, wallets: engineFiles };
    }
    return { active: 'wallet-0011.optn', epoch: 4, legacy_source_id: 7 };
  });
});

afterEach(() => {
  db.close();
});

describe('opening public-key wallets in the shared engine', () => {
  it('imports a watch-only wallet once, owned by its desktop wallet id', async () => {
    expect(await openWalletInEngine(7, 'test-password')).toEqual({
      opened: true,
    });
    expect(requests).toEqual([
      { command: 'status' },
      {
        command: 'import_watch_only',
        name: 'SeedCash watch',
        account_xpub: xpub,
        master_fingerprint: 'a1b2c3d4',
        password: 'test-password',
        confirmation: 'test-password',
        network: 'chipnet',
        account_path: "m/44'/1'/0'",
        legacy_source_id: 7,
      },
    ]);
  });

  it('reopens the engine file that already belongs to the wallet', async () => {
    engineFiles = [
      { handle: 'wallet-other.optn', legacy_source_id: 9 },
      { handle: 'wallet-0011.optn', legacy_source_id: 7 },
    ];
    expect(await openWalletInEngine(7, 'test-password')).toEqual({
      opened: true,
    });
    expect(requests.at(-1)).toEqual({
      command: 'open',
      handle: 'wallet-0011.optn',
      password: 'test-password',
    });
  });

  it('treats hardware wallets the same way', async () => {
    db.run(
      "UPDATE wallets SET walletType = 'hardware', master_fingerprint = NULL"
    );
    expect(await openWalletInEngine(7, 'test-password')).toEqual({
      opened: true,
    });
    expect(requests.at(-1)).toMatchObject({
      command: 'import_watch_only',
      master_fingerprint: '',
      legacy_source_id: 7,
    });
  });

  it('leaves multisig policies to their own coverage', async () => {
    db.run('UPDATE wallets SET account_xpub = NULL');
    expect(await openWalletInEngine(7, 'test-password')).toEqual({
      opened: false,
      reason: 'The shared engine does not cover multisig wallets yet.',
    });
    expect(requests).toEqual([]);
  });

  it('does not open other wallet kinds without a seed file', async () => {
    db.run("UPDATE wallets SET walletType = 'standard'");
    expect(await openWalletInEngine(7, 'test-password')).toEqual({
      opened: false,
      reason: 'no wallet file for this wallet',
    });
    expect(requests).toEqual([]);
  });

  it('refuses a session the engine did not bind to this wallet', async () => {
    mocks.invoke.mockImplementation(async (_command, args) =>
      args.request.command === 'status'
        ? { active: null, epoch: 3, wallets: [] }
        : { active: 'wallet-0011.optn', epoch: 4, legacy_source_id: null }
    );
    expect(await openWalletInEngine(7, 'test-password')).toEqual({
      opened: false,
      reason: 'Engine watch-only wallet open failed',
    });
  });
});

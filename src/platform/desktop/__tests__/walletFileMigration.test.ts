// Renaming wallet BACKUPS. A mistake here deletes someone's recovery file, so
// the migration is exercised against an in-memory filesystem rather than
// trusted to be obviously correct.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 'AppData' },
  // A directory exists when anything lives under it. Without this the wallets
  // folder reports missing, listWalletFiles returns [], and every assertion
  // below passes vacuously against a migration that never ran.
  exists: vi.fn(
    async (path: string) =>
      files.has(path) || [...files.keys()].some((f) => f.startsWith(`${path}/`))
  ),
  mkdir: vi.fn(async () => undefined),
  writeTextFile: vi.fn(async (path: string, contents: string) => {
    files.set(path, contents);
  }),
  readTextFile: vi.fn(async (path: string) => {
    const found = files.get(path);
    if (found === undefined) throw new Error(`ENOENT ${path}`);
    return found;
  }),
  readDir: vi.fn(async () =>
    [...files.keys()].map((path) => ({
      name: path.slice(path.lastIndexOf('/') + 1),
      isFile: true,
    }))
  ),
  remove: vi.fn(async (path: string) => {
    files.delete(path);
  }),
}));

import {
  migrateWalletFileNames,
  serializeWalletFile,
  WALLETS_DIR,
} from '../walletFile';

const wallet = (sourceId: number, name: string) =>
  serializeWalletFile({
    sourceId,
    name,
    walletType: 'standard',
    encryptedMnemonic: 'enc:v1:abc',
    encryptedPassphrase: '',
    kdfSalt: 'c2FsdA==',
    derivationPath: "m/44'/145'/0'",
    derivationPathSource: 'default',
  });

describe('legacy wallet backup filenames', () => {
  beforeEach(() => {
    files.clear();
  });

  it('renames wallet-<id>-<name>.optn to <name>.optn and drops the old file', async () => {
    files.set(`${WALLETS_DIR}/wallet-6-wallet_8.optn`, wallet(6, 'wallet_8'));

    expect(await migrateWalletFileNames()).toBe(1);
    expect(files.has(`${WALLETS_DIR}/wallet_8.optn`)).toBe(true);
    expect(files.has(`${WALLETS_DIR}/wallet-6-wallet_8.optn`)).toBe(false);
  });

  it('keeps the wallet readable after the rename', async () => {
    files.set(`${WALLETS_DIR}/wallet-6-wallet_8.optn`, wallet(6, 'wallet_8'));
    await migrateWalletFileNames();

    const moved = JSON.parse(files.get(`${WALLETS_DIR}/wallet_8.optn`) as string);
    expect(moved.encryptedMnemonic).toBe('enc:v1:abc');
    expect(moved.sourceId).toBe(6);
  });

  it('does not let one wallet overwrite another that shares its name', async () => {
    files.set(`${WALLETS_DIR}/wallet-6-shared.optn`, wallet(6, 'shared'));
    files.set(`${WALLETS_DIR}/wallet-7-shared.optn`, wallet(7, 'shared'));

    await migrateWalletFileNames();

    // Both wallets must survive, under distinct names.
    const remaining = [...files.entries()].map(([path, body]) => ({
      path,
      sourceId: (JSON.parse(body) as { sourceId: number }).sourceId,
    }));
    expect(new Set(remaining.map((r) => r.sourceId))).toEqual(new Set([6, 7]));
    expect(new Set(remaining.map((r) => r.path)).size).toBe(2);
  });

  it('leaves an unparseable file exactly where it is', async () => {
    // Could be the only copy of a wallet this build does not understand.
    files.set(`${WALLETS_DIR}/wallet-9-mystery.optn`, 'not json at all');

    expect(await migrateWalletFileNames()).toBe(0);
    expect(files.get(`${WALLETS_DIR}/wallet-9-mystery.optn`)).toBe('not json at all');
  });

  it('is a no-op on a folder that has already been migrated', async () => {
    files.set(`${WALLETS_DIR}/wallet_8.optn`, wallet(6, 'wallet_8'));

    expect(await migrateWalletFileNames()).toBe(0);
    expect(files.size).toBe(1);
  });
});

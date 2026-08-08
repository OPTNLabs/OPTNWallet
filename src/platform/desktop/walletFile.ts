// Electron Cash-style wallet FILES.
//
// The SQLite DB (in IndexedDB) stays the app's working store, but every wallet
// is ALSO mirrored to a real, self-contained encrypted file so users have
// something they can back up, copy between machines, and re-open — the way
// Electron Cash keeps ~/.electron-cash/wallets/<name>.
//
// Default location: <AppData>/wallets/<name>.optn (auto-saved on create/
// import). Export/Open-from-anywhere use the OS file dialog (see useMenuBar).
//
// The file is named after the WALLET, like Electron Cash. It used to be
// `wallet-<id>-<name>.optn`, where the id was the database row — an internal
// number that reads like a window number and means nothing to the person
// looking at their backups. The id was doing real work, though: it kept two
// wallets that share a name from overwriting each other's backup. That job is
// now done by checking who actually owns the file, so the name can be just the
// name.
//
// Security: the file carries the mnemonic ONLY in its already-encrypted form
// (AES-256-GCM under the wallet's own PBKDF2 password key) plus the KDF salt.
// Opening a file therefore still requires that wallet's password — the file is
// safe at rest.

import {
  writeTextFile,
  readTextFile,
  mkdir,
  readDir,
  remove,
  exists,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import { WalletType } from '../../types/wallet';

export const WALLETS_DIR = 'wallets';
export const WALLET_FILE_EXT = 'optn';

export type WalletFileNetwork = 'mainnet' | 'chipnet';

/** Wallet-file v1 only serializes encrypted mnemonic wallet material. */
export function supportsWalletFileV1Type(walletType: string): boolean {
  return (
    walletType === WalletType.STANDARD || walletType === WalletType.QUANTUMROOT
  );
}

export interface WalletFileV1 {
  format: 'optn-wallet';
  version: 1;
  /** Original DB id at export time — informational; import allocates a new id. */
  sourceId: number;
  name: string;
  walletType: string;
  /** `enc:v1:...` ciphertext exactly as stored in the DB. */
  encryptedMnemonic: string;
  /** `enc:v1:...` ciphertext exactly as stored in the DB (may be empty). */
  encryptedPassphrase: string;
  /** base64 PBKDF2 salt used to derive this wallet's key. */
  kdfSalt: string;
  /**
   * Network the wallet was on when exported. Older files omit this — import
   * then uses the app's current network instead of forcing mainnet.
   */
  network?: WalletFileNetwork;
  /** Effective BIP44 account path. Optional for files created before path persistence. */
  derivationPath?: string;
  derivationPathSource?: 'default' | 'custom';
}

/** Parse optional network field from a wallet file (null if missing/unknown). */
export function networkFromWalletFile(
  file: Pick<WalletFileV1, 'network'>
): WalletFileNetwork | null {
  if (file.network === 'mainnet' || file.network === 'chipnet') {
    return file.network;
  }
  return null;
}

export function serializeWalletFile(
  w: Omit<WalletFileV1, 'format' | 'version'>
): string {
  const file: WalletFileV1 = { format: 'optn-wallet', version: 1, ...w };
  return JSON.stringify(file, null, 2);
}

export function parseWalletFile(text: string): WalletFileV1 {
  const parsed = JSON.parse(text) as Partial<WalletFileV1>;
  if (parsed.format !== 'optn-wallet' || parsed.version !== 1) {
    throw new Error('Not a valid OPTN wallet file.');
  }
  if (
    typeof parsed.encryptedMnemonic !== 'string' ||
    typeof parsed.kdfSalt !== 'string' ||
    typeof parsed.name !== 'string'
  ) {
    throw new Error('OPTN wallet file is missing required fields.');
  }
  const network: WalletFileNetwork | undefined =
    parsed.network === 'mainnet' || parsed.network === 'chipnet'
      ? parsed.network
      : undefined;

  return {
    format: 'optn-wallet',
    version: 1,
    sourceId: typeof parsed.sourceId === 'number' ? parsed.sourceId : 0,
    name: parsed.name,
    walletType:
      typeof parsed.walletType === 'string' ? parsed.walletType : 'standard',
    encryptedMnemonic: parsed.encryptedMnemonic,
    encryptedPassphrase:
      typeof parsed.encryptedPassphrase === 'string'
        ? parsed.encryptedPassphrase
        : '',
    kdfSalt: parsed.kdfSalt,
    network,
    derivationPath:
      typeof parsed.derivationPath === 'string'
        ? parsed.derivationPath
        : undefined,
    derivationPathSource:
      parsed.derivationPathSource === 'custom' ? 'custom' : 'default',
  };
}

/** Max length of the filename stem (before `.optn`). */
const NAME_STEM_MAX = 40;

/** Sanitize a wallet name into a filename-safe fragment. */
function safeName(name: string): string {
  return (name || 'wallet')
    .replace(/[^a-zA-Z0-9-_]+/g, '_')
    .slice(0, NAME_STEM_MAX);
}

export function defaultWalletFileName(name: string): string {
  return `${safeName(name)}.${WALLET_FILE_EXT}`;
}

/**
 * Collision-safe filename that never truncates `suffix`.
 *
 * `defaultWalletFileName("long…_id7")` can chop off `_id7` because the whole
 * stem is sliced to 40 chars. Here the base name is shortened first so the
 * suffix (e.g. `_id7` or a timestamp) always survives.
 */
export function collisionWalletFileName(name: string, suffix: string): string {
  const safeSuffix = (suffix || '').replace(/[^a-zA-Z0-9-_]+/g, '_');
  if (!safeSuffix) {
    return defaultWalletFileName(name);
  }
  const baseRaw = (name || 'wallet').replace(/[^a-zA-Z0-9-_]+/g, '_');
  const maxBase = Math.max(1, NAME_STEM_MAX - safeSuffix.length);
  return `${baseRaw.slice(0, maxBase)}${safeSuffix}.${WALLET_FILE_EXT}`;
}

/** True if `rel` is free or already owned by `sourceId` (when `sourceId > 0`). */
async function pathUsableBy(
  rel: string,
  sourceId: number,
  hasOwnerId: boolean
): Promise<boolean> {
  if (!(await exists(rel, { baseDir: BaseDirectory.AppData }))) {
    return true;
  }
  if (!hasOwnerId) {
    return false;
  }
  return (await ownerOf(rel)) === sourceId;
}

/**
 * Which wallet does this file belong to, or null if it is unreadable?
 *
 * Used to tell "my own backup, overwrite it" apart from "a different wallet
 * that happens to share this name". Unreadable is deliberately NOT treated as
 * unowned: clobbering a file we cannot parse could destroy someone's only copy
 * of a wallet this build does not understand.
 */
async function ownerOf(relPath: string): Promise<number | null> {
  try {
    const text = await readTextFile(relPath, {
      baseDir: BaseDirectory.AppData,
    });
    return parseWalletFile(text).sourceId;
  } catch {
    return null;
  }
}

/**
 * Auto-save a wallet into the app's default wallets folder. Never throws to the
 * caller — a failed mirror must not fail wallet creation (the DB is the source
 * of truth). Returns the relative path on success, null on failure.
 */
export async function autoSaveWalletFile(
  w: Omit<WalletFileV1, 'format' | 'version'>
): Promise<string | null> {
  try {
    if (!(await exists(WALLETS_DIR, { baseDir: BaseDirectory.AppData }))) {
      await mkdir(WALLETS_DIR, {
        baseDir: BaseDirectory.AppData,
        recursive: true,
      });
    }
    // Take <name>.optn if free or already ours. On a real collision with a
    // *different* wallet id, use <name>_id<N>.optn (never opaque _2/_3 — those
    // looked like mysterious clones of "wallet5" after re-imports).
    // sourceId <= 0 means unknown ownership (parse default) — never treat 0 as
    // a real wallet id for overwrite/delete decisions.
    //
    // Collision suffixes are applied via collisionWalletFileName so a 40-char
    // name cannot truncate `_id<N>` / timestamp back to the original stem.
    //
    // Concurrent saves (two wallets created in parallel that share a name) can
    // both pass a free-path check then overwrite each other. Prefer
    // createNew:true when claiming a free path, re-check ownership after write,
    // and retry on a unique suffix if the race lost.
    const hasOwnerId =
      Number.isSafeInteger(w.sourceId) && (w.sourceId as number) > 0;
    const body = serializeWalletFile(w);

    const pickPath = async (attempt: number): Promise<string> => {
      if (attempt === 0) {
        const preferred = `${WALLETS_DIR}/${defaultWalletFileName(w.name)}`;
        if (await pathUsableBy(preferred, w.sourceId, hasOwnerId)) {
          return preferred;
        }
        if (hasOwnerId) {
          const idPath = `${WALLETS_DIR}/${collisionWalletFileName(
            w.name,
            `_id${w.sourceId}`
          )}`;
          if (await pathUsableBy(idPath, w.sourceId, hasOwnerId)) {
            return idPath;
          }
        }
      }
      const suffix = hasOwnerId
        ? `_id${w.sourceId}_${Date.now()}_${attempt}`
        : `_${Date.now()}_${attempt}_${Math.floor(Math.random() * 1e6)}`;
      return `${WALLETS_DIR}/${collisionWalletFileName(w.name, suffix)}`;
    };

    let rel: string | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = await pickPath(attempt);
      const existsAlready = await exists(candidate, {
        baseDir: BaseDirectory.AppData,
      });
      const overwriteOwn =
        hasOwnerId &&
        existsAlready &&
        (await ownerOf(candidate)) === w.sourceId;

      try {
        // Exclusive create when the path is free — closes the TOCTOU race.
        // Overwrite only when we already own the file (our own backup refresh).
        await writeTextFile(candidate, body, {
          baseDir: BaseDirectory.AppData,
          createNew: !overwriteOwn,
        });
      } catch {
        // createNew lost the race (path appeared between check and write).
        continue;
      }

      if (hasOwnerId) {
        const owner = await ownerOf(candidate);
        if (owner !== w.sourceId) {
          // Another writer clobbered us after create; claim a unique path.
          continue;
        }
      }

      rel = candidate;
      break;
    }

    if (!rel) {
      console.warn('[walletFile] auto-save could not claim a stable path');
      return null;
    }

    // A rename leaves the old file behind under the old name, so this wallet
    // would have two backups and the stale one would silently rot. Drop any
    // other file that claims the same wallet, keeping one file per wallet.
    // Never delete on sourceId 0 — that would wipe unrelated legacy backups.
    if (hasOwnerId) {
      for (const other of await listWalletFiles()) {
        if (other === rel) continue;
        if ((await ownerOf(other)) === w.sourceId) {
          try {
            await remove(other, { baseDir: BaseDirectory.AppData });
          } catch {
            /* leaving a stale copy is safer than failing the save */
          }
        }
      }
    }
    return rel;
  } catch (err) {
    console.warn('[walletFile] auto-save failed (DB copy is unaffected):', err);
    return null;
  }
}

/**
 * Rename legacy `wallet-<id>-<name>.optn` backups to `<name>.optn`.
 *
 * Naming the file after the wallet only changed what gets WRITTEN, and a
 * backup is written on create, on config change and on password change —
 * never on open. Without this, a wallet nobody has reconfigured keeps its old
 * name forever, so the folder still shows `wallet-6-wallet_8.optn` and the fix
 * looks like it did nothing.
 *
 * Each file is rewritten through the normal save path, so it picks up the same
 * collision handling and the same one-file-per-wallet cleanup rather than a
 * second, subtly different implementation of both.
 *
 * Returns how many files were renamed. Never throws: a backup that cannot be
 * migrated is left exactly where it is.
 */
export async function migrateWalletFileNames(): Promise<number> {
  let renamed = 0;
  try {
    for (const path of await listWalletFiles()) {
      const currentName = path.slice(path.lastIndexOf('/') + 1);
      try {
        const parsed = parseWalletFile(
          await readTextFile(path, { baseDir: BaseDirectory.AppData })
        );
        if (currentName === defaultWalletFileName(parsed.name)) continue;

        const written = await autoSaveWalletFile(parsed);
        // autoSaveWalletFile removes other files owned by this wallet, so a
        // successful write has already deleted the legacy one.
        if (written && written !== path) renamed += 1;
      } catch {
        // Unreadable or unparseable: leave it alone. It may be the only copy of
        // a wallet this build does not understand.
      }
    }
  } catch {
    /* wallets folder unavailable */
  }
  return renamed;
}

/** List wallet files currently in the default wallets folder. */
export async function listWalletFiles(): Promise<string[]> {
  try {
    if (!(await exists(WALLETS_DIR, { baseDir: BaseDirectory.AppData })))
      return [];
    const entries = await readDir(WALLETS_DIR, {
      baseDir: BaseDirectory.AppData,
    });
    return entries
      .filter((e) => e.isFile && e.name.endsWith(`.${WALLET_FILE_EXT}`))
      .map((e) => `${WALLETS_DIR}/${e.name}`);
  } catch {
    return [];
  }
}

/** Read + parse a wallet file at an absolute path (from the OS open dialog). */
export async function readWalletFileAt(
  absolutePath: string
): Promise<WalletFileV1> {
  const text = await readTextFile(absolutePath);
  return parseWalletFile(text);
}

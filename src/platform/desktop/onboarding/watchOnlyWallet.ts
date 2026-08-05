// Create and persist a watch-only wallet from an account xPub.
//
// The wallet holds public keys only: it can show a balance, do coin control and
// build a transaction, but every signature comes from an external device. There
// is no mnemonic to encrypt, so unlike every other wallet here this one has
// nothing secret at rest — which is the entire point of scanning an xPub off a
// device that never goes online.
//
// The xPub itself is stored because addresses are DERIVED from it. Without it a
// restart cannot regenerate the address set and the wallet looks empty even
// though its coins are on chain.

import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import { Network } from '../../../state/slices/networkSlice';

import {
  deriveBchAddressFromHdPublicKey,
  getBchAccountPath,
} from '../../../services/HdWalletService';
import {
  deriveWatchOnlyAccountPreview,
  watchOnlyBranchXpub,
} from './watchOnlyAccountPreview';
import { ensureDesktopWalletColumns } from '../desktopSchema';

/**
 * Wallet type string for a watch-only wallet.
 *
 * Declared here rather than added to the shared WalletType enum on purpose:
 * that file is the original author's, and this desktop feature must not force a
 * change into it. The column is TEXT, so a new value costs nothing upstream.
 */
export const WATCH_ONLY_WALLET_TYPE = 'watch-only';

/** Can this wallet produce a signature on its own? */
export function canSignLocally(walletType: string | null | undefined): boolean {
  return walletType !== WATCH_ONLY_WALLET_TYPE;
}

/**
 * Addresses derived per branch at creation.
 *
 * Electron Cash keeps a gap of 20 unused addresses so a wallet funded elsewhere
 * still finds its coins. Deriving them up front costs nothing and avoids a
 * wallet that reports zero simply because the sender used address 5.
 */
export const WATCH_ONLY_GAP_LIMIT = 20;

export interface CreateWatchOnlyWalletArgs {
  name: string;
  /** Account-level xPub, exported at m/44'/145'/account'. */
  accountXpub: string;
  network: Network;
  /**
   * Account path this xPub was exported at, e.g. m/44'/145'/0'.
   *
   * Editable for the same reason it is on a standard wallet: the device that
   * produced the xPub chose the path, and a wallet that cannot be told which
   * one shows an empty balance with no way to correct it.
   */
  accountPath?: string;
  /**
   * 8 hex characters shown on the signing device (SeedCash prints it with the
   * account xPub). Written into PSBT BIP32 derivation metadata so the signer
   * can claim the inputs. Optional at creation — the send flow will ask for it
   * again if missing.
   */
  masterFingerprint?: string;
  gapLimit?: number;
}

/** Branch 0 is receive, branch 1 is change — the standard BIP44 split. */
const BRANCHES = [0, 1] as const;

export async function createWatchOnlyWallet(
  args: CreateWatchOnlyWalletArgs
): Promise<number> {
  const name = args.name.trim();
  if (!name) throw new Error('Give the wallet a name.');

  // Validated before anything is written: this throws with a message aimed at
  // the person holding the device ("use a hardened account xPub at
  // m/44'/145'/account'") rather than leaving a half-created wallet behind.
  const preview = deriveWatchOnlyAccountPreview(args.network, args.accountXpub);
  const accountXpub = args.accountXpub.trim();
  const gapLimit = args.gapLimit ?? WATCH_ONLY_GAP_LIMIT;

  // account_xpub is a desktop-only column, added here rather than in the
  // shared migration list.
  await ensureDesktopWalletColumns();

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');

  const insertWallet = db.prepare(
    `INSERT INTO wallets
       (wallet_name, mnemonic, passphrase, networkType, walletType, balance,
        derivation_path, derivation_path_source, account_xpub, master_fingerprint)
     VALUES (?, NULL, NULL, ?, ?, 0, ?, 'default', ?, ?)`
  );
  try {
    insertWallet.run([
      name,
      args.network,
      WATCH_ONLY_WALLET_TYPE,
      args.accountPath ?? preview.accountPath ?? getBchAccountPath(args.network),
      accountXpub,
      normalizeMasterFingerprint(args.masterFingerprint),
    ]);
  } finally {
    insertWallet.free();
  }

  const idQuery = db.prepare('SELECT last_insert_rowid() AS id');
  let walletId = 0;
  try {
    if (idQuery.step()) {
      const row = idQuery.getAsObject() as Record<string, unknown>;
      walletId = Number(row.id);
    }
  } finally {
    idQuery.free();
  }
  if (!walletId) throw new Error('Could not create the watch-only wallet.');

  const insertKey = db.prepare(
    `INSERT INTO keys
       (wallet_id, public_key, private_key, address, token_address, pubkey_hash,
        account_index, change_index, address_index)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)`
  );
  try {
    for (const branch of BRANCHES) {
      const branchXpub = watchOnlyBranchXpub(accountXpub, args.network, branch);
      for (let index = 0; index < gapLimit; index += 1) {
        const derived = deriveBchAddressFromHdPublicKey(
          args.network,
          branchXpub,
          BigInt(index)
        );
        // A gap in the middle would silently shorten the watched range, so this
        // fails loudly rather than persisting a wallet that quietly misses
        // addresses.
        if (!derived) {
          throw new Error(
            `Could not derive ${branch === 0 ? 'receive' : 'change'} address ${index}.`
          );
        }
        insertKey.run([
          walletId,
          derived.publicKey,
          derived.address,
          derived.tokenAddress,
          derived.publicKeyHash,
          branch,
          index,
        ]);
      }
    }
  } finally {
    insertKey.free();
  }

  await dbService.saveDatabaseToFile(walletId);
  return walletId;
}

/** The stored xPub, or null for a wallet that is not watch-only. */
export async function watchOnlyAccountXpub(
  walletId: number
): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare(
    'SELECT account_xpub FROM wallets WHERE id = ? AND walletType = ?'
  );
  try {
    query.bind([walletId, WATCH_ONLY_WALLET_TYPE]);
    if (!query.step()) return null;
    const row = query.getAsObject() as Record<string, unknown>;
    return typeof row.account_xpub === 'string' && row.account_xpub
      ? row.account_xpub
      : null;
  } finally {
    query.free();
  }
}

const MASTER_FINGERPRINT_PATTERN = /^[0-9a-fA-F]{8}$/;

/** Accept 8 hex chars; reject anything else with a message aimed at the user. */
export function normalizeMasterFingerprint(
  value: string | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!MASTER_FINGERPRINT_PATTERN.test(trimmed)) {
    throw new Error(
      'Master fingerprint must be exactly 8 hex characters ' +
        '(e.g. 4c9a1f7b), as shown on the signing device.'
    );
  }
  return trimmed.toLowerCase();
}

/** The stored master fingerprint, or null for a wallet that has none. */
export async function watchOnlyMasterFingerprint(
  walletId: number
): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare(
    'SELECT master_fingerprint FROM wallets WHERE id = ? AND walletType = ?'
  );
  try {
    query.bind([walletId, WATCH_ONLY_WALLET_TYPE]);
    if (!query.step()) return null;
    const row = query.getAsObject() as Record<string, unknown>;
    return typeof row.master_fingerprint === 'string' && row.master_fingerprint
      ? row.master_fingerprint
      : null;
  } finally {
    query.free();
  }
}

/** 4-byte fingerprint ready for PSBT metadata, or null when unset/invalid. */
export function masterFingerprintBytes(
  fingerprint: string | null | undefined
): Uint8Array | null {
  if (!fingerprint) return null;
  const trimmed = fingerprint.trim();
  if (!MASTER_FINGERPRINT_PATTERN.test(trimmed)) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Persist the fingerprint for a watch-only wallet.
 *
 * Used by the send workspace when the user types the fingerprint for the first
 * time (it lives on the signer, so it is often only noticed when a send asks
 * for it). Validates exactly like creation does; throws on malformed input.
 */
export async function saveWatchOnlyMasterFingerprint(
  walletId: number,
  fingerprint: string
): Promise<void> {
  const normalized = normalizeMasterFingerprint(fingerprint);
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');

  const update = db.prepare(
    'UPDATE wallets SET master_fingerprint = ? WHERE id = ? AND walletType = ?'
  );
  try {
    update.run([normalized, walletId, WATCH_ONLY_WALLET_TYPE]);
  } finally {
    update.free();
  }
}

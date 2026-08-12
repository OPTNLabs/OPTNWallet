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

import {
  binToHex,
  hash160,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';

import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import { Network } from '../../../state/slices/networkSlice';
import {
  deriveMultisigAddress,
  validateMultisigPolicy,
  type MultisigPolicy,
} from '../../../services/psbt/multisigWallet';

import {
  alignHdPublicKeyNetwork,
  deriveBchAddressFromHdPublicKey,
  getBchAccountPath,
} from '../../../services/HdWalletService';
import {
  deriveWatchOnlyAccountPreview,
  watchOnlyBranchXpub,
} from './watchOnlyAccountPreview';
import {
  ensureDesktopWalletColumns,
  resetDesktopWalletColumnsCache,
} from '../desktopSchema';

/**
 * Wallet type string for a watch-only wallet.
 *
 * Declared here rather than added to the shared WalletType enum on purpose:
 * that file is the original author's, and this desktop feature must not force a
 * change into it. The column is TEXT, so a new value costs nothing upstream.
 */
export const WATCH_ONLY_WALLET_TYPE = 'watch-only';

/** Can this wallet produce a signature on its own (software keys in the app)? */
export function canSignLocally(walletType: string | null | undefined): boolean {
  // Watch-only = air-gap. Hardware = signs on USB device, not in-app keys.
  return walletType !== WATCH_ONLY_WALLET_TYPE && walletType !== 'hardware';
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

  // Dual-write keys + addresses (history scans `addresses`; UTXO uses `keys`).
  const prefix =
    args.network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
  const insertKey = db.prepare(
    `INSERT INTO keys
       (wallet_id, public_key, private_key, address, token_address, pubkey_hash,
        account_index, change_index, address_index)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)`
  );
  const insertAddr = db.prepare(
    `INSERT INTO addresses
       (wallet_id, address, balance, hd_index, change_index, prefix, token_address)
     VALUES (?, ?, 0, ?, ?, ?, ?)`
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
        insertAddr.run([
          walletId,
          derived.address,
          index,
          branch,
          prefix,
          derived.tokenAddress,
        ]);
      }
    }
  } finally {
    insertKey.free();
    insertAddr.free();
  }

  await dbService.saveDatabaseToFile(walletId);
  return walletId;
}

/**
 * Create and persist a watch-only MULTISIG wallet from a cosigner set.
 *
 * Unlike the single-signer case there is no one account xPub: every address is
 * a BIP-67 sort of all cosigners' keys derived at that exact path, so the whole
 * policy is stored and addresses are rebuilt from it. The redeem script is not
 * stored per address — it is a pure function of the policy and the path, so
 * deriving it on demand cannot drift from the address it locks.
 */
export async function createWatchOnlyMultisigWallet(args: {
  name: string;
  policy: MultisigPolicy;
  network: Network;
  gapLimit?: number;
}): Promise<number> {
  const name = args.name.trim();
  if (!name) throw new Error('Give the wallet a name.');
  validateMultisigPolicy(args.policy);

  const gapLimit = args.gapLimit ?? WATCH_ONLY_GAP_LIMIT;
  const prefix = args.network === Network.MAINNET ? 'bitcoincash' : 'bchtest';

  await ensureDesktopWalletColumns();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');

  const insertWallet = db.prepare(
    `INSERT INTO wallets
       (wallet_name, mnemonic, passphrase, networkType, walletType, balance,
        derivation_path, derivation_path_source, account_xpub,
        master_fingerprint, multisig_policy)
     VALUES (?, NULL, NULL, ?, ?, 0, ?, 'default', NULL, NULL, ?)`
  );
  try {
    insertWallet.run([
      name,
      args.network,
      WATCH_ONLY_WALLET_TYPE,
      getBchAccountPath(args.network),
      JSON.stringify({ ...args.policy, name }),
    ]);
  } finally {
    insertWallet.free();
  }

  const idQuery = db.prepare('SELECT last_insert_rowid() AS id');
  let walletId = 0;
  try {
    if (idQuery.step()) {
      walletId = Number(
        (idQuery.getAsObject() as Record<string, unknown>).id
      );
    }
  } finally {
    idQuery.free();
  }
  if (!walletId) throw new Error('Could not create the multisig wallet.');

  const insertKey = db.prepare(
    `INSERT INTO keys
       (wallet_id, public_key, private_key, address, token_address, pubkey_hash,
        account_index, change_index, address_index)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)`
  );
  try {
    for (const branch of BRANCHES) {
      for (let index = 0; index < gapLimit; index += 1) {
        const derived = deriveMultisigAddress(args.policy, branch, index);
        const encoded = lockingBytecodeToCashAddress({
          bytecode: derived.lockingBytecode,
          prefix,
        });
        if (typeof encoded === 'string' || !('address' in encoded)) {
          throw new Error(
            `Could not encode the ${branch === 0 ? 'receive' : 'change'} ` +
              `address at index ${index}.`
          );
        }
        insertKey.run([
          walletId,
          // No single public key owns a multisig address. The redeem script is
          // what a spend needs, and it is re-derived from the policy, so this
          // column carries the script hash purely for display/debugging.
          binToHex(hash160(derived.redeemScript)),
          encoded.address,
          encoded.address,
          binToHex(hash160(derived.redeemScript)),
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

/** The stored multisig policy, or null for a wallet that has none. */
export async function watchOnlyMultisigPolicy(
  walletId: number
): Promise<MultisigPolicy | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare(
    'SELECT multisig_policy FROM wallets WHERE id = ? AND walletType = ?'
  );
  try {
    query.bind([walletId, WATCH_ONLY_WALLET_TYPE]);
    if (!query.step()) return null;
    const raw = (query.getAsObject() as Record<string, unknown>).multisig_policy;
    if (typeof raw !== 'string' || !raw) return null;
    const policy = JSON.parse(raw) as MultisigPolicy;
    validateMultisigPolicy(policy);
    return policy;
  } catch {
    return null;
  } finally {
    query.free();
  }
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

/**
 * Reopen the same hardware/watch-only wallet if this xPub was already imported
 * (Electron Cash: one wallet file per keystore, not a new wallet every connect).
 */
export async function findWatchOnlyWalletByXpub(
  accountXpub: string
): Promise<number | null> {
  const xpub = accountXpub.trim();
  if (!xpub) return null;
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare(
    `SELECT id FROM wallets
     WHERE walletType = ? AND account_xpub = ?
     ORDER BY id ASC LIMIT 1`
  );
  try {
    query.bind([WATCH_ONLY_WALLET_TYPE, xpub]);
    if (!query.step()) return null;
    const row = query.getAsObject() as Record<string, unknown>;
    const id = Number(row.id);
    return Number.isFinite(id) && id > 0 ? id : null;
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
  await dbService.flushDatabaseToFile(walletId);
}

/**
 * If the watch-only wallet has an account_xpub but no (or too few) keys, rebuild
 * the gap-limit receive/change set. Empty keys → permanent zero balance even
 * though Electrum is fine (same failure mode as hardware open repair).
 *
 * Multisig watch-only stores policy instead of account_xpub; those rows are
 * left alone here (addresses are rebuilt from the policy at create time).
 */
export async function ensureWatchOnlyWalletKeys(
  walletId: number
): Promise<{ keyCount: number; rebuilt: boolean; firstReceive: string | null }> {
  resetDesktopWalletColumnsCache();
  await ensureDesktopWalletColumns();

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) {
    return { keyCount: 0, rebuilt: false, firstReceive: null };
  }

  const metaQ = db.prepare(
    `SELECT networkType, account_xpub
     FROM wallets WHERE id = ? AND walletType = ?`
  );
  let network: Network = Network.MAINNET;
  let accountXpub = '';
  try {
    metaQ.bind([walletId, WATCH_ONLY_WALLET_TYPE]);
    if (!metaQ.step()) {
      return { keyCount: 0, rebuilt: false, firstReceive: null };
    }
    const row = metaQ.getAsObject() as Record<string, unknown>;
    if (row.networkType === Network.CHIPNET) network = Network.CHIPNET;
    accountXpub =
      typeof row.account_xpub === 'string' ? row.account_xpub.trim() : '';
  } finally {
    metaQ.free();
  }

  const countQ = db.prepare(
    'SELECT COUNT(*) AS c FROM keys WHERE wallet_id = ?'
  );
  let keyCount = 0;
  try {
    countQ.bind([walletId]);
    if (countQ.step()) {
      keyCount = Number((countQ.getAsObject() as { c?: number }).c ?? 0);
    }
  } finally {
    countQ.free();
  }

  const prefixOk = network === Network.MAINNET ? 'bitcoincash:' : 'bchtest:';
  const prefixQ = db.prepare(
    `SELECT COUNT(*) AS c FROM keys
     WHERE wallet_id = ? AND address LIKE ?`
  );
  let matchingPrefix = 0;
  try {
    prefixQ.bind([walletId, `${prefixOk}%`]);
    if (prefixQ.step()) {
      matchingPrefix = Number(
        (prefixQ.getAsObject() as { c?: number }).c ?? 0
      );
    }
  } finally {
    prefixQ.free();
  }

  const expectedMin = WATCH_ONLY_GAP_LIMIT;
  const needsRebuild =
    Boolean(accountXpub) &&
    (keyCount < expectedMin || matchingPrefix < expectedMin);

  if (!needsRebuild) {
    const firstQ = db.prepare(
      `SELECT address FROM keys
       WHERE wallet_id = ? AND change_index = 0 AND address_index = 0
       LIMIT 1`
    );
    let firstReceive: string | null = null;
    try {
      firstQ.bind([walletId]);
      if (firstQ.step()) {
        const r = firstQ.getAsObject() as { address?: string };
        firstReceive = typeof r.address === 'string' ? r.address : null;
      }
    } finally {
      firstQ.free();
    }
    return { keyCount, rebuilt: false, firstReceive };
  }

  if (!accountXpub) {
    return { keyCount, rebuilt: false, firstReceive: null };
  }

  let alignedXpub: string;
  try {
    alignedXpub = alignHdPublicKeyNetwork(network, accountXpub);
  } catch (err) {
    console.error(
      `[watchOnlyWallet] wallet ${walletId} cannot align account_xpub for ${network}:`,
      err
    );
    return { keyCount, rebuilt: false, firstReceive: null };
  }
  if (alignedXpub !== accountXpub) {
    console.warn(
      `[watchOnlyWallet] wallet ${walletId} account_xpub version bytes aligned ` +
        `${accountXpub.slice(0, 4)}… → ${alignedXpub.slice(0, 4)}… for ${network}`
    );
    try {
      db.run('UPDATE wallets SET account_xpub = ? WHERE id = ?', [
        alignedXpub,
        walletId,
      ]);
    } catch {
      /* column present after ensureDesktopWalletColumns */
    }
    accountXpub = alignedXpub;
  }

  console.warn(
    `[watchOnlyWallet] wallet ${walletId} keys=${keyCount} matchingPrefix=${matchingPrefix} network=${network}; rebuilding from account_xpub`
  );
  db.run('DELETE FROM UTXOs WHERE wallet_id = ?', [walletId]);
  db.run('DELETE FROM addresses WHERE wallet_id = ?', [walletId]);
  db.run('DELETE FROM keys WHERE wallet_id = ?', [walletId]);
  keyCount = 0;

  let preview;
  try {
    preview = deriveWatchOnlyAccountPreview(network, accountXpub);
  } catch (err) {
    console.error(
      `[watchOnlyWallet] wallet ${walletId} rebuild preview failed:`,
      err
    );
    return { keyCount: 0, rebuilt: false, firstReceive: null };
  }

  const prefix = network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
  const insertKey = db.prepare(
    `INSERT OR IGNORE INTO keys
       (wallet_id, public_key, private_key, address, token_address, pubkey_hash,
        account_index, change_index, address_index)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)`
  );
  const insertAddr = db.prepare(
    `INSERT OR IGNORE INTO addresses
       (wallet_id, address, balance, hd_index, change_index, prefix, token_address)
     VALUES (?, ?, 0, ?, ?, ?, ?)`
  );
  let added = 0;
  try {
    for (const branch of BRANCHES) {
      const branchXpub = watchOnlyBranchXpub(accountXpub, network, branch);
      for (let index = 0; index < WATCH_ONLY_GAP_LIMIT; index += 1) {
        const derived = deriveBchAddressFromHdPublicKey(
          network,
          branchXpub,
          BigInt(index)
        );
        if (!derived) continue;
        insertKey.run([
          walletId,
          derived.publicKey,
          derived.address,
          derived.tokenAddress,
          derived.publicKeyHash,
          branch,
          index,
        ]);
        insertAddr.run([
          walletId,
          derived.address,
          index,
          branch,
          prefix,
          derived.tokenAddress,
        ]);
        added += 1;
      }
    }
  } finally {
    insertKey.free();
    insertAddr.free();
  }
  if (added > 0) {
    await dbService.flushDatabaseToFile(walletId);
  }

  console.info(
    `[watchOnlyWallet] wallet ${walletId} rebuilt ${added} keys; firstReceive=${preview.receive.address} path=${preview.receive.path}`
  );

  return {
    keyCount: keyCount + added,
    rebuilt: added > 0,
    firstReceive: preview.receive.address,
  };
}

/**
 * Backfill `addresses` rows from `keys` for watch-only wallets created before
 * dual-write (or multisig rows that only wrote keys). Safe on every open.
 */
export async function ensureWatchOnlyWalletAddresses(
  walletId: number
): Promise<number> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return 0;

  const meta = db.prepare(
    'SELECT networkType FROM wallets WHERE id = ? AND walletType = ?'
  );
  let network: Network = Network.MAINNET;
  try {
    meta.bind([walletId, WATCH_ONLY_WALLET_TYPE]);
    if (!meta.step()) return 0;
    const row = meta.getAsObject() as Record<string, unknown>;
    if (row.networkType === Network.CHIPNET) network = Network.CHIPNET;
  } finally {
    meta.free();
  }
  const prefix = network === Network.MAINNET ? 'bitcoincash' : 'bchtest';

  const missing = db.prepare(`
    SELECT k.address, k.token_address, k.address_index, k.change_index
    FROM keys k
    LEFT JOIN addresses a ON a.address = k.address
    WHERE k.wallet_id = ? AND a.id IS NULL AND k.address IS NOT NULL
  `);
  const insertAddr = db.prepare(
    `INSERT OR IGNORE INTO addresses
       (wallet_id, address, balance, hd_index, change_index, prefix, token_address)
     VALUES (?, ?, 0, ?, ?, ?, ?)`
  );
  let added = 0;
  try {
    missing.bind([walletId]);
    while (missing.step()) {
      const row = missing.getAsObject() as Record<string, unknown>;
      const address = typeof row.address === 'string' ? row.address : null;
      if (!address) continue;
      insertAddr.run([
        walletId,
        address,
        Number(row.address_index ?? 0),
        Number(row.change_index ?? 0),
        prefix,
        typeof row.token_address === 'string' ? row.token_address : null,
      ]);
      added += 1;
    }
  } finally {
    missing.free();
    insertAddr.free();
  }
  if (added > 0) {
    await dbService.flushDatabaseToFile(walletId);
  }
  return added;
}

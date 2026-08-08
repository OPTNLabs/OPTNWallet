/**
 * Desktop hardware wallets (Ledger / Trezor / OneKey) — Electron Cash model.
 *
 * Electron Cash Hardware_KeyStore.dump():
 *   { type: 'hardware', hw_type: 'ledger'|'trezor', xpub, derivation, label }
 * Signing: keystore.sign_transaction → device plugin (NOT air-gap / PSBT).
 *
 * NOT watch-only:
 * - Watch-only = air-gap / xPub paste / PSBT-QR (SeedCash, Keystone).
 * - Hardware = USB device signs live; walletType = "hardware", hw_type = plugin id.
 *
 * Account xPub is stored only so we can derive addresses + plan spends offline;
 * the private key never leaves the device (EC same).
 */

import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import { Network } from '../../../state/slices/networkSlice';
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

/** Desktop-only walletType TEXT — matches EC keystore dump type: 'hardware'. */
export const HARDWARE_WALLET_TYPE = 'hardware';

export const HARDWARE_GAP_LIMIT = 20;

const BRANCHES = [0, 1] as const;

/** EC `hw_type` on Hardware_KeyStore (ledger plugin, trezor plugin, …). */
export type HardwareDeviceKind = 'ledger' | 'trezor' | 'onekey';

export type CreateHardwareWalletArgs = {
  name: string;
  accountXpub: string;
  network: Network;
  accountPath?: string;
  /** EC hw_type — which device plugin signs. */
  deviceKind: HardwareDeviceKind;
  /** Optional label from the device (EC keystore.label). */
  deviceLabel?: string;
  gapLimit?: number;
};

export function isHardwareWalletType(
  walletType: string | null | undefined
): boolean {
  return walletType === HARDWARE_WALLET_TYPE;
}

export function parseHardwareHwType(
  raw: unknown
): HardwareDeviceKind {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'trezor' || s === 'onekey' || s === 'ledger') return s;
  return 'ledger';
}

/**
 * Create a hardware keystore wallet: public keys only, type=hardware.
 * Caller must password-protect via protectHardwareWalletWithPassword.
 *
 * Storage mirrors EC Hardware_KeyStore.dump (type + hw_type + xpub + derivation).
 */
export async function createHardwareWallet(
  args: CreateHardwareWalletArgs
): Promise<number> {
  const name = args.name.trim();
  if (!name) throw new Error('Give the wallet a name.');

  // Account-xPub shape check only (depth-3 hardened). Same BIP32 rules as
  // watch-only observers — not the same product.
  // Align tpub↔xpub version bytes to the wallet network (Trezor may export
  // tpub after a chipnet session while the wallet is mainnet).
  const accountXpub = alignHdPublicKeyNetwork(
    args.network,
    args.accountXpub.trim()
  );
  const preview = deriveWatchOnlyAccountPreview(args.network, accountXpub);
  const gapLimit = args.gapLimit ?? HARDWARE_GAP_LIMIT;
  const accountPath =
    args.accountPath ?? preview.accountPath ?? getBchAccountPath(args.network);
  const hwType = parseHardwareHwType(args.deviceKind);

  // New installs may have run an older ensure without hw_type — force re-scan.
  resetDesktopWalletColumnsCache();
  await ensureDesktopWalletColumns();

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');

  // EC: type=hardware, hw_type=ledger|trezor, xpub, derivation — never
  // master_fingerprint (that is watch-only / PSBT metadata only).
  const insertWallet = db.prepare(
    `INSERT INTO wallets
       (wallet_name, mnemonic, passphrase, networkType, walletType, balance,
        derivation_path, derivation_path_source, account_xpub, hw_type)
     VALUES (?, NULL, NULL, ?, ?, 0, ?, 'default', ?, ?)`
  );
  try {
    insertWallet.run([
      name,
      args.network,
      HARDWARE_WALLET_TYPE,
      accountPath,
      accountXpub,
      hwType,
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
  if (!walletId) throw new Error('Could not create the hardware wallet.');

  // Same dual write as KeyManager.createKeys: UTXO path reads `keys`, history
  // path reads `addresses`. Hardware create used to only fill `keys` → empty
  // history and broken Recent Activity.
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

  await dbService.flushDatabaseToFile(walletId);

  // Prove keys landed (empty keys = silent zero balance forever).
  const verify = db.prepare(
    'SELECT COUNT(*) AS c FROM keys WHERE wallet_id = ?'
  );
  try {
    verify.bind([walletId]);
    verify.step();
    const c = Number((verify.getAsObject() as { c?: number }).c ?? 0);
    if (c < HARDWARE_GAP_LIMIT) {
      throw new Error(
        `Hardware wallet created with only ${c} keys (expected ${HARDWARE_GAP_LIMIT * 2}). ` +
          'Address derivation from the device xPub failed — check network matches mainnet xpub.'
      );
    }
  } finally {
    verify.free();
  }

  return walletId;
}

export async function findHardwareWalletByXpub(
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
    query.bind([HARDWARE_WALLET_TYPE, xpub]);
    if (!query.step()) return null;
    const row = query.getAsObject() as Record<string, unknown>;
    const id = Number(row.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } finally {
    query.free();
  }
}

/**
 * If the wallet has an account_xpub but no (or too few) keys, rebuild the
 * gap-limit receive/change address set. Empty keys → permanent zero balance
 * even though Electrum is fine.
 */
export async function ensureHardwareWalletKeys(
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
    `SELECT networkType, account_xpub, derivation_path
     FROM wallets WHERE id = ? AND walletType = ?`
  );
  let network: Network = Network.MAINNET;
  let accountXpub = '';
  try {
    metaQ.bind([walletId, HARDWARE_WALLET_TYPE]);
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
      keyCount = Number(
        (countQ.getAsObject() as { c?: number }).c ?? 0
      );
    }
  } finally {
    countQ.free();
  }

  // Wrong network prefix (e.g. purge left nothing usable, or keys are bchtest
  // while wallet is mainnet) also forces rebuild.
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

  const expectedMin = HARDWARE_GAP_LIMIT; // at least one full receive gap
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
        firstReceive =
          typeof r.address === 'string' ? r.address : null;
      }
    } finally {
      firstQ.free();
    }
    return { keyCount, rebuilt: false, firstReceive };
  }

  if (!accountXpub) {
    return { keyCount, rebuilt: false, firstReceive: null };
  }

  // Align tpub/xpub to wallet network before rebuild (silent failure before:
  // mainnet wallet + tpub from Trezor chipnet export → permanent 0 balance).
  let alignedXpub: string;
  try {
    alignedXpub = alignHdPublicKeyNetwork(network, accountXpub);
  } catch (err) {
    console.error(
      `[hardwareWallet] wallet ${walletId} cannot align account_xpub for ${network}:`,
      err
    );
    return { keyCount, rebuilt: false, firstReceive: null };
  }
  if (alignedXpub !== accountXpub) {
    console.warn(
      `[hardwareWallet] wallet ${walletId} account_xpub version bytes aligned ` +
        `${accountXpub.slice(0, 4)}… → ${alignedXpub.slice(0, 4)}… for ${network}`
    );
    try {
      db.run('UPDATE wallets SET account_xpub = ? WHERE id = ?', [
        alignedXpub,
        walletId,
      ]);
    } catch {
      /* column always present after ensureDesktopWalletColumns */
    }
    accountXpub = alignedXpub;
  }

  // Drop wrong-network / partial keys so INSERT OR IGNORE cannot leave gaps.
  console.warn(
    `[hardwareWallet] wallet ${walletId} keys=${keyCount} matchingPrefix=${matchingPrefix} network=${network}; rebuilding from account_xpub`
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
      `[hardwareWallet] wallet ${walletId} rebuild preview failed:`,
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
      for (let index = 0; index < HARDWARE_GAP_LIMIT; index += 1) {
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
    `[hardwareWallet] wallet ${walletId} rebuilt ${added} keys; firstReceive=${preview.receive.address} path=${preview.receive.path}`
  );

  return {
    keyCount: keyCount + added,
    rebuilt: added > 0,
    firstReceive: preview.receive.address,
  };
}

/**
 * Backfill `addresses` rows from `keys` for wallets created before dual-write.
 * Safe to call on every open (no-op when already in sync).
 */
export async function ensureHardwareWalletAddresses(
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
    meta.bind([walletId, HARDWARE_WALLET_TYPE]);
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
      const address = String(row.address ?? '');
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

export async function hardwareWalletAccountXpub(
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
    query.bind([walletId, HARDWARE_WALLET_TYPE]);
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
 * Read EC-style hardware keystore fields for this wallet.
 * Ensures desktop columns exist first (fixes "no such column" on older DBs).
 */
export async function readHardwareKeystore(walletId: number): Promise<{
  accountPath: string;
  accountXpub: string | null;
  /** EC hw_type — device plugin that signs. */
  hwType: HardwareDeviceKind;
  network: 'mainnet' | 'chipnet';
}> {
  resetDesktopWalletColumnsCache();
  await ensureDesktopWalletColumns();

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Database unavailable');

  // Prefer EC hw_type. Older builds wrongly stuffed device kind into
  // master_fingerprint (watch-only column) — accept that once for migration.
  const q = db.prepare(
    `SELECT derivation_path, account_xpub, hw_type, walletType, networkType,
            master_fingerprint
     FROM wallets WHERE id = ?`
  );
  try {
    q.bind([walletId]);
    if (!q.step()) throw new Error('Wallet not found');
    const row = q.getAsObject() as Record<string, unknown>;
    if (row.walletType !== HARDWARE_WALLET_TYPE) {
      throw new Error('Not a hardware wallet (walletType must be hardware).');
    }
    // Fall back to the network default, never a hardcoded mainnet literal. The
    // wallet, Quantumroot and the hardware signer must all resolve the same
    // account path; a literal here would ask a chipnet device to sign under
    // coin type 145 while the wallet derives under the network default, and the
    // device would return a key the wallet does not own. The DatabaseService
    // migration backfills derivation_path, so this should only fire for a row
    // written outside that path.
    const rowNetwork =
      row.networkType === Network.CHIPNET ? Network.CHIPNET : Network.MAINNET;
    const accountPath =
      typeof row.derivation_path === 'string' && row.derivation_path
        ? row.derivation_path
        : getBchAccountPath(rowNetwork);
    let hwType = parseHardwareHwType(row.hw_type);
    // Migrate: previous hack stored ledger|trezor|onekey in master_fingerprint
    if (
      !row.hw_type &&
      typeof row.master_fingerprint === 'string' &&
      /^(ledger|trezor|onekey)$/i.test(row.master_fingerprint)
    ) {
      hwType = parseHardwareHwType(row.master_fingerprint);
    }
    // Persist EC hw_type if missing so sign path stays self-contained.
    if (!row.hw_type) {
      const upd = db.prepare('UPDATE wallets SET hw_type = ? WHERE id = ?');
      try {
        upd.run([hwType, walletId]);
      } finally {
        upd.free();
      }
    }

    const nt = String(row.networkType ?? 'mainnet').toLowerCase();
    const network: 'mainnet' | 'chipnet' =
      nt.includes('chip') || nt.includes('test') ? 'chipnet' : 'mainnet';
    const accountXpub =
      typeof row.account_xpub === 'string' && row.account_xpub
        ? row.account_xpub
        : null;
    return { accountPath, accountXpub, hwType, network };
  } finally {
    q.free();
  }
}

// Desktop-only per-wallet key management (Electron Cash model): each wallet
// gets its own password and its own derived AES-256-GCM key, independent of
// any other wallet. This wraps the shared WalletManager()/KeyManager() —
// it never changes their call signatures, it only controls which key is
// active in WalletKeyCache before calling into them, so every existing
// SecretCryptoService.encryptText/decryptText/encryptBytes/decryptBytes call
// site (KeyManager.createKeys, fetchAddressPrivateKey, etc.) automatically
// operates under the correct wallet's key with zero changes to shared code.
//
// Legacy wallets created before this feature existed have no kdf_salt row —
// those fall back to whatever key is already active (the app-gate's key),
// preserving today's behavior for anything created earlier this session.

import WalletManager from '../../apis/WalletManager/WalletManager';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import QuantumrootVaultCacheService from '../../services/QuantumrootVaultCacheService';
import { Network } from '../../state/slices/networkSlice';
import { WalletType, type DerivationPathSource } from '../../types/wallet';
import type { WalletMetadata } from '../../types/wallet';
import {
  deriveKey,
  randomSalt,
  bytesToBase64,
  base64ToBytes,
  aesEncrypt,
  aesDecrypt,
} from './WalletCrypto';
import {
  setCachedPassword,
  getCachedPasswordSnapshot,
  clearCachedPassword,
  isCached,
} from './WalletKeyCache';
import {
  unlock as unlockGatePassphrase,
  verify as verifyGatePassphrase,
} from './EcKeyManager';
import { SECRET_ENC_PREFIX } from './SecretCryptoService';
import { getBchAccountPath } from '../../services/HdWalletService';
import {
  autoSaveWalletFile,
  parseWalletFile,
  type WalletFileV1,
} from './walletFile';
import { log } from './logger';
import {
  checkStatus as bioCheckStatus,
  setData as bioSetData,
  getData as bioGetData,
  hasData as bioHasData,
  removeData as bioRemoveData,
} from '@choochmeque/tauri-plugin-biometry-api';

const BIO_DOMAIN = 'com.optilabs.wallet';
const bioName = (walletId: number) => `optn-wallet-bio-${walletId}`;
const NETWORK_CLEANUP_VERSION = 1;

async function readKdfSalt(walletId: number): Promise<Uint8Array | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare('SELECT kdf_salt FROM wallets WHERE id = ?');
  query.bind([walletId]);
  let saltB64: string | null = null;
  if (query.step()) {
    const row = query.getAsObject() as Record<string, unknown>;
    saltB64 =
      typeof row.kdf_salt === 'string' && row.kdf_salt ? row.kdf_salt : null;
  }
  query.free();
  return saltB64 ? base64ToBytes(saltB64) : null;
}

// Id of the most recently inserted wallet with this name. Used instead of
// WalletManager.setWalletId(), which finds the id by decrypting EVERY wallet
// row with the currently-cached key — that throws (and returns null) as soon
// as any other wallet was encrypted under a different per-wallet key, which
// silently skipped the kdf_salt write and made new wallets fall back to the
// old app-gate password. Matching by name + newest id needs no decryption.
async function findNewestWalletIdByName(name: string): Promise<number | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare(
    'SELECT id FROM wallets WHERE wallet_name = ? ORDER BY id DESC LIMIT 1'
  );
  query.bind([name]);
  let id: number | null = null;
  if (query.step()) {
    const row = query.getAsObject() as Record<string, unknown>;
    id = typeof row.id === 'number' ? row.id : Number(row.id);
  }
  query.free();
  return Number.isFinite(id as number) ? id : null;
}

async function writeKdfSalt(walletId: number, salt: Uint8Array): Promise<void> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Database unavailable');

  const query = db.prepare('UPDATE wallets SET kdf_salt = ? WHERE id = ?');
  query.run([bytesToBase64(salt), walletId]);
  query.free();
  await dbService.flushDatabaseToFile(walletId);
}

export interface CreateWalletWithPasswordArgs {
  name: string;
  mnemonic: string;
  passphrase: string;
  network: Network;
  walletType?: WalletType;
  derivationPath?: string;
  derivationPathSource?: DerivationPathSource;
  password: string;
}

/**
 * Create a wallet whose mnemonic/passphrase are encrypted under a key derived
 * from `password` + a fresh per-wallet salt — not whatever key the app-gate
 * currently has cached. Returns the new wallet's id, or null on failure.
 */
export async function createWalletWithPassword(
  args: CreateWalletWithPasswordArgs
): Promise<number | null> {
  const {
    name,
    mnemonic,
    passphrase,
    network,
    password,
    derivationPath,
    derivationPathSource,
  } = args;
  const walletType = args.walletType ?? WalletType.STANDARD;
  const resolvedDerivationPath = derivationPath ?? getBchAccountPath(network);
  const resolvedDerivationPathSource = derivationPathSource ?? 'default';
  const manager = WalletManager();

  const salt = randomSalt(32);

  // Activate this wallet's credentials BEFORE createWallet's internal
  // SecretCryptoService.encryptText() calls run, so the mnemonic/passphrase
  // are encrypted under it, not the previously-active credentials. Snapshot
  // the previous credentials first: every failure exit below must restore
  // them, or a failed creation leaves foreign credentials active while
  // another wallet is open.
  const previousSnapshot = getCachedPasswordSnapshot();
  const restorePrevious = () => {
    if (previousSnapshot) {
      setCachedPassword(previousSnapshot.password, previousSnapshot.salt, previousSnapshot.ownerWalletId);
    } else clearCachedPassword();
  };
  setCachedPassword(password, salt);

  let walletId: number | null;
  try {
    const created = await manager.createWallet(
      name,
      mnemonic,
      passphrase,
      network,
      walletType,
      resolvedDerivationPath,
      resolvedDerivationPathSource
    );
    if (!created) {
      restorePrevious();
      return null;
    }

    walletId = await findNewestWalletIdByName(name);
    if (walletId == null) {
      restorePrevious();
      return null;
    }
  } catch (error) {
    // `createWallet` and the ID lookup are both allowed to throw. Never leave
    // their provisional, unowned credentials active in either case.
    restorePrevious();
    throw error;
  }
  setCachedPassword(password, salt, walletId);

  try {
    await writeKdfSalt(walletId, salt);
  } catch (err) {
    // Without its salt row this wallet can never be reopened (it would be
    // treated as legacy and checked against the gate key). Surface loudly.
    console.error(
      `[DesktopWalletManager] CRITICAL: wallet ${walletId} was created but its kdf_salt could not be written — it will not be openable. Delete and recreate it.`,
      err
    );
    restorePrevious();
    return null;
  }

  // Record the chain tip as this wallet's birth height: it cannot hold coins
  // from before it existed, so a BIP37 node only has to scan birth..tip rather
  // than the whole chain (one merkleblock round-trip per block). Best-effort —
  // if the tip isn't known the node scan falls back to a recent window.
  await recordBirthHeight(walletId);

  // Auto-mirror the wallet to a file in the default wallets folder (EC-style).
  // Encrypt under this wallet's own key so the file is safe at rest and can be
  // re-opened with the same password. Non-fatal: the DB row is the source of
  // truth, so a failed file write must not fail creation.
  try {
    const fileKey = await deriveKey(password, salt);
    const encryptedMnemonic = `${SECRET_ENC_PREFIX}${await aesEncrypt(fileKey, mnemonic)}`;
    const encryptedPassphrase = passphrase
      ? `${SECRET_ENC_PREFIX}${await aesEncrypt(fileKey, passphrase)}`
      : '';
    await autoSaveWalletFile({
      sourceId: walletId,
      name,
      walletType,
      encryptedMnemonic,
      encryptedPassphrase,
      kdfSalt: bytesToBase64(salt),
      derivationPath: resolvedDerivationPath,
      derivationPathSource: resolvedDerivationPathSource,
    });
  } catch (err) {
    console.warn(
      '[DesktopWalletManager] wallet file mirror failed (DB copy is fine):',
      err
    );
  }

  return walletId;
}

/**
 * Store the current chain tip as `walletId`'s birth height. Called on creation;
 * a wallet can't have coins older than itself, so a BIP37 scan starts here.
 * Best-effort: a failure just means the node scan uses its recent-window
 * fallback instead of full history.
 */
async function recordBirthHeight(walletId: number): Promise<void> {
  try {
    const { default: ElectrumService } = await import(
      '../../services/ElectrumService'
    );
    const tip = (await ElectrumService.getLatestBlock()) as {
      height?: unknown;
    } | null;
    const height = tip?.height;
    if (typeof height !== 'number' || height <= 0) return;
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) return;
    db.run('UPDATE wallets SET birth_height = ? WHERE id = ?', [
      height,
      walletId,
    ]);
    await dbService.flushDatabaseToFile(walletId);
  } catch {
    /* best effort */
  }
}

/**
 * The chain height when this wallet was created, or null if unknown (wallets
 * made before birth-height tracking, or when the tip couldn't be read).
 */
export async function getBirthHeight(walletId: number): Promise<number | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  const q = db.prepare('SELECT birth_height FROM wallets WHERE id = ?');
  q.bind([walletId]);
  let height: number | null = null;
  if (q.step()) {
    const row = q.getAsObject() as { birth_height?: unknown };
    height =
      typeof row.birth_height === 'number' && row.birth_height > 0
        ? row.birth_height
        : null;
  }
  q.free();
  return height;
}

/**
 * Switch an OPEN wallet to another network IN PLACE (Cashonize model): a seed
 * works on every network, so the SAME wallet is repointed at `target` — its
 * network is updated and its old-network-derived keys/addresses/UTXOs are
 * dropped and regenerated under the new network's prefix. The caller then
 * reloads the wallet view and reconnects to the target network's servers. No
 * new wallet row is created; the picker still shows one wallet per seed.
 */
export async function switchWalletNetwork(
  walletId: number,
  target: Network
): Promise<void> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db || walletId <= 0) return;

  await log.info(
    'NetworkSwitch',
    `wallet=${walletId} target=${target} status=start`
  );

  // Preserve address depth across the toggle: regenerate at least as many
  // address indices as the wallet already had (each index = receive+change =
  // 2 keys), so funds on a later address aren't hidden after switching back.
  let indices = 20;
  try {
    const cnt = db.prepare(
      'SELECT COUNT(*) AS c FROM keys WHERE wallet_id = ?'
    );
    cnt.bind([walletId]);
    if (cnt.step())
      indices = Math.max(
        20,
        Math.ceil(Number((cnt.getAsObject() as { c: unknown }).c ?? 0) / 2)
      );
    cnt.free();
  } catch {
    /* default 20 */
  }

  // Birth height is a height on the OLD chain — meaningless on the new one, and
  // wrong to reuse (heights differ per chain). Clear it: the node scan then uses
  // its recent-window fallback until this wallet's birth on this chain is known.
  db.run(
    'UPDATE wallets SET networkType = ?, birth_height = NULL WHERE id = ?',
    [target, walletId]
  );
  // Everything below is derived from the OLD network and must not survive the
  // switch. Upstream's reads (KeyManager.retrieveKeys, UTXOManager.*) are NOT
  // network-scoped — they're only correct while the DB holds exactly one
  // network's data — and those files are zero-touch, so we can't scope them.
  // The invariant is therefore maintained here: after a switch the DB contains
  // only the target network's rows. Nothing is lost permanently — histories and
  // UTXOs live on-chain and re-sync from the new network's servers; switching
  // back re-derives and re-fetches the other chain's data.
  db.run('DELETE FROM keys WHERE wallet_id = ?', [walletId]);
  try {
    db.run('DELETE FROM addresses WHERE wallet_id = ?', [walletId]);
  } catch {
    /* optional table */
  }
  try {
    db.run('DELETE FROM UTXOs WHERE wallet_id = ?', [walletId]);
  } catch {
    /* optional table */
  }
  try {
    db.run('DELETE FROM transactions WHERE wallet_id = ?', [walletId]);
  } catch {
    /* optional table */
  }
  try {
    db.run('DELETE FROM transaction_details WHERE wallet_id = ?', [walletId]);
  } catch {
    /* optional table */
  }
  // Contract-derived addresses (P2SH32, "bitcoincash:p…"/"bchtest:p…") were the
  // real leak: switchWalletNetwork used to skip these tables, so old-network
  // quantumroot vaults and cashscript addresses lingered and kept getting
  // subscribed on the new chain — the server rejects the wrong-prefix address
  // and drops the connection, taking every valid query down with it. Clear them
  // too so the single-network invariant actually holds.
  try {
    db.run('DELETE FROM cashscript_addresses WHERE wallet_id = ?', [walletId]);
  } catch {
    /* optional table */
  }
  try {
    db.run('DELETE FROM quantumroot_vaults WHERE wallet_id = ?', [walletId]);
  } catch {
    /* optional table */
  }
  // instantiated_contracts is a global cache shared by every wallet. Never
  // delete another wallet's entries during a single-wallet network switch;
  // the worker scopes contract reads through cashscript_addresses instead.
  // The vault cache is in memory and survives the DB deletes above — if we don't
  // drop it, retrieveQuantumrootVaults keeps serving the OLD network's vault
  // addresses (a non-empty cache short-circuits the DB read), which then get
  // subscribed on the new chain. This is why toggling network alone never
  // cleared them. Clearing the cache makes the next read re-derive under the
  // now-updated networkType.
  QuantumrootVaultCacheService.clear(walletId);
  dbService.scheduleDatabaseSave();
  await dbService.flushDatabaseToFile(walletId);

  // Regenerate the address batch. KeyService reads the wallet's (now-updated)
  // networkType, so these derive under `target`'s prefix.
  const { default: KeyService } = await import('../../services/KeyService');
  await KeyService.bootstrapInitialAddressBatch(walletId, 0, indices);
  dbService.scheduleDatabaseSave();
  await dbService.flushDatabaseToFile(walletId);
  await log.info(
    'NetworkSwitch',
    `wallet=${walletId} target=${target} cacheCleared=true addressIndices=${indices} status=complete`
  );
}

/**
 * Open an existing wallet: derive its key from `password` + its stored salt,
 * activate it, and return the decrypted wallet record. Returns null if the
 * password is wrong (decrypt fails) or the wallet doesn't exist.
 *
 * Legacy wallets with no kdf_salt (created before per-wallet passwords
 * existed) skip re-derivation entirely and use whatever key is already
 * active — preserving today's behavior for those wallets.
 */
/**
 * Remove rows whose address belongs to a DIFFERENT network than `network`.
 *
 * switchWalletNetwork keeps the DB single-network going forward, but a wallet
 * created/switched before that fix can still hold stale cross-network rows —
 * most visibly old-network quantumroot vaults and cashscript contract addresses.
 * Upstream reads (KeyManager/UTXOManager/QuantumrootTrackingService) are not
 * network-scoped and are zero-touch, so those stale rows get gathered and sent,
 * and the ElectrumServerRouter guard rejects each one: harmless but a flood of
 * error-level log lines. Purging on open makes the guard a backstop, not the
 * everyday path. A CashAddr names its network in its prefix, so the filter is
 * exact and local.
 */
export async function purgeCrossNetworkData(
  walletId: number,
  network: Network
): Promise<void> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db || walletId <= 0) return;

  // This is a legacy repair, not normal wallet-open work. Once it has run for
  // the wallet's current network, only the in-memory cache needs clearing.
  // A network switch changes the stored network and therefore naturally makes
  // the marker stale, without another state store or timer.
  try {
    const marker = db.prepare(
      `SELECT network_cleanup_version, network_cleanup_network
       FROM wallets WHERE id = ?`
    );
    marker.bind([walletId]);
    const current = marker.step()
      ? (marker.getAsObject() as Record<string, unknown>)
      : null;
    marker.free();
    if (
      Number(current?.network_cleanup_version ?? 0) >=
        NETWORK_CLEANUP_VERSION &&
      current?.network_cleanup_network === network
    ) {
      QuantumrootVaultCacheService.clear(walletId);
      return;
    }
  } catch {
    // The migration may not exist in an unusual test/legacy database yet.
    // Run the safety cleanup and let the marker write below surface only if the
    // database genuinely cannot support the current schema.
  }

  const keep = network === Network.MAINNET ? 'bitcoincash:%' : 'bchtest:%';
  let removed = 0;
  const del = (sql: string, params: (string | number)[]) => {
    db.run(sql, params);
    removed += db.getRowsModified();
  };
  del(
    'DELETE FROM keys WHERE wallet_id = ? AND address IS NOT NULL AND address NOT LIKE ?',
    [walletId, keep]
  );
  del(
    'DELETE FROM addresses WHERE wallet_id = ? AND address IS NOT NULL AND address NOT LIKE ?',
    [walletId, keep]
  );
  del(
    'DELETE FROM UTXOs WHERE wallet_id = ? AND address IS NOT NULL AND address NOT LIKE ?',
    [walletId, keep]
  );
  del(
    'DELETE FROM cashscript_addresses WHERE wallet_id = ? AND address IS NOT NULL AND address NOT LIKE ?',
    [walletId, keep]
  );
  del(
    'DELETE FROM quantumroot_vaults WHERE wallet_id = ? AND (receive_address NOT LIKE ? OR quantum_lock_address NOT LIKE ?)',
    [walletId, keep, keep]
  );
  // instantiated_contracts is global. The active-wallet association table was
  // cleaned above; deleting the global row here could damage another wallet.

  // Drop the in-memory vault cache too, or retrieveQuantumrootVaults keeps
  // serving the cached cross-network addresses regardless of the DB purge.
  QuantumrootVaultCacheService.clear(walletId);

  db.run(
    `UPDATE wallets
       SET network_cleanup_version = ?, network_cleanup_network = ?
       WHERE id = ?`,
    [NETWORK_CLEANUP_VERSION, network, walletId]
  );
  // Persist the marker even when the repair found nothing. Otherwise the zero-
  // row case—the common case in the logs—would still repeat on every unlock.
  dbService.scheduleDatabaseSave();
  await dbService.flushDatabaseToFile(walletId);
  await log.info(
    'NetworkPurge',
    `wallet=${walletId} target=${network} cacheCleared=true rowsRemoved=${removed} status=complete`
  );
}

export async function openWalletWithPassword(
  walletId: number,
  password: string
): Promise<WalletMetadata | null> {
  const manager = WalletManager();
  const previousSnapshot = getCachedPasswordSnapshot();
  const restorePrevious = () => {
    if (previousSnapshot) {
      setCachedPassword(previousSnapshot.password, previousSnapshot.salt, previousSnapshot.ownerWalletId);
    } else {
      clearCachedPassword();
    }
  };
  const salt = await readKdfSalt(walletId);

  if (salt) {
    // Verify-then-commit: prove the candidate password decrypts this wallet's
    // own mnemonic BEFORE touching the shared cache. Activating unverified
    // credentials would clobber the currently-open wallet's data on a mere typo.
    const candidateKey = await deriveKey(password, salt);
    const mnemonicCiphertext = await readMnemonicCiphertext(walletId);
    if (!mnemonicCiphertext?.startsWith(SECRET_ENC_PREFIX)) {
      console.warn(
        `[DesktopWalletManager] Wallet ${walletId} has kdf_salt but no encrypted mnemonic — refusing to open.`
      );
      return null;
    }
    try {
      await aesDecrypt(
        candidateKey,
        mnemonicCiphertext.slice(SECRET_ENC_PREFIX.length)
      );
    } catch {
      return null; // wrong password — previous cached credentials left untouched
    }
    setCachedPassword(password, salt, walletId);
  } else {
    // Legacy wallet (no kdf_salt): its data is encrypted under the app-gate
    // key, so the honest check is the gate passphrase — without this, any
    // typed password would "succeed" as long as some credentials were cached.
    // `verify()` intentionally does not update the cache. Opening needs the
    // actual gate-derived credentials, not whatever per-wallet credentials
    // happened to be cached before the picker was shown, so use the verified
    // unlock path.
    const ok = await unlockGatePassphrase(password);
    if (!ok) return null;
    if (!isCached()) {
      console.warn(
        '[DesktopWalletManager] Legacy wallet open refused: no credentials cached (gate locked?).'
      );
      return null;
    }
    // The shared legacy gate credentials are now committed to this active wallet
    // session. They can be rebound only after another wallet's password check.
    // readKdfSalt returns null for legacy wallets, so we re-derive the salt
    // from the keychain (unlockGatePassphrase already cached password + salt).
    const legacySaltB64 = await readKdfSalt(walletId);
    if (legacySaltB64) {
      setCachedPassword(password, legacySaltB64, walletId);
    }
  }

  let info: WalletMetadata | null;
  try {
    info = await manager.getWalletMetadata(walletId);
  } catch (error) {
    restorePrevious();
    throw error;
  }
  if (!info) {
    restorePrevious();
    return null;
  }
  // Clean out any stale cross-network rows now that we know the wallet's
  // network, so upstream's unscoped reads only ever see the active chain.
  const net =
    info.networkType === Network.MAINNET ? Network.MAINNET : Network.CHIPNET;
  try {
    await purgeCrossNetworkData(walletId, net);
  } catch (err) {
    console.warn(
      '[DesktopWalletManager] cross-network purge on open failed:',
      err
    );
  }
  return info;
}

async function readMnemonicCiphertext(
  walletId: number
): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare('SELECT mnemonic FROM wallets WHERE id = ?');
  query.bind([walletId]);
  let mnemonic: string | null = null;
  if (query.step()) {
    const row = query.getAsObject() as Record<string, unknown>;
    mnemonic = typeof row.mnemonic === 'string' ? row.mnemonic : null;
  }
  query.free();
  return mnemonic;
}

/**
 * Build the serialized .optn contents for an existing wallet, straight from its
 * stored (already-encrypted) DB fields — no password needed, since nothing is
 * decrypted. Returns null if the wallet is missing or has no per-wallet salt
 * (legacy shared-key wallets aren't self-contained and can't be exported).
 */
export async function buildWalletFileContents(
  walletId: number
): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const saltBytes = await readKdfSalt(walletId);
  if (!saltBytes) return null;

  const query = db.prepare(
    'SELECT wallet_name, mnemonic, passphrase, walletType, derivation_path, derivation_path_source FROM wallets WHERE id = ?'
  );
  query.bind([walletId]);
  let row: Record<string, unknown> | null = null;
  if (query.step()) row = query.getAsObject() as Record<string, unknown>;
  query.free();
  if (!row) return null;

  const { serializeWalletFile } = await import('./walletFile');
  return serializeWalletFile({
    sourceId: walletId,
    name:
      typeof row.wallet_name === 'string'
        ? row.wallet_name
        : `Wallet ${walletId}`,
    walletType:
      typeof row.walletType === 'string' ? row.walletType : 'standard',
    encryptedMnemonic: typeof row.mnemonic === 'string' ? row.mnemonic : '',
    encryptedPassphrase:
      typeof row.passphrase === 'string' ? row.passphrase : '',
    kdfSalt: bytesToBase64(saltBytes),
    derivationPath:
      typeof row.derivation_path === 'string' ? row.derivation_path : undefined,
    derivationPathSource:
      row.derivation_path_source === 'custom' ? 'custom' : 'default',
  });
}

/** Refresh the default desktop wallet-file mirror after wallet configuration changes. */
export async function refreshWalletFileMirror(walletId: number): Promise<void> {
  const contents = await buildWalletFileContents(walletId);
  if (!contents) return;
  const parsed = parseWalletFile(contents);
  const payload = {
    sourceId: parsed.sourceId,
    name: parsed.name,
    walletType: parsed.walletType,
    encryptedMnemonic: parsed.encryptedMnemonic,
    encryptedPassphrase: parsed.encryptedPassphrase,
    kdfSalt: parsed.kdfSalt,
    derivationPath: parsed.derivationPath,
    derivationPathSource: parsed.derivationPathSource,
  };
  await autoSaveWalletFile(payload);
}

export interface ImportWalletFileResult {
  walletId: number;
  network: Network;
  walletType: WalletType;
  derivationPath?: string;
  derivationPathSource?: DerivationPathSource;
}

/**
 * Import a wallet from a parsed .optn file: decrypt its mnemonic with the given
 * password + the file's own salt (this also VERIFIES the password), then create
 * a fresh DB row via the normal per-wallet-password path (new salt, re-encrypted,
 * auto-mirrored to a file). Returns null if the password is wrong or the file is
 * malformed. Network isn't stored in the file (runtime setting) — caller passes
 * the network to import under.
 */
export async function importWalletFile(
  file: WalletFileV1,
  password: string,
  network: Network
): Promise<ImportWalletFileResult | null> {
  if (!file.encryptedMnemonic.startsWith(SECRET_ENC_PREFIX)) return null;
  let mnemonic: string;
  let passphrase = '';
  try {
    const salt = base64ToBytes(file.kdfSalt);
    const key = await deriveKey(password, salt);
    mnemonic = await aesDecrypt(
      key,
      file.encryptedMnemonic.slice(SECRET_ENC_PREFIX.length)
    );
    if (file.encryptedPassphrase.startsWith(SECRET_ENC_PREFIX)) {
      passphrase = await aesDecrypt(
        key,
        file.encryptedPassphrase.slice(SECRET_ENC_PREFIX.length)
      );
    }
  } catch {
    return null; // wrong password or corrupt file
  }

  const walletType =
    file.walletType === WalletType.QUANTUMROOT
      ? WalletType.QUANTUMROOT
      : WalletType.STANDARD;

  const walletId = await createWalletWithPassword({
    name: file.name,
    mnemonic,
    passphrase,
    network,
    walletType,
    password,
    derivationPath: file.derivationPath,
    derivationPathSource: file.derivationPathSource,
  });
  if (walletId == null) return null;
  return {
    walletId,
    network,
    walletType,
    derivationPath: file.derivationPath,
    derivationPathSource: file.derivationPathSource,
  };
}

/** True if this wallet has its own independent password (not a legacy shared-key wallet). */
export async function walletHasOwnPassword(walletId: number): Promise<boolean> {
  const salt = await readKdfSalt(walletId);
  return salt !== null;
}

async function readWalletRow(
  walletId: number
): Promise<{
  name: string;
  walletType: string;
  mnemonic: string;
  passphrase: string;
  derivationPath?: string;
  derivationPathSource?: DerivationPathSource;
} | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  const q = db.prepare(
    'SELECT wallet_name, walletType, mnemonic, passphrase, derivation_path, derivation_path_source FROM wallets WHERE id = ?'
  );
  q.bind([walletId]);
  let row: Record<string, unknown> | null = null;
  if (q.step()) row = q.getAsObject() as Record<string, unknown>;
  q.free();
  if (!row) return null;
  return {
    name:
      typeof row.wallet_name === 'string'
        ? row.wallet_name
        : `Wallet ${walletId}`,
    walletType:
      typeof row.walletType === 'string' ? row.walletType : 'standard',
    mnemonic: typeof row.mnemonic === 'string' ? row.mnemonic : '',
    passphrase: typeof row.passphrase === 'string' ? row.passphrase : '',
    derivationPath:
      typeof row.derivation_path === 'string' ? row.derivation_path : undefined,
    derivationPathSource:
      row.derivation_path_source === 'custom' ? 'custom' : 'default',
  };
}

/**
 * Change ONE wallet's password: verify the old password decrypts this wallet,
 * re-encrypt its mnemonic/passphrase under a new key (fresh salt), update the
 * DB row + kdf_salt, swap the cached key, and refresh its wallet file. Returns
 * false if the old password is wrong or the wallet has no per-wallet salt.
 */
export async function changeWalletPassword(
  walletId: number,
  oldPassword: string,
  newPassword: string
): Promise<boolean> {
  const salt = await readKdfSalt(walletId);
  if (!salt) return false;
  const row = await readWalletRow(walletId);
  if (!row || !row.mnemonic.startsWith(SECRET_ENC_PREFIX)) return false;

  // Verify old password by decrypting this wallet's own data.
  let mnemonic: string;
  let passphrase = '';
  try {
    const oldKey = await deriveKey(oldPassword, salt);
    mnemonic = await aesDecrypt(
      oldKey,
      row.mnemonic.slice(SECRET_ENC_PREFIX.length)
    );
    if (row.passphrase.startsWith(SECRET_ENC_PREFIX)) {
      passphrase = await aesDecrypt(
        oldKey,
        row.passphrase.slice(SECRET_ENC_PREFIX.length)
      );
    }
  } catch {
    return false; // wrong current password
  }

  // Re-encrypt under a fresh key + salt.
  const newSalt = randomSalt(32);
  const newKey = await deriveKey(newPassword, newSalt);
  const encMnemonic = `${SECRET_ENC_PREFIX}${await aesEncrypt(newKey, mnemonic)}`;
  const encPassphrase = passphrase
    ? `${SECRET_ENC_PREFIX}${await aesEncrypt(newKey, passphrase)}`
    : '';

  const dbService = DatabaseService();
  const db = dbService.getDatabase();
  if (!db) return false;
  const upd = db.prepare(
    'UPDATE wallets SET mnemonic = ?, passphrase = ?, kdf_salt = ? WHERE id = ?'
  );
  upd.run([encMnemonic, encPassphrase, bytesToBase64(newSalt), walletId]);
  upd.free();
  await dbService.flushDatabaseToFile(walletId);

  setCachedPassword(newPassword, newSalt, walletId);

  // Refresh the wallet file so its copy matches the new password.
  await autoSaveWalletFile({
    sourceId: walletId,
    name: row.name,
    walletType: row.walletType,
    encryptedMnemonic: encMnemonic,
    encryptedPassphrase: encPassphrase,
    kdfSalt: bytesToBase64(newSalt),
    derivationPath: row.derivationPath,
    derivationPathSource: row.derivationPathSource,
  });

  // A biometric enrollment stored the OLD password — refresh it if present.
  try {
    if (await bioHasData({ domain: BIO_DOMAIN, name: bioName(walletId) })) {
      await bioSetData({
        domain: BIO_DOMAIN,
        name: bioName(walletId),
        data: newPassword,
      });
    }
  } catch {
    /* biometric refresh is best-effort */
  }
  return true;
}

// ── Per-wallet biometric unlock (Windows Hello / Touch ID) ──────────────────
// Stores THIS wallet's password behind the OS biometric prompt, namespaced by
// wallet id, so each wallet's biometric is independent.

export async function isBiometricAvailable(): Promise<boolean> {
  try {
    return (await bioCheckStatus()).isAvailable;
  } catch {
    return false;
  }
}

/**
 * Generic biometric label. The plugin's reported biometryType proved
 * unreliable across platforms (e.g. it reported Touch ID on Windows), so we
 * avoid claiming a specific method the OS may not actually be using. The OS
 * prompt itself shows the real method (Windows Hello face/fingerprint/PIN,
 * Touch ID, etc.).
 */
export function getBiometricLabel(): string {
  return 'Biometric / PIN';
}

export async function hasWalletBiometric(walletId: number): Promise<boolean> {
  try {
    return await bioHasData({ domain: BIO_DOMAIN, name: bioName(walletId) });
  } catch {
    return false;
  }
}

/** Enroll biometric for a wallet after verifying its password. */
export async function enableWalletBiometric(
  walletId: number,
  password: string
): Promise<boolean> {
  if (!(await verifyWalletPassword(walletId, password))) return false;
  await bioSetData({
    domain: BIO_DOMAIN,
    name: bioName(walletId),
    data: password,
  });
  return true;
}

export async function disableWalletBiometric(walletId: number): Promise<void> {
  try {
    await bioRemoveData({ domain: BIO_DOMAIN, name: bioName(walletId) });
  } catch {
    /* already gone */
  }
}

/**
 * Prompt biometric, retrieve the wallet password, and open the wallet.
 * Errors propagate to the caller so the UI can show the real reason (an OS
 * prompt cancel/failure, or a stored password that no longer opens the wallet)
 * instead of a generic "cancelled or failed".
 */
export async function unlockWalletWithBiometric(
  walletId: number
): Promise<WalletMetadata> {
  let result: Awaited<ReturnType<typeof bioGetData>>;
  try {
    result = await bioGetData({
      domain: BIO_DOMAIN,
      name: bioName(walletId),
      reason: 'Unlock OPTN Wallet',
    });
  } catch (err) {
    // A stale enrollment (secret saved by an earlier build/credential, or after
    // an OS re-key) fails to decrypt — Windows surfaces this as decryptionFailed
    // / CRC (HRESULT 0x80070017). It is not recoverable by retrying; the user
    // must re-save the secret. Translate the raw HRESULT into that instruction.
    const raw = err instanceof Error ? err.message : String(err);
    if (/decryptionFailed/i.test(raw) || raw.includes('0x80070017')) {
      throw new Error(
        'Saved biometric data is out of date and can no longer be decrypted. ' +
          'Turn biometric unlock off and on again for this wallet to re-save it.'
      );
    }
    throw err;
  }
  if (!result.data) {
    throw new Error('No biometric secret was returned by the OS.');
  }
  const info = await openWalletWithPassword(walletId, result.data);
  if (!info) {
    throw new Error(
      'The saved password no longer opens this wallet. Turn biometric off and on again to re-save it.'
    );
  }
  return info;
}

/**
 * Verify a password against a wallet WITHOUT changing the cached key — used by
 * the seed-reveal confirmation. For a per-wallet-password wallet, the password
 * must decrypt that wallet's own mnemonic. Legacy (no-salt) wallets fall back
 * to the gate passphrase (that is what actually encrypted them).
 */
export async function verifyWalletPassword(
  walletId: number,
  password: string
): Promise<boolean> {
  const salt = await readKdfSalt(walletId);
  if (!salt) {
    return verifyGatePassphrase(password);
  }
  const ciphertext = await readMnemonicCiphertext(walletId);
  if (!ciphertext?.startsWith(SECRET_ENC_PREFIX)) return false;
  try {
    const candidateKey = await deriveKey(password, salt);
    await aesDecrypt(candidateKey, ciphertext.slice(SECRET_ENC_PREFIX.length));
    return true;
  } catch {
    return false;
  }
}

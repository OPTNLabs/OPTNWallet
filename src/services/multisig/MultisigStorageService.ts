import {
  binToHex,
  hexToBin,
  hash160,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';

import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { createMultisigTables } from '../../utils/schema/schema';
import { Network } from '../../state/slices/networkSlice';
import { WalletType } from '../../types/wallet';
import SecretCryptoService from '../SecretCryptoService';
import {
  createMultisigDescriptorSet,
  deriveMultisigAddress,
  normalizeMultisigPolicy,
  parsePmwif,
  stableCosignerId,
  type CanonicalMultisigPolicy,
  type MultisigPolicy,
} from '../psbt/multisigWallet';
import { getBchAccountPath, normalizeBchAccountPath } from '../HdWalletService';

export const MULTISIG_GAP_LIMIT = 20;
const MAX_GAP_LIMIT = 100;

type SqlDatabase =
  ReturnType<typeof DatabaseService> extends {
    getDatabase: () => infer T;
  }
    ? NonNullable<T>
    : never;

type StoredPolicy = {
  id: number;
  walletId: number;
  policyId: string;
  policyRevision: number;
  network: Network;
  threshold: number;
  accountPath: string;
  name: string;
  receiveDescriptor: string | null;
  changeDescriptor: string | null;
  receiveCursor: number;
  changeCursor: number;
  gapLimit: number;
  setupStatus: 'ready' | 'needs-review' | 'migrating';
  legacyPolicyJson: string | null;
};

export type MultisigAddressReservation = {
  addressId: number;
  walletId: number;
  policyRevision: number;
  branch: 0 | 1;
  index: number;
  address: string;
  tokenAddress: string;
  lockingBytecode: Uint8Array;
  redeemScript: Uint8Array;
  policyId: string;
};

export type MultisigMigrationResult = {
  walletId: number;
  status: 'migrated' | 'needs-review' | 'skipped' | 'mismatch';
  reason?: string;
};

const reservationTails = new Map<number, Promise<void>>();

function now(): string {
  return new Date().toISOString();
}

function isValidGapLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_GAP_LIMIT;
}

function begin(db: SqlDatabase): void {
  db.exec('BEGIN IMMEDIATE');
}

function rollback(db: SqlDatabase): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the original error. SQLite may already have rolled back.
  }
}

function commit(db: SqlDatabase): void {
  db.exec('COMMIT');
}

function rowValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function networkFromStored(value: unknown): Network {
  if (value === Network.MAINNET) return Network.MAINNET;
  if (value === Network.CHIPNET) return Network.CHIPNET;
  throw new Error(`Unsupported multisig network: ${String(value)}`);
}

function addressPair(
  network: Network,
  lockingBytecode: Uint8Array
): {
  address: string;
  tokenAddress: string;
} {
  const prefix = network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
  const ordinary = lockingBytecodeToCashAddress({
    bytecode: lockingBytecode,
    prefix,
    tokenSupport: false,
  });
  const token = lockingBytecodeToCashAddress({
    bytecode: lockingBytecode,
    prefix,
    tokenSupport: true,
  });
  if (typeof ordinary === 'string' || typeof token === 'string') {
    throw new Error('Could not encode the multisig CashAddr pair.');
  }
  return { address: ordinary.address, tokenAddress: token.address };
}

function readStoredPolicy(
  db: SqlDatabase,
  walletId: number
): StoredPolicy | null {
  const statement = db.prepare(
    `SELECT id, wallet_id, policy_id, policy_revision, network_type, threshold,
            account_path, policy_name, receive_descriptor, change_descriptor,
            receive_cursor, change_cursor, gap_limit, setup_status,
            legacy_policy_json
       FROM multisig_policies WHERE wallet_id = ?`
  );
  try {
    statement.bind([walletId]);
    if (!statement.step()) return null;
    const row = statement.getAsObject() as Record<string, unknown>;
    const setupStatus = asString(rowValue(row, 'setup_status'));
    if (
      setupStatus !== 'ready' &&
      setupStatus !== 'needs-review' &&
      setupStatus !== 'migrating'
    ) {
      throw new Error(`Invalid multisig setup status for wallet ${walletId}.`);
    }
    return {
      id: asNumber(rowValue(row, 'id')),
      walletId: asNumber(rowValue(row, 'wallet_id')),
      policyId: asString(rowValue(row, 'policy_id')),
      policyRevision: asNumber(rowValue(row, 'policy_revision')),
      network: networkFromStored(rowValue(row, 'network_type')),
      threshold: asNumber(rowValue(row, 'threshold')),
      accountPath: asString(rowValue(row, 'account_path')),
      name: asString(rowValue(row, 'policy_name')),
      receiveDescriptor:
        rowValue(row, 'receive_descriptor') === null
          ? null
          : asString(rowValue(row, 'receive_descriptor')),
      changeDescriptor:
        rowValue(row, 'change_descriptor') === null
          ? null
          : asString(rowValue(row, 'change_descriptor')),
      receiveCursor: asNumber(rowValue(row, 'receive_cursor')),
      changeCursor: asNumber(rowValue(row, 'change_cursor')),
      gapLimit: asNumber(rowValue(row, 'gap_limit'), MULTISIG_GAP_LIMIT),
      setupStatus,
      legacyPolicyJson:
        rowValue(row, 'legacy_policy_json') === null
          ? null
          : asString(rowValue(row, 'legacy_policy_json')),
    };
  } finally {
    statement.free();
  }
}

function canonicalToPolicy(canonical: CanonicalMultisigPolicy): MultisigPolicy {
  return {
    schemaVersion: 1,
    name: canonical.name,
    network: canonical.network,
    m: canonical.threshold,
    threshold: canonical.threshold,
    accountPath: canonical.accountPath,
    policyRevision: canonical.policyRevision,
    signers: canonical.cosigners.map((cosigner) => ({
      id: cosigner.id,
      label: cosigner.label,
      name: cosigner.label,
      xpub: cosigner.xpub,
      masterFingerprintHex: cosigner.masterFingerprintHex,
      accountPath: cosigner.accountPath,
    })),
  };
}

function insertCompatibilityRows(
  db: SqlDatabase,
  walletId: number,
  network: Network,
  branch: 0 | 1,
  index: number,
  address: string,
  tokenAddress: string,
  lockingBytecode: Uint8Array,
  redeemScript: Uint8Array
): void {
  const key = db.prepare(
    `INSERT OR IGNORE INTO keys
       (wallet_id, public_key, private_key, address, token_address, pubkey_hash,
        account_index, change_index, address_index)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)`
  );
  try {
    const scriptHash = hash160(redeemScript);
    key.run([
      walletId,
      binToHex(scriptHash),
      address,
      tokenAddress,
      scriptHash,
      branch,
      index,
    ]);
  } finally {
    key.free();
  }

  const prefix = network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
  const row = db.prepare(
    `INSERT OR IGNORE INTO addresses
       (wallet_id, address, balance, hd_index, change_index, prefix, token_address)
     VALUES (?, ?, 0, ?, ?, ?, ?)`
  );
  try {
    row.run([walletId, address, index, branch, prefix, tokenAddress]);
  } finally {
    row.free();
  }

  // Keep the locking bytecode referenced in the argument list so callers cannot
  // accidentally use the compatibility rows as the source of redeem scripts.
  void lockingBytecode;
}

function insertAddressInventory(
  db: SqlDatabase,
  walletId: number,
  canonical: CanonicalMultisigPolicy,
  policyId: string,
  branch: 0 | 1,
  index: number
): number {
  const derived = deriveMultisigAddress(
    canonicalToPolicy(canonical),
    branch,
    index
  );
  const addresses = addressPair(canonical.network, derived.lockingBytecode);
  const insert = db.prepare(
    `INSERT INTO multisig_addresses
       (wallet_id, policy_revision, branch_index, address_index, address,
        token_address, locking_bytecode, redeem_script, reservation_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available')`
  );
  let addressId = 0;
  try {
    insert.run([
      walletId,
      canonical.policyRevision,
      branch,
      index,
      addresses.address,
      addresses.tokenAddress,
      binToHex(derived.lockingBytecode),
      binToHex(derived.redeemScript),
    ]);
  } finally {
    insert.free();
  }

  const id = db.prepare('SELECT last_insert_rowid() AS id');
  try {
    if (id.step()) addressId = asNumber(id.getAsObject().id);
  } finally {
    id.free();
  }
  if (!addressId) throw new Error('Could not persist a multisig address.');

  insertCompatibilityRows(
    db,
    walletId,
    canonical.network,
    branch,
    index,
    addresses.address,
    addresses.tokenAddress,
    derived.lockingBytecode,
    derived.redeemScript
  );

  const insertKey = db.prepare(
    `INSERT INTO multisig_address_keys
       (wallet_id, address_id, cosigner_id, public_key, sorted_position, derivation_path)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  try {
    for (const cosigner of derived.derivedCosigners) {
      const accountPath = canonical.cosigners.find(
        (candidate) => candidate.id === cosigner.cosignerId
      )?.accountPath;
      if (!accountPath)
        throw new Error('Derived cosigner is not in the policy.');
      insertKey.run([
        walletId,
        addressId,
        cosigner.cosignerId,
        binToHex(cosigner.publicKey),
        cosigner.sortedPosition,
        `${accountPath}/${branch}/${index}`,
      ]);
    }
  } finally {
    insertKey.free();
  }

  void policyId;
  return addressId;
}

function policyRowToPolicy(
  db: SqlDatabase,
  stored: StoredPolicy
): MultisigPolicy | null {
  if (stored.setupStatus !== 'ready') return null;
  if (!stored.receiveDescriptor || !stored.changeDescriptor) return null;
  const statement = db.prepare(
    `SELECT cosigner_id, label, xpub, master_fingerprint, account_path
       FROM multisig_cosigners
      WHERE wallet_id = ? AND policy_revision = ?
      ORDER BY cosigner_id`
  );
  const signers: MultisigPolicy['signers'] = [];
  try {
    statement.bind([stored.walletId, stored.policyRevision]);
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      signers.push({
        id: asString(row.cosigner_id),
        label: asString(row.label),
        name: asString(row.label),
        xpub: asString(row.xpub),
        masterFingerprintHex: asString(row.master_fingerprint),
        accountPath: asString(row.account_path),
      });
    }
  } finally {
    statement.free();
  }
  if (signers.length < 2) return null;
  return {
    schemaVersion: 1,
    name: stored.name,
    network: stored.network,
    m: stored.threshold,
    threshold: stored.threshold,
    accountPath: stored.accountPath,
    policyRevision: stored.policyRevision,
    signers,
  };
}

async function withDatabase(): Promise<{
  dbService: ReturnType<typeof DatabaseService>;
  db: SqlDatabase;
}> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');
  createMultisigTables(db);
  return { dbService, db: db as SqlDatabase };
}

export async function createMultisigWallet(args: {
  name: string;
  policy: MultisigPolicy;
  network: Network;
  gapLimit?: number;
  /** Optional local OPTN signer seed, encrypted before it reaches SQLite. */
  localSignerSeed?: { mnemonic: string; passphrase: string };
}): Promise<number> {
  const name = args.name.trim();
  if (!name) throw new Error('Give the wallet a name.');
  const gapLimit = args.gapLimit ?? MULTISIG_GAP_LIMIT;
  if (!isValidGapLimit(gapLimit)) {
    throw new Error(
      `Multisig gap limit must be between 1 and ${MAX_GAP_LIMIT}.`
    );
  }
  const canonical = normalizeMultisigPolicy(args.policy, args.network);
  const descriptorSet = createMultisigDescriptorSet(args.policy, args.network);
  const encryptedMnemonic = args.localSignerSeed
    ? await SecretCryptoService.encryptText(args.localSignerSeed.mnemonic)
    : null;
  const encryptedPassphrase = args.localSignerSeed
    ? await SecretCryptoService.encryptText(args.localSignerSeed.passphrase)
    : null;
  const { dbService, db } = await withDatabase();

  begin(db);
  try {
    const wallet = db.prepare(
      `INSERT INTO wallets
         (wallet_name, mnemonic, passphrase, networkType, walletType, balance,
          derivation_path, derivation_path_source)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'default')`
    );
    try {
      wallet.run([
        name,
        encryptedMnemonic,
        encryptedPassphrase,
        args.network,
        WalletType.MULTISIG,
        canonical.accountPath,
      ]);
    } finally {
      wallet.free();
    }
    const walletIdQuery = db.prepare('SELECT last_insert_rowid() AS id');
    let walletId = 0;
    try {
      if (walletIdQuery.step())
        walletId = asNumber(walletIdQuery.getAsObject().id);
    } finally {
      walletIdQuery.free();
    }
    if (!walletId) throw new Error('Could not create the multisig wallet.');

    const timestamp = now();
    const policyRow = db.prepare(
      `INSERT INTO multisig_policies
         (wallet_id, schema_version, policy_id, policy_revision, network_type,
          threshold, account_path, policy_name, receive_descriptor,
          change_descriptor, receive_cursor, change_cursor, gap_limit,
          setup_status, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'ready', ?, ?)`
    );
    try {
      policyRow.run([
        walletId,
        descriptorSet.policyId,
        canonical.policyRevision,
        canonical.network,
        canonical.threshold,
        canonical.accountPath,
        name,
        descriptorSet.receive,
        descriptorSet.change,
        gapLimit,
        timestamp,
        timestamp,
      ]);
    } finally {
      policyRow.free();
    }

    const cosignerRow = db.prepare(
      `INSERT INTO multisig_cosigners
         (wallet_id, policy_revision, cosigner_id, label, xpub,
          master_fingerprint, account_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      for (const cosigner of canonical.cosigners) {
        cosignerRow.run([
          walletId,
          canonical.policyRevision,
          cosigner.id,
          cosigner.label,
          cosigner.xpub,
          cosigner.masterFingerprintHex,
          cosigner.accountPath,
        ]);
      }
    } finally {
      cosignerRow.free();
    }

    for (const branch of [0, 1] as const) {
      for (let index = 0; index < gapLimit; index += 1) {
        insertAddressInventory(
          db,
          walletId,
          canonical,
          descriptorSet.policyId,
          branch,
          index
        );
      }
    }
    commit(db);
    // This is a newly-created wallet, so it has no persisted concurrency
    // baseline yet. Use the dedicated creation path; a normal wallet-scoped
    // save would treat the missing on-disk row as a concurrent deletion and
    // leave the multisig visible only in this window's in-memory database.
    return await dbService.persistNewWalletToFile(walletId);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export async function loadMultisigPolicy(
  walletId: number
): Promise<MultisigPolicy | null> {
  const { db } = await withDatabase();
  const stored = readStoredPolicy(db, walletId);
  return stored ? policyRowToPolicy(db, stored) : null;
}

export async function getMultisigPolicyStatus(
  walletId: number
): Promise<StoredPolicy | null> {
  const { db } = await withDatabase();
  return readStoredPolicy(db, walletId);
}

async function reserveAddressInternal(
  walletId: number,
  branch: 0 | 1
): Promise<MultisigAddressReservation> {
  const { dbService, db } = await withDatabase();
  const stored = readStoredPolicy(db, walletId);
  if (!stored || stored.setupStatus !== 'ready') {
    throw new Error(
      'This multisig policy needs review before addresses can be reserved.'
    );
  }
  const policy = policyRowToPolicy(db, stored);
  if (!policy) throw new Error('Multisig policy metadata is incomplete.');
  const canonical = normalizeMultisigPolicy(policy, stored.network);

  begin(db);
  try {
    const cursor = branch === 0 ? stored.receiveCursor : stored.changeCursor;
    const available = db.prepare(
      `SELECT id, address_index, address, token_address, locking_bytecode,
              redeem_script
         FROM multisig_addresses
        WHERE wallet_id = ? AND policy_revision = ? AND branch_index = ?
          AND address_index >= ? AND reservation_status = 'available'
        ORDER BY address_index LIMIT 1`
    );
    let row: Record<string, unknown> | null = null;
    try {
      available.bind([walletId, stored.policyRevision, branch, cursor]);
      if (available.step())
        row = available.getAsObject() as Record<string, unknown>;
    } finally {
      available.free();
    }

    if (!row) {
      const nextIndex = cursor;
      insertAddressInventory(
        db,
        walletId,
        canonical,
        stored.policyId,
        branch,
        nextIndex
      );
      const retry = db.prepare(
        `SELECT id, address_index, address, token_address, locking_bytecode,
                redeem_script
           FROM multisig_addresses
          WHERE wallet_id = ? AND policy_revision = ? AND branch_index = ?
            AND address_index = ?`
      );
      try {
        retry.bind([walletId, stored.policyRevision, branch, nextIndex]);
        if (retry.step()) row = retry.getAsObject() as Record<string, unknown>;
      } finally {
        retry.free();
      }
    }
    if (!row) throw new Error('Could not allocate a multisig address.');

    const reservedAt = now();
    const update = db.prepare(
      `UPDATE multisig_addresses
          SET reservation_status = 'reserved', reserved_at = ?
        WHERE id = ? AND reservation_status = 'available'`
    );
    try {
      update.run([reservedAt, asNumber(row.id)]);
    } finally {
      update.free();
    }
    const nextCursor = asNumber(row.address_index) + 1;
    const updatePolicy = db.prepare(
      `UPDATE multisig_policies
          SET ${branch === 0 ? 'receive_cursor' : 'change_cursor'} = MAX(${branch === 0 ? 'receive_cursor' : 'change_cursor'}, ?),
              updated_at = ?
        WHERE wallet_id = ? AND policy_revision = ?`
    );
    try {
      updatePolicy.run([
        nextCursor,
        reservedAt,
        walletId,
        stored.policyRevision,
      ]);
    } finally {
      updatePolicy.free();
    }
    commit(db);
    await dbService.saveDatabaseToFile(walletId);

    return {
      addressId: asNumber(row.id),
      walletId,
      policyRevision: stored.policyRevision,
      branch,
      index: asNumber(row.address_index),
      address: asString(row.address),
      tokenAddress: asString(row.token_address),
      lockingBytecode: hexToBin(asString(row.locking_bytecode)),
      redeemScript: hexToBin(asString(row.redeem_script)),
      policyId: stored.policyId,
    };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export async function reserveMultisigAddress(
  walletId: number,
  branch: 0 | 1
): Promise<MultisigAddressReservation> {
  const previous = reservationTails.get(walletId) ?? Promise.resolve();
  let result: MultisigAddressReservation | undefined;
  const run = previous.then(async () => {
    result = await reserveAddressInternal(walletId, branch);
  });
  reservationTails.set(
    walletId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  await run;
  if (!result)
    throw new Error('Multisig address reservation did not complete.');
  return result;
}

/**
 * Materialize a bounded discovery window without reserving any address. This is
 * deliberately separate from receive/change reservation: opening a wallet or
 * scanning history must never consume an address index.
 */
export async function ensureMultisigAddressInventory(
  walletId: number,
  throughIndex: number
): Promise<void> {
  if (
    !Number.isSafeInteger(throughIndex) ||
    throughIndex < 0 ||
    throughIndex > 1000
  ) {
    throw new Error('Multisig discovery range is invalid or unbounded.');
  }
  const { dbService, db } = await withDatabase();
  const stored = readStoredPolicy(db, walletId);
  if (!stored || stored.setupStatus !== 'ready') {
    throw new Error('This multisig policy needs review before discovery.');
  }
  const policy = policyRowToPolicy(db, stored);
  if (!policy) throw new Error('Multisig policy metadata is incomplete.');
  const canonical = normalizeMultisigPolicy(policy, stored.network);
  begin(db);
  try {
    for (const branch of [0, 1] as const) {
      const query = db.prepare(
        `SELECT MAX(address_index) AS max_index
           FROM multisig_addresses
          WHERE wallet_id = ? AND policy_revision = ? AND branch_index = ?`
      );
      let highest = -1;
      try {
        query.bind([walletId, stored.policyRevision, branch]);
        if (query.step()) highest = asNumber(query.getAsObject().max_index, -1);
      } finally {
        query.free();
      }
      for (let index = highest + 1; index <= throughIndex; index += 1) {
        insertAddressInventory(
          db,
          walletId,
          canonical,
          stored.policyId,
          branch,
          index
        );
      }
    }
    commit(db);
    await dbService.saveDatabaseToFile(walletId);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

/**
 * Return the canonical address inventory used for network scanning.
 *
 * Multisig refreshes must not infer ownership from the standard wallet's
 * compatibility `keys` rows. The policy-owned inventory is authoritative for
 * which receive/change addresses belong to this shared wallet.
 */
export async function listMultisigAddressInventory(
  walletId: number
): Promise<
  Array<{
    address: string;
    tokenAddress: string;
    branch: 0 | 1;
    index: number;
  }>
> {
  const { db } = await withDatabase();
  const stored = readStoredPolicy(db, walletId);
  if (!stored || stored.setupStatus !== 'ready') {
    throw new Error('This multisig policy needs review before network refresh.');
  }

  const query = db.prepare(
    `SELECT address, token_address, branch_index, address_index
       FROM multisig_addresses
      WHERE wallet_id = ? AND policy_revision = ?
      ORDER BY branch_index, address_index`
  );
  const rows: Array<{
    address: string;
    tokenAddress: string;
    branch: 0 | 1;
    index: number;
  }> = [];
  try {
    query.bind([walletId, stored.policyRevision]);
    while (query.step()) {
      const row = query.getAsObject() as Record<string, unknown>;
      const branch = asNumber(row.branch_index);
      const index = asNumber(row.address_index);
      const address = asString(row.address);
      const tokenAddress = asString(row.token_address);
      if ((branch !== 0 && branch !== 1) || index < 0 || !address) continue;
      rows.push({
        address,
        tokenAddress,
        branch,
        index,
      });
    }
  } finally {
    query.free();
  }
  return rows;
}

function tableHasColumn(
  db: SqlDatabase,
  table: string,
  column: string
): boolean {
  const statement = db.prepare(`PRAGMA table_info(${table})`);
  try {
    while (statement.step()) {
      if (
        (statement.getAsObject() as Record<string, unknown>).name === column
      ) {
        return true;
      }
    }
    return false;
  } finally {
    statement.free();
  }
}

function legacyKeyMatches(
  row: Record<string, unknown>,
  address: string,
  redeemScript: Uint8Array
): boolean {
  if (asString(row.address) !== address) return false;
  const expectedHash = binToHex(hash160(redeemScript));
  const stored = row.public_key;
  if (typeof stored === 'string') return stored.toLowerCase() === expectedHash;
  if (stored instanceof Uint8Array) return binToHex(stored) === expectedHash;
  return false;
}

function migrateLegacyWallet(
  db: SqlDatabase,
  walletId: number,
  legacyJson: string,
  network: Network,
  walletPath: string | null
): MultisigMigrationResult {
  let legacyPolicy: MultisigPolicy;
  try {
    legacyPolicy = parsePmwif(legacyJson);
  } catch (error) {
    return {
      walletId,
      status: 'needs-review',
      reason:
        error instanceof Error ? error.message : 'Legacy policy is malformed.',
    };
  }

  const incompleteMetadata = legacyPolicy.signers.some(
    (cosigner) => !cosigner.masterFingerprintHex || !cosigner.accountPath
  );
  const accountPath =
    typeof walletPath === 'string' && walletPath
      ? (() => {
          try {
            return normalizeBchAccountPath(walletPath);
          } catch {
            return getBchAccountPath(network);
          }
        })()
      : getBchAccountPath(network);
  const policyForDerivation: MultisigPolicy = {
    ...legacyPolicy,
    network,
    accountPath,
    signers: legacyPolicy.signers.map((cosigner) => ({
      ...cosigner,
      accountPath: cosigner.accountPath ?? accountPath,
    })),
  };

  let canonical: CanonicalMultisigPolicy | null = null;
  let descriptorSet: ReturnType<typeof createMultisigDescriptorSet> | null =
    null;
  let policyId = `legacy:${binToHex(hash160(new TextEncoder().encode(legacyJson)))}`;
  if (!incompleteMetadata) {
    try {
      canonical = normalizeMultisigPolicy(policyForDerivation, network);
      descriptorSet = createMultisigDescriptorSet(policyForDerivation, network);
      policyId = descriptorSet.policyId;
    } catch (error) {
      return {
        walletId,
        status: 'needs-review',
        reason:
          error instanceof Error
            ? error.message
            : 'Legacy policy failed validation.',
      };
    }
  }

  const keyRows = db.prepare(
    `SELECT address, public_key, change_index, address_index
       FROM keys WHERE wallet_id = ?`
  );
  const existingKeys: Record<string, unknown>[] = [];
  try {
    keyRows.bind([walletId]);
    while (keyRows.step())
      existingKeys.push(keyRows.getAsObject() as Record<string, unknown>);
  } finally {
    keyRows.free();
  }

  const comparisonPolicy = canonical
    ? canonicalToPolicy(canonical)
    : policyForDerivation;
  for (const row of existingKeys) {
    const branch = asNumber(row.change_index);
    const index = asNumber(row.address_index);
    if ((branch !== 0 && branch !== 1) || index < 0) {
      return {
        walletId,
        status: 'mismatch',
        reason: 'Legacy key row has an invalid path.',
      };
    }
    try {
      const derived = deriveMultisigAddress(
        comparisonPolicy,
        branch as 0 | 1,
        index
      );
      const encoded = addressPair(network, derived.lockingBytecode);
      if (!legacyKeyMatches(row, encoded.address, derived.redeemScript)) {
        return {
          walletId,
          status: 'mismatch',
          reason: `Legacy address ${String(row.address)} does not match its redeem script.`,
        };
      }
    } catch (error) {
      return {
        walletId,
        status: 'mismatch',
        reason:
          error instanceof Error
            ? error.message
            : 'Legacy address derivation failed.',
      };
    }
  }

  const gapLimit = Math.max(
    MULTISIG_GAP_LIMIT,
    existingKeys.reduce(
      (max, row) => Math.max(max, asNumber(row.address_index) + 1),
      0
    )
  );
  const timestamp = now();
  begin(db);
  try {
    db.run('DELETE FROM multisig_address_keys WHERE wallet_id = ?', [walletId]);
    db.run('DELETE FROM multisig_addresses WHERE wallet_id = ?', [walletId]);
    db.run('DELETE FROM multisig_cosigners WHERE wallet_id = ?', [walletId]);
    db.run('DELETE FROM multisig_policies WHERE wallet_id = ?', [walletId]);

    db.run(
      `INSERT INTO multisig_policies
         (wallet_id, schema_version, policy_id, policy_revision, network_type,
          threshold, account_path, policy_name, receive_descriptor,
          change_descriptor, receive_cursor, change_cursor, gap_limit,
          setup_status, legacy_policy_json, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
      [
        walletId,
        policyId,
        canonical?.policyRevision ?? 0,
        network,
        legacyPolicy.m,
        accountPath,
        legacyPolicy.name,
        descriptorSet?.receive ?? null,
        descriptorSet?.change ?? null,
        gapLimit,
        incompleteMetadata ? 'needs-review' : 'ready',
        legacyJson,
        timestamp,
        timestamp,
      ]
    );

    const inventoryPolicy =
      canonical ??
      normalizeMultisigPolicy(
        {
          ...policyForDerivation,
          signers: policyForDerivation.signers.map((signer) => ({
            ...signer,
            masterFingerprintHex: signer.masterFingerprintHex ?? '00000000',
          })),
        },
        network
      );
    const cosignerInsert = db.prepare(
      `INSERT INTO multisig_cosigners
         (wallet_id, policy_revision, cosigner_id, label, xpub,
          master_fingerprint, account_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      for (const cosigner of inventoryPolicy.cosigners) {
        cosignerInsert.run([
          walletId,
          inventoryPolicy.policyRevision,
          cosigner.id || stableCosignerId(cosigner.xpub),
          cosigner.label,
          cosigner.xpub,
          incompleteMetadata ? '' : cosigner.masterFingerprintHex,
          cosigner.accountPath,
        ]);
      }
    } finally {
      cosignerInsert.free();
    }

    for (const branch of [0, 1] as const) {
      for (let index = 0; index < gapLimit; index += 1) {
        insertAddressInventory(
          db,
          walletId,
          inventoryPolicy,
          policyId,
          branch,
          index
        );
      }
    }

    if (!incompleteMetadata) {
      db.run(
        `UPDATE wallets SET walletType = ?, derivation_path = ? WHERE id = ?`,
        [WalletType.MULTISIG, accountPath, walletId]
      );
    }
    commit(db);
    return {
      walletId,
      status: incompleteMetadata ? 'needs-review' : 'migrated',
      reason: incompleteMetadata
        ? 'Fingerprint and/or account-path metadata is incomplete.'
        : undefined,
    };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export async function migrateLegacyMultisigWallet(
  walletId: number
): Promise<MultisigMigrationResult> {
  const { dbService, db } = await withDatabase();
  if (!tableHasColumn(db, 'wallets', 'multisig_policy')) {
    return { walletId, status: 'skipped' };
  }
  const query = db.prepare(
    `SELECT walletType, networkType, derivation_path, multisig_policy
       FROM wallets WHERE id = ?`
  );
  try {
    query.bind([walletId]);
    if (!query.step()) return { walletId, status: 'skipped' };
    const row = query.getAsObject() as Record<string, unknown>;
    if (
      row.walletType !== 'watch-only' ||
      typeof row.multisig_policy !== 'string'
    ) {
      return { walletId, status: 'skipped' };
    }
    const network =
      row.networkType === Network.CHIPNET ? Network.CHIPNET : Network.MAINNET;
    const result = migrateLegacyWallet(
      db,
      walletId,
      row.multisig_policy,
      network,
      typeof row.derivation_path === 'string' ? row.derivation_path : null
    );
    await dbService.saveDatabaseToFile(walletId);
    return result;
  } finally {
    query.free();
  }
}

export async function migrateLegacyMultisigWallets(): Promise<
  MultisigMigrationResult[]
> {
  const { db } = await withDatabase();
  if (!tableHasColumn(db, 'wallets', 'multisig_policy')) return [];
  const query = db.prepare(
    `SELECT id FROM wallets WHERE walletType = 'watch-only' AND multisig_policy IS NOT NULL`
  );
  const ids: number[] = [];
  try {
    while (query.step()) ids.push(asNumber(query.getAsObject().id));
  } finally {
    query.free();
  }
  const results: MultisigMigrationResult[] = [];
  for (const walletId of ids)
    results.push(await migrateLegacyMultisigWallet(walletId));
  return results;
}

export default {
  createMultisigWallet,
  loadMultisigPolicy,
  getMultisigPolicyStatus,
  reserveMultisigAddress,
  ensureMultisigAddressInventory,
  migrateLegacyMultisigWallet,
  migrateLegacyMultisigWallets,
};

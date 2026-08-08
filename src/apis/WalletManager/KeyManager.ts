import DatabaseService from '../DatabaseManager/DatabaseService';
import AddressManager from '../AddressManager/AddressManager';
import { Address, QuantumrootVaultRecord } from '../../types/types';
import { Network } from '../../state/slices/networkSlice';
import { PREFIX } from '../../utils/constants';
import { isArrayBufferLike, isString } from '../../utils/typeGuards';
import {
  deriveBchChild,
  deriveBchStandardXpubs,
  getBchAccountPath,
  normalizeBchAccountPath,
  type DerivedBchPublicAddress,
  type BchStandardBranchName,
} from '../../services/HdWalletService';
import {
  deriveQuantumrootVault,
  toQuantumrootVaultRecord,
} from '../../services/QuantumrootService';
import QuantumrootVaultCacheService from '../../services/QuantumrootVaultCacheService';
import SecretCryptoService, {
  isEncryptedPayload,
} from '../../services/SecretCryptoService';
import { zeroize } from '../../utils/secureMemory';

function toString(value: unknown): string {
  return isString(value) ? value : String(value);
}

function toCount(value: unknown): number {
  return typeof value === 'number'
    ? value
    : Number.parseInt(String(value), 10) || 0;
}

/** Serialize createKeys per wallet so concurrent auto-fuse / UI address mint
 *  cannot both pass the existence check and then hit keys.token_address UNIQUE. */
const createKeysTails = new Map<number, Promise<void>>();

function enqueueCreateKeys(
  walletId: number,
  task: () => Promise<void>
): Promise<void> {
  const previous = createKeysTails.get(walletId) ?? Promise.resolve();
  const run = previous.then(task, task);
  createKeysTails.set(
    walletId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

const textDecoder = new TextDecoder();

async function decodePrivateKeyPayload(
  value: unknown
): Promise<Uint8Array | null> {
  if (isArrayBufferLike(value)) {
    const bytes = new Uint8Array(value);
    const decoded = textDecoder.decode(bytes);
    if (isEncryptedPayload(decoded)) {
      return await SecretCryptoService.decryptBytes(decoded);
    }
    return bytes;
  }

  if (isString(value)) {
    if (isEncryptedPayload(value)) {
      return await SecretCryptoService.decryptBytes(value);
    }
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  }

  return null;
}

export default function KeyManager() {
  const dbService = DatabaseService();
  const ManageAddress = AddressManager();

  return {
    getXpubs,
    getXpubsForAccountPath,
    deriveAddressFromXpub,
    retrieveKeys,
    createKeys,
    fetchAddressPrivateKey,
    deriveQuantumrootVaultForWallet,
    createQuantumrootVault,
    configureQuantumrootVault,
    retrieveQuantumrootVaults,
  };

  async function getWalletSeedMaterial(wallet_id: number) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

    const query = db.prepare(
      `SELECT mnemonic, passphrase, networkType, derivation_path FROM wallets WHERE id = ?;`
    );
    const row =
      (query.get([wallet_id]) as (string | number | undefined)[] | undefined) ??
      [];
    query.free();

    const [mnemonic, passphrase] = await SecretCryptoService.decryptTextBatch(
      [toString(row[0]), toString(row[1])],
      wallet_id
    );
    const networkType =
      row[2] === Network.MAINNET
        ? Network.MAINNET
        : row[2] === Network.CHIPNET
          ? Network.CHIPNET
          : null;

    if (!mnemonic || !networkType) {
      throw new Error('Mnemonic or network not found for the given wallet id');
    }

    let derivationPath = getBchAccountPath(networkType);
    if (typeof row[3] === 'string') {
      try {
        derivationPath = normalizeBchAccountPath(row[3]);
      } catch {
        // Keep the network default for a legacy or partially migrated row.
      }
    }

    return {
      mnemonic,
      passphrase,
      networkType,
      derivationPath,
    };
  }

  async function getXpubs(
    wallet_id: number,
    accountNumber = 0
  ): Promise<Record<BchStandardBranchName, string>> {
    const { mnemonic, passphrase, networkType, derivationPath } =
      await getWalletSeedMaterial(wallet_id);
    return deriveBchStandardXpubs(
      networkType,
      mnemonic,
      passphrase,
      accountNumber,
      derivationPath
    );
  }

  /**
   * Xpubs for an arbitrary candidate account path, for derivation-path
   * discovery on an existing wallet.
   *
   * Deliberately separate from getXpubs, which is pinned to the wallet's stored
   * path: discovery has to look at paths the wallet is NOT on. The seed is read,
   * used, and dropped inside this function so callers never handle it — a
   * scan runs entirely on public keys.
   */
  async function getXpubsForAccountPath(
    wallet_id: number,
    accountPath: string,
    accountNumber = 0
  ): Promise<Record<BchStandardBranchName, string>> {
    const normalized = normalizeBchAccountPath(accountPath);
    const { mnemonic, passphrase, networkType } =
      await getWalletSeedMaterial(wallet_id);
    return deriveBchStandardXpubs(
      networkType,
      mnemonic,
      passphrase,
      accountNumber,
      normalized
    );
  }

  async function deriveAddressFromXpub(
    wallet_id: number,
    branchName: BchStandardBranchName,
    addressIndex: number | bigint,
    accountNumber = 0
  ): Promise<DerivedBchPublicAddress> {
    const { networkType } = await getWalletSeedMaterial(wallet_id);
    const xpubs = await getXpubs(wallet_id, accountNumber);
    const derived = await deriveBchChild(
      networkType,
      {
        kind: 'xpub',
        hdPublicKey: xpubs[branchName],
      },
      addressIndex
    );

    if (!derived || 'privateKey' in derived) {
      throw new Error(
        `Failed to derive public address from xpub for branch ${branchName}`
      );
    }

    return derived;
  }

  async function deriveQuantumrootVaultForWallet(
    wallet_id: number,
    addressIndex: number,
    accountNumber = 0,
    onlineQuantumSigner: '0' | '1' = '0',
    vaultTokenCategory = '00'.repeat(32)
  ) {
    const { mnemonic, passphrase, networkType, derivationPath } =
      await getWalletSeedMaterial(wallet_id);
    return deriveQuantumrootVault(
      networkType,
      mnemonic,
      passphrase,
      accountNumber,
      addressIndex,
      onlineQuantumSigner,
      vaultTokenCategory,
      derivationPath
    );
  }

  async function createQuantumrootVault(
    wallet_id: number,
    addressIndex: number,
    accountNumber = 0,
    onlineQuantumSigner: 0 | 1 = 0,
    vaultTokenCategory = '00'.repeat(32)
  ): Promise<QuantumrootVaultRecord> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

    const cached = QuantumrootVaultCacheService.list(wallet_id).find(
      (record) =>
        record.account_index === accountNumber &&
        record.address_index === addressIndex
    );
    if (cached) {
      return cached;
    }

    const vault = await deriveQuantumrootVaultForWallet(
      wallet_id,
      addressIndex,
      accountNumber,
      onlineQuantumSigner === 1 ? '1' : '0',
      vaultTokenCategory
    );
    const record = toQuantumrootVaultRecord(
      wallet_id,
      accountNumber,
      vault,
      onlineQuantumSigner,
      vaultTokenCategory
    );

    QuantumrootVaultCacheService.upsert(wallet_id, record);
    return record;
  }

  async function configureQuantumrootVault(
    wallet_id: number,
    addressIndex: number,
    accountNumber = 0,
    onlineQuantumSigner: 0 | 1 = 0,
    vaultTokenCategory = '00'.repeat(32)
  ): Promise<QuantumrootVaultRecord> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

    const normalizedSigner = onlineQuantumSigner === 1 ? 1 : 0;
    const vault = await deriveQuantumrootVaultForWallet(
      wallet_id,
      addressIndex,
      accountNumber,
      normalizedSigner === 1 ? '1' : '0',
      vaultTokenCategory
    );
    const record = toQuantumrootVaultRecord(
      wallet_id,
      accountNumber,
      vault,
      normalizedSigner,
      vaultTokenCategory
    );

    QuantumrootVaultCacheService.upsert(wallet_id, record);
    return record;
  }

  async function retrieveQuantumrootVaults(
    wallet_id: number
  ): Promise<QuantumrootVaultRecord[]> {
    const cached = QuantumrootVaultCacheService.list(wallet_id);
    if (cached.length > 0) {
      return cached;
    }

    // IMPORTANT: do NOT backfill by deriving a vault for every HD address_index
    // in `keys`. That path re-ran heavy Quantumroot crypto for every receive
    // index on every cold open (empty cache / new window), which froze Home
    // sync at 5% for tens of seconds on ordinary wallets that never used
    // Quantumroot. Only return vaults that were explicitly created/configured.
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

    const records: QuantumrootVaultRecord[] = [];
    try {
      const query = db.prepare(`
        SELECT
          id,
          wallet_id,
          account_index,
          address_index,
          receive_address,
          quantum_lock_address,
          receive_locking_bytecode,
          quantum_lock_locking_bytecode,
          quantum_public_key,
          quantum_key_identifier,
          vault_token_category,
          online_quantum_signer,
          created_at,
          updated_at
        FROM quantumroot_vaults
        WHERE wallet_id = ?
        ORDER BY account_index ASC, address_index ASC;
      `);
      query.bind([wallet_id]);
      while (query.step()) {
        const row = query.getAsObject() as Record<string, unknown>;
        const onlineSigner = Number(row.online_quantum_signer);
        records.push({
          id: typeof row.id === 'number' ? row.id : Number(row.id) || undefined,
          wallet_id: Number(row.wallet_id),
          account_index: Number(row.account_index),
          address_index: Number(row.address_index),
          receive_address: String(row.receive_address ?? ''),
          quantum_lock_address: String(row.quantum_lock_address ?? ''),
          receive_locking_bytecode: String(row.receive_locking_bytecode ?? ''),
          quantum_lock_locking_bytecode: String(
            row.quantum_lock_locking_bytecode ?? ''
          ),
          quantum_public_key: String(row.quantum_public_key ?? ''),
          quantum_key_identifier: String(row.quantum_key_identifier ?? ''),
          vault_token_category: String(row.vault_token_category ?? ''),
          online_quantum_signer: onlineSigner === 1 ? 1 : 0,
          created_at: String(row.created_at ?? ''),
          updated_at: String(row.updated_at ?? ''),
        });
      }
      query.free();
    } catch {
      // Table missing on a pre-migration DB — treat as no vaults.
    }

    if (records.length > 0) {
      QuantumrootVaultCacheService.replace(wallet_id, records);
    }
    return records;
  }

  // Function to retrieve keys from the database
  async function retrieveKeys(wallet_id: number) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

    const query = `
      SELECT 
        id, 
        public_key, 
        address,
        token_address,
        pubkey_hash,
        account_index,
        change_index,
        address_index
      FROM keys 
      WHERE wallet_id = :walletid
    `;
    const statement = db.prepare(query);
    statement.bind({ ':walletid': wallet_id });

    const result = [];

    while (statement.step()) {
      const row = statement.getAsObject();

      const publicKey = isArrayBufferLike(row.public_key)
        ? new Uint8Array(row.public_key)
        : isString(row.public_key)
          ? Uint8Array.from(atob(row.public_key), (c) => c.charCodeAt(0))
          : new Uint8Array();

      const pubkeyHash = isArrayBufferLike(row.pubkey_hash)
        ? new Uint8Array(row.pubkey_hash)
        : isString(row.pubkey_hash)
          ? Uint8Array.from(atob(row.pubkey_hash), (c) => c.charCodeAt(0))
          : new Uint8Array();

      const keyData = {
        id: row.id as number,
        publicKey,
        address: row.address as string,
        tokenAddress: row.token_address as string,
        pubkeyHash,
        accountIndex: row.account_index as number,
        changeIndex: row.change_index as number,
        addressIndex: row.address_index as number,
      };

      result.push(keyData);
    }

    statement.free();
    return result;
  }

  // Function to create and store keys in the database
  async function createKeys(
    wallet_id: number,
    accountNumber: number,
    changeNumber: number,
    addressNumber: number,
    networkType: Network // Accept networkType as a parameter
  ): Promise<void> {
    return enqueueCreateKeys(wallet_id, () =>
      createKeysUnlocked(
        wallet_id,
        accountNumber,
        changeNumber,
        addressNumber,
        networkType
      )
    );
  }

  function lookupExistingKeyRow(
    db: NonNullable<ReturnType<typeof dbService.getDatabase>>,
    address: string,
    tokenAddress: string
  ): {
    walletId: number | null;
    address: string | null;
    tokenAddress: string | null;
  } {
    const existingKeyDetailsQuery = db.prepare(`
      SELECT wallet_id, address, token_address
      FROM keys
      WHERE address = ? OR token_address = ?
      LIMIT 1;
    `);
    existingKeyDetailsQuery.bind([address, tokenAddress]);

    let existingWalletId: number | null = null;
    let existingAddress: string | null = null;
    let existingTokenAddress: string | null = null;
    if (existingKeyDetailsQuery.step()) {
      const row = existingKeyDetailsQuery.getAsObject();
      existingWalletId =
        typeof row.wallet_id === 'number'
          ? row.wallet_id
          : Number(row.wallet_id);
      existingAddress = typeof row.address === 'string' ? row.address : null;
      existingTokenAddress =
        typeof row.token_address === 'string' ? row.token_address : null;
    }
    existingKeyDetailsQuery.free();
    return {
      walletId: existingWalletId,
      address: existingAddress,
      tokenAddress: existingTokenAddress,
    };
  }

  async function createKeysUnlocked(
    wallet_id: number,
    accountNumber: number,
    changeNumber: number,
    addressNumber: number,
    networkType: Network
  ): Promise<void> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

    const { mnemonic, passphrase, derivationPath } =
      await getWalletSeedMaterial(wallet_id);

    const keys = await deriveBchChild(
      networkType,
      {
        mnemonic,
        passphrase,
        accountIndex: accountNumber,
        branchIndex: changeNumber,
        accountPath: derivationPath,
      },
      addressNumber
    );

    if (!(keys && 'privateKey' in keys)) {
      throw new Error('Failed to generate keys');
    }

    try {
      const ensureAddressRecord = async (): Promise<void> => {
        const prefix =
          networkType === Network.MAINNET ? PREFIX.mainnet : PREFIX.chipnet;
        const address: Address = {
          wallet_id,
          address: keys.address,
          token_address: keys.tokenAddress,
          balance: 0,
          hd_index: addressNumber,
          change_index: changeNumber,
          prefix,
        };

        await ManageAddress.registerAddress(address);
        await dbService.flushDatabaseToFile(wallet_id);
      };

      const existingKeyQuery = db.prepare(`
        SELECT COUNT(*) as count FROM keys WHERE address = ?;
      `);
      existingKeyQuery.bind([keys.address]);
      existingKeyQuery.step();
      const count = toCount(existingKeyQuery.getAsObject().count);
      existingKeyQuery.free();

      const existingTokenKeyQuery = db.prepare(`
        SELECT COUNT(*) as count FROM keys WHERE token_address = ?;
      `);
      existingTokenKeyQuery.bind([keys.tokenAddress]);
      existingTokenKeyQuery.step();
      const tokenCount = toCount(existingTokenKeyQuery.getAsObject().count);
      existingTokenKeyQuery.free();

      if (count > 0 || tokenCount > 0) {
        const existing = lookupExistingKeyRow(
          db,
          keys.address,
          keys.tokenAddress
        );

        // Same wallet already holds this derivation — idempotent (auto-fuse
        // and address UI may both mint the next index).
        if (
          existing.walletId === wallet_id &&
          existing.address === keys.address &&
          existing.tokenAddress === keys.tokenAddress
        ) {
          await ensureAddressRecord();
          return;
        }

        // Token/address row present under our wallet but metadata mismatched
        // (legacy import / partial row): treat as already ours if address matches.
        if (
          existing.walletId === wallet_id &&
          existing.address === keys.address
        ) {
          await ensureAddressRecord();
          return;
        }

        throw new Error(
          `Derived key already exists for wallet ${existing.walletId ?? 'unknown'}: ${keys.address} / ${keys.tokenAddress}`
        );
      }

      const encryptedPrivateKey = await SecretCryptoService.encryptBytes(
        keys.privateKey
      );
      const insertQuery = db.prepare(`
        INSERT INTO keys (wallet_id, public_key, private_key, address, token_address, pubkey_hash, account_index, change_index, address_index) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      try {
        insertQuery.run([
          wallet_id,
          keys.publicKey,
          encryptedPrivateKey,
          keys.address,
          keys.tokenAddress,
          keys.publicKeyHash,
          accountNumber,
          changeNumber,
          addressNumber,
        ]);
      } catch (error) {
        // Multi-window / interleaved mint: another writer won the race after
        // our existence check. If the row is already ours, succeed quietly
        // (raw "UNIQUE constraint failed: keys.token_address" was surfacing
        // on Auto Fusion status).
        if (isUniqueConstraintError(error)) {
          const existing = lookupExistingKeyRow(
            db,
            keys.address,
            keys.tokenAddress
          );
          if (
            existing.walletId === wallet_id &&
            existing.address === keys.address
          ) {
            await ensureAddressRecord();
            return;
          }
          throw new Error(
            `Derived key already exists for wallet ${existing.walletId ?? 'unknown'}: ${keys.address} / ${keys.tokenAddress}`
          );
        }
        throw error;
      } finally {
        insertQuery.free();
      }

      await ensureAddressRecord();
    } finally {
      zeroize(keys.privateKey);
    }
  }

  // Function to fetch private key by address
  async function fetchAddressPrivateKey(
    address: string
  ): Promise<Uint8Array | null> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    if (db == null) {
      throw new Error('Database is null');
    }

    const fetchAddressQuery = db.prepare(`
      SELECT private_key 
      FROM keys 
      WHERE address = ?;
    `);

    const result = fetchAddressQuery.get([address]) as unknown[] | undefined;
    fetchAddressQuery.free();

    if (!result || result.length === 0 || result[0] == null) {
      throw new Error(`No private key found for address: ${address}`);
    }

    const decoded = await decodePrivateKeyPayload(result[0]);
    if (decoded) {
      return decoded;
    }

    throw new Error(`Unsupported private key format for address: ${address}`);
  }
}

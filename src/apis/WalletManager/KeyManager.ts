import DatabaseService from '../DatabaseManager/DatabaseService';
import AddressManager from '../AddressManager/AddressManager';
import { Address, QuantumrootVaultRecord } from '../../types/types';
import { Network } from '../../redux/networkSlice';
import { PREFIX } from '../../utils/constants';
import { isArrayBufferLike, isString } from '../../utils/typeGuards';
import {
  deriveBchChild,
  deriveBchStandardXpubs,
  type DerivedBchPublicAddress,
  type BchStandardBranchName,
} from '../../services/HdWalletService';
import {
  deriveQuantumrootVault,
  toQuantumrootVaultRecord,
} from '../../services/QuantumrootService';
import SecretCryptoService, {
  isEncryptedPayload,
} from '../../services/SecretCryptoService';
import { zeroize } from '../../utils/secureMemory';

function toString(value: unknown): string {
  return isString(value) ? value : String(value);
}

function toCount(value: unknown): number {
  return typeof value === 'number' ? value : Number.parseInt(String(value), 10) || 0;
}

export default function KeyManager() {
  const dbService = DatabaseService();
  const ManageAddress = AddressManager();

  return {
    getXpubs,
    deriveAddressFromXpub,
    retrieveKeys,
    createKeys,
    fetchAddressPrivateKey,
    deriveQuantumrootVaultForWallet,
    createQuantumrootVault,
    configureQuantumrootVault,
    retrieveQuantumrootVaults,
  };

  function hasQuantumrootVaultDrift(
    existing: QuantumrootVaultRecord,
    next: QuantumrootVaultRecord
  ) {
    return (
      existing.receive_address !== next.receive_address ||
      existing.quantum_lock_address !== next.quantum_lock_address ||
      existing.receive_locking_bytecode !== next.receive_locking_bytecode ||
      existing.quantum_lock_locking_bytecode !== next.quantum_lock_locking_bytecode ||
      existing.quantum_public_key !== next.quantum_public_key ||
      existing.quantum_key_identifier !== next.quantum_key_identifier
    );
  }

  async function getWalletSeedMaterial(wallet_id: number) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

    const query = db.prepare(
      `SELECT mnemonic, passphrase, networkType FROM wallets WHERE id = ?;`
    );
    const row =
      (query.get([wallet_id]) as
        | (string | number | undefined)[]
        | undefined) ?? [];
    query.free();

    const mnemonic = await SecretCryptoService.decryptText(toString(row[0]));
    const passphrase = await SecretCryptoService.decryptText(toString(row[1]));
    const networkType =
      row[2] === Network.MAINNET
        ? Network.MAINNET
        : row[2] === Network.CHIPNET
          ? Network.CHIPNET
          : null;

    if (!mnemonic || !networkType) {
      throw new Error('Mnemonic or network not found for the given wallet id');
    }

    return {
      mnemonic,
      passphrase,
      networkType,
    };
  }

  async function getXpubs(
    wallet_id: number,
    accountNumber = 0
  ): Promise<Record<BchStandardBranchName, string>> {
    const { mnemonic, passphrase, networkType } = await getWalletSeedMaterial(wallet_id);
    return deriveBchStandardXpubs(networkType, mnemonic, passphrase, accountNumber);
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
    const { mnemonic, passphrase, networkType } = await getWalletSeedMaterial(wallet_id);
    return deriveQuantumrootVault(
      networkType,
      mnemonic,
      passphrase,
      accountNumber,
      addressIndex,
      onlineQuantumSigner,
      vaultTokenCategory
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

    const existingQuery = db.prepare(`
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
      WHERE wallet_id = ? AND account_index = ? AND address_index = ?;
    `);
    const existing = existingQuery.getAsObject([
      wallet_id,
      accountNumber,
      addressIndex,
    ]) as Record<string, unknown>;
    existingQuery.free();

    if (existing && Object.keys(existing).length > 0 && existing.receive_address != null) {
      const existingRecord = mapQuantumrootVaultRow(existing);
      const derivedVault = await deriveQuantumrootVaultForWallet(
        wallet_id,
        addressIndex,
        accountNumber,
        existingRecord.online_quantum_signer === 1 ? '1' : '0',
        existingRecord.vault_token_category
      );
      const nextRecord = toQuantumrootVaultRecord(
        wallet_id,
        accountNumber,
        derivedVault,
        existingRecord.online_quantum_signer,
        existingRecord.vault_token_category
      );

      if (!hasQuantumrootVaultDrift(existingRecord, nextRecord)) {
        return existingRecord;
      }

      return configureQuantumrootVault(
        wallet_id,
        addressIndex,
        accountNumber,
        existingRecord.online_quantum_signer,
        existingRecord.vault_token_category
      );
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

    const insertQuery = db.prepare(`
      INSERT INTO quantumroot_vaults (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    insertQuery.run([
      record.wallet_id,
      record.account_index,
      record.address_index,
      record.receive_address,
      record.quantum_lock_address,
      record.receive_locking_bytecode,
      record.quantum_lock_locking_bytecode,
      record.quantum_public_key,
      record.quantum_key_identifier,
      record.vault_token_category,
      record.online_quantum_signer,
      record.created_at,
      record.updated_at,
    ]);
    insertQuery.free();

    await dbService.flushDatabaseToFile();
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

    const existingQuery = db.prepare(`
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
      WHERE wallet_id = ? AND account_index = ? AND address_index = ?;
    `);
    const existing = existingQuery.getAsObject([
      wallet_id,
      accountNumber,
      addressIndex,
    ]) as Record<string, unknown>;
    existingQuery.free();

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

    if (existing && Object.keys(existing).length > 0 && existing.id != null) {
      record.id = typeof existing.id === 'number' ? existing.id : Number(existing.id);
      record.created_at =
        typeof existing.created_at === 'string' && existing.created_at.length > 0
          ? existing.created_at
          : record.created_at;
      record.updated_at = new Date().toISOString();

      const updateQuery = db.prepare(`
        UPDATE quantumroot_vaults
        SET
          receive_address = ?,
          quantum_lock_address = ?,
          receive_locking_bytecode = ?,
          quantum_lock_locking_bytecode = ?,
          quantum_public_key = ?,
          quantum_key_identifier = ?,
          vault_token_category = ?,
          online_quantum_signer = ?,
          updated_at = ?
        WHERE id = ?;
      `);
      updateQuery.run([
        record.receive_address,
        record.quantum_lock_address,
        record.receive_locking_bytecode,
        record.quantum_lock_locking_bytecode,
        record.quantum_public_key,
        record.quantum_key_identifier,
        record.vault_token_category,
        record.online_quantum_signer,
        record.updated_at,
        record.id,
      ]);
      updateQuery.free();
    } else {
      const insertQuery = db.prepare(`
        INSERT INTO quantumroot_vaults (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      insertQuery.run([
        record.wallet_id,
        record.account_index,
        record.address_index,
        record.receive_address,
        record.quantum_lock_address,
        record.receive_locking_bytecode,
        record.quantum_lock_locking_bytecode,
        record.quantum_public_key,
        record.quantum_key_identifier,
        record.vault_token_category,
        record.online_quantum_signer,
        record.created_at,
        record.updated_at,
      ]);
      insertQuery.free();
    }

    await dbService.flushDatabaseToFile();
    return record;
  }

  async function retrieveQuantumrootVaults(wallet_id: number): Promise<QuantumrootVaultRecord[]> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

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

    const records: QuantumrootVaultRecord[] = [];
    while (query.step()) {
      records.push(mapQuantumrootVaultRow(query.getAsObject() as Record<string, unknown>));
    }
    query.free();

    const refreshedRecords = await Promise.all(
      records.map(async (record) => {
        try {
        const derivedVault = await deriveQuantumrootVaultForWallet(
          wallet_id,
          record.address_index,
          record.account_index,
          record.online_quantum_signer === 1 ? '1' : '0',
          record.vault_token_category
        );
        const nextRecord = toQuantumrootVaultRecord(
          wallet_id,
          record.account_index,
          derivedVault,
          record.online_quantum_signer,
          record.vault_token_category
        );

        if (!hasQuantumrootVaultDrift(record, nextRecord)) {
          return record;
        }

        return configureQuantumrootVault(
          wallet_id,
          record.address_index,
          record.account_index,
          record.online_quantum_signer,
          record.vault_token_category
        );
        } catch (_error) {
          return record;
        }
      })
    );

    return refreshedRecords;
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
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      throw new Error('Database is null');
    }

    const { mnemonic, passphrase } = await getWalletSeedMaterial(wallet_id);

    const keys = await deriveBchChild(
      networkType,
      {
        mnemonic,
        passphrase,
        accountIndex: accountNumber,
        branchIndex: changeNumber,
      },
      addressNumber
    );

    if (keys && 'privateKey' in keys) {
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
        const existingKeyDetailsQuery = db.prepare(`
          SELECT wallet_id, address, token_address
          FROM keys
          WHERE address = ? OR token_address = ?
          LIMIT 1;
        `);
        existingKeyDetailsQuery.bind([
          keys.address,
          keys.tokenAddress,
        ]);

        let existingWalletId: number | null = null;
        let existingAddress: string | null = null;
        let existingTokenAddress: string | null = null;
        if (existingKeyDetailsQuery.step()) {
          const row = existingKeyDetailsQuery.getAsObject();
          existingWalletId =
            typeof row.wallet_id === 'number'
              ? row.wallet_id
              : Number(row.wallet_id);
          existingAddress =
            typeof row.address === 'string' ? row.address : null;
          existingTokenAddress =
            typeof row.token_address === 'string' ? row.token_address : null;
        }
        existingKeyDetailsQuery.free();

        if (
          existingWalletId === wallet_id &&
          existingAddress === keys.address &&
          existingTokenAddress === keys.tokenAddress
        ) {
          zeroize(keys.privateKey);
          return;
        }

        throw new Error(
          `Derived key already exists for wallet ${existingWalletId ?? 'unknown'}: ${keys.address} / ${keys.tokenAddress}`
        );
      }

      const encryptedPrivateKey = await SecretCryptoService.encryptBytes(
        keys.privateKey
      );
      const insertQuery = db.prepare(`
        INSERT INTO keys (wallet_id, public_key, private_key, address, token_address, pubkey_hash, account_index, change_index, address_index) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
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
      insertQuery.free();

      const prefix =
        networkType === Network.MAINNET ? PREFIX.mainnet : PREFIX.chipnet;
      const newAddress: Address = {
        wallet_id,
        address: keys.address,
        balance: 0,
        hd_index: addressNumber,
        change_index: changeNumber,
        prefix,
      };

      await ManageAddress.registerAddress(newAddress);
      await dbService.flushDatabaseToFile();
      zeroize(keys.privateKey);
    } else {
      throw new Error('Failed to generate keys');
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

    // Support either a binary blob (preferred) or base64 string (legacy/alternate)
    if (isArrayBufferLike(result[0])) {
      return new Uint8Array(result[0]);
    }
    if (isString(result[0])) {
      if (isEncryptedPayload(result[0])) {
        const decrypted = await SecretCryptoService.decryptBytes(result[0]);
        if (!decrypted) {
          throw new Error(`Invalid encrypted private key for address: ${address}`);
        }
        return decrypted;
      }
      return Uint8Array.from(atob(result[0]), (c) => c.charCodeAt(0));
    }

    throw new Error(`Unsupported private key format for address: ${address}`);
  }

  function mapQuantumrootVaultRow(row: Record<string, unknown>): QuantumrootVaultRecord {
    return {
      id: typeof row.id === 'number' ? row.id : Number(row.id),
      wallet_id:
        typeof row.wallet_id === 'number' ? row.wallet_id : Number(row.wallet_id),
      account_index:
        typeof row.account_index === 'number'
          ? row.account_index
          : Number(row.account_index),
      address_index:
        typeof row.address_index === 'number'
          ? row.address_index
          : Number(row.address_index),
      receive_address: toString(row.receive_address),
      quantum_lock_address: toString(row.quantum_lock_address),
      receive_locking_bytecode: toString(row.receive_locking_bytecode),
      quantum_lock_locking_bytecode: toString(row.quantum_lock_locking_bytecode),
      quantum_public_key: toString(row.quantum_public_key),
      quantum_key_identifier: toString(row.quantum_key_identifier),
      vault_token_category: toString(row.vault_token_category),
      online_quantum_signer:
        (typeof row.online_quantum_signer === 'number'
          ? row.online_quantum_signer
          : Number(row.online_quantum_signer)) === 1
          ? 1
          : 0,
      created_at: toString(row.created_at),
      updated_at: toString(row.updated_at),
    };
  }
}

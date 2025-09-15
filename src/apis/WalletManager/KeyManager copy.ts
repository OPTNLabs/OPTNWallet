/**
 * KeyManager.ts
 *
 * Purpose:
 * - Bridges DB persistence (sql.js via DatabaseService) with key generation (KeyGeneration).
 * - Retrieves existing keys for a wallet, inserts newly derived keys, and fetches private keys.
 * - Registers derived addresses via AddressManager.
 *
 * Data Flow:
 *   DB (wallets.mnemonic/passphrase) → KeyGeneration.generateKeys → DB(keys) → AddressManager.registerAddress
 *
 * @suggestion Transactions:
 * - Wrap multi-step operations (INSERT key + register address + save DB) in a single transaction to ensure atomicity.
 * - With sql.js, use `db.exec('BEGIN'); ... db.exec('COMMIT');` and `ROLLBACK` on error.
 *
 * @suggestion Uniqueness:
 * - Rely on DB UNIQUE constraints (on keys.address, keys.token_address) and catch errors instead of pre-check COUNT(*) — avoids race conditions.
 *
 * @suggestion Encoding:
 * - Centralize base64/Uint8Array conversions in a small utility (env-agnostic: browser/Node).
 */

import DatabaseService from '../DatabaseManager/DatabaseService';
import KeyGeneration from './KeyGeneration';
import AddressManager from '../AddressManager/AddressManager';
import { Address } from '../../types/types';
import { Network } from '../../redux/networkSlice';
import { PREFIX } from '../../utils/constants';

// Type guards and helper function for type conversions
function isString(value: any): value is string {
  return typeof value === 'string';
}

function isArrayBufferLike(value: any): value is ArrayBufferLike {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function toString(value: any): string {
  return isString(value) ? value : String(value);
}

export default function KeyManager() {
  const dbService = DatabaseService();
  const KeyGen = KeyGeneration();
  const ManageAddress = AddressManager();

  return {
    retrieveKeys,
    createKeys,
    fetchAddressPrivateKey,
  };

  /**
   * Retrieve all keys for a given wallet_id.
   *
   * @param wallet_id Numeric wallet identifier
   * @returns Array of objects with { id, publicKey, privateKey, address, tokenAddress, pubkeyHash, accountIndex, changeIndex, addressIndex }
   *
   * @suggestion:
   * - Consider pagination if wallets will have many derived addresses (thousands+).
   * - Consider returning a typed interface instead of untyped objects for safer consumption.
   */
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
        private_key, 
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

      const privateKey = isArrayBufferLike(row.private_key)
        ? new Uint8Array(row.private_key)
        : isString(row.private_key)
          ? Uint8Array.from(atob(row.private_key), (c) => c.charCodeAt(0))
          : new Uint8Array();

      const pubkeyHash = isArrayBufferLike(row.pubkey_hash)
        ? new Uint8Array(row.pubkey_hash)
        : isString(row.pubkey_hash)
          ? Uint8Array.from(atob(row.pubkey_hash), (c) => c.charCodeAt(0))
          : new Uint8Array();

      const keyData = {
        id: row.id as number,
        publicKey,
        privateKey,
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

  /**
   * Create and persist a new derived key pair and corresponding address records.
   *
   * @param wallet_id Wallet ID
   * @param accountNumber BIP44 account index
   * @param changeNumber 0 (external) or 1 (internal/change)
   * @param addressNumber Address index within the change branch
   * @param networkType Network (MAINNET or CHIPNET)
   *
   * @returns {Promise<void>}
   *
   * @throws If mnemonic is missing or keys already exist for the derived address
   *
   * @suggestion:
   * - Use a DB transaction: INSERT key + registerAddress + saveDatabase should be atomic.
   * - Replace pre-check COUNT(*) with straight INSERT and catch UNIQUE constraint violations (race-safe).
   * - Add an index on (wallet_id, account_index, change_index, address_index) if you frequently query by derivation path.
   */
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

    const getIdQuery = db.prepare(
      `SELECT mnemonic, passphrase FROM wallets WHERE id = ?;`
    );
    const row = getIdQuery.get([wallet_id]) as (string | number | undefined)[];
    getIdQuery.free();

    const result = dbService.resultToJSON([toString(row[0]), toString(row[1])]);

    if (!result.mnemonic) {
      throw new Error(
        'Mnemonic or passphrase not found for the given wallet id'
      );
    }

    const mnemonic = result.mnemonic;
    const passphrase = result.passphrase || '';

    const keys = await KeyGen.generateKeys(
      networkType,
      mnemonic,
      passphrase,
      accountNumber,
      changeNumber,
      addressNumber
    );

    if (keys) {
      const existingKeyQuery = db.prepare(`
        SELECT COUNT(*) as count FROM keys WHERE address = ?;
      `);
      existingKeyQuery.bind([keys.aliceAddress]);
      const count = existingKeyQuery.getAsObject().count as number;
      existingKeyQuery.free();

      if (count > 0) {
        throw new Error(`Key for address ${keys.aliceAddress} already exists`);
      }

      const existingTokenKeyQuery = db.prepare(`
        SELECT COUNT(*) as count FROM keys WHERE token_address = ?;
      `);
      existingTokenKeyQuery.bind([keys.aliceTokenAddress]);
      const tokenCount = existingTokenKeyQuery.getAsObject().count as number;
      existingTokenKeyQuery.free();

      if (tokenCount > 0) {
        throw new Error(
          `Key for token address ${keys.aliceTokenAddress} already exists`
        );
      }

      const insertQuery = db.prepare(`
        INSERT INTO keys (wallet_id, public_key, private_key, address, token_address, pubkey_hash, account_index, change_index, address_index) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      insertQuery.run([
        wallet_id,
        keys.alicePub,
        keys.alicePriv,
        keys.aliceAddress,
        keys.aliceTokenAddress,
        keys.alicePkh,
        accountNumber,
        changeNumber,
        addressNumber,
      ]);
      insertQuery.free();

      const prefix =
        networkType === Network.MAINNET ? PREFIX.mainnet : PREFIX.chipnet;
      const newAddress: Address = {
        wallet_id,
        address: keys.aliceAddress,
        balance: 0,
        hd_index: addressNumber,
        change_index: changeNumber,
        prefix,
      };

      await ManageAddress.registerAddress(newAddress);
      await dbService.saveDatabaseToFile();
    } else {
      throw new Error('Failed to generate keys');
    }
  }

  /**
   * Fetch the private key for a given address.
   *
   * @param address CashAddr address string
   * @returns Uint8Array private key or throws if not found
   *
   * @suggestion:
   * - This function calls `dbService.ensureDatabaseStarted()` synchronously (without await).
   *   Consider making this function `async` and awaiting to avoid race conditions on cold start.
   * - Centralize the base64/Uint8Array conversion in a shared util to avoid drift.
   * - Optionally expose a version that returns a WIF string if needed by downstream libs.
   */
  function fetchAddressPrivateKey(address: string): Uint8Array | null {
    dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    if (db == null) {
      throw new Error('Database is null');
    }

    const fetchAddressQuery = db.prepare(`
      SELECT private_key 
      FROM keys 
      WHERE address = ?;
    `);

    const result = fetchAddressQuery.get([address]) as any;
    fetchAddressQuery.free();

    // console.log(result);

    if (result && isArrayBufferLike(result[0])) {
      return new Uint8Array(result[0]);
    } else {
      throw new Error(`No private key found for address: ${address}`);
    }
  }
}

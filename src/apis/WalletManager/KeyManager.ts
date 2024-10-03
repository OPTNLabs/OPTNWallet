import DatabaseService from '../DatabaseManager/DatabaseService';
import KeyGeneration from './KeyGeneration';
import AddressManager from '../AddressManager/AddressManager';
import { Address } from '../../types/types';

// Type guard to check if a value is a string
function isString(value: any): value is string {
  return typeof value === 'string';
}

// Type guard to check if a value is an ArrayBufferLike (Uint8Array or ArrayBuffer)
function isArrayBufferLike(value: any): value is ArrayBufferLike {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

// Helper function to convert any type to string safely
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

  // Function to retrieve keys from the database
  async function retrieveKeys(wallet_id: number) {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (db == null) {
        console.error('Database is null');
        return [];
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

        // console.log('Retrieved raw row from keys table:', row); // Log each row

        const publicKey = isArrayBufferLike(row.public_key)
          ? new Uint8Array(row.public_key)
          : isString(row.public_key)
            ? Uint8Array.from(atob(row.public_key), (c) => c.charCodeAt(0))
            : new Uint8Array(); // Handle as empty if neither condition is met

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

        // console.log('Formatted key data:', keyData); // Log the formatted key data

        result.push(keyData);
      }

      statement.free();
      // console.log('Keys retrieved:', result); // Log the full result
      return result;
    } catch (error) {
      console.error('Error retrieving keys:', error);
      throw error;
    }
  }

  // Function to create and store keys in the database
  async function createKeys(
    wallet_id: number,
    accountNumber: number,
    changeNumber: number,
    addressNumber: number
  ): Promise<void> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (db == null) {
        console.error('Database is null');
        return;
      }

      const getIdQuery = db.prepare(
        `SELECT mnemonic, passphrase FROM wallets WHERE id = ?;`
      );
      const row = getIdQuery.get([wallet_id]) as (
        | string
        | number
        | undefined
      )[];
      getIdQuery.free();

      const result = dbService.resultToJSON([
        toString(row[0]),
        toString(row[1]),
      ]);

      console.log('Result from wallets table:', result); // Log the wallet details

      if (!result.mnemonic) {
        console.error(
          'Mnemonic or passphrase not found for the given wallet id'
        );
        return;
      }
      const mnemonic = result.mnemonic;
      const passphrase = result.passphrase || '';

      console.log('Generating keys with:', {
        mnemonic,
        passphrase,
        accountNumber,
        changeNumber,
        addressNumber,
      });

      const keys = await KeyGen.generateKeys(
        mnemonic,
        passphrase,
        accountNumber,
        changeNumber,
        addressNumber
      );

      if (keys) {
        console.log('Generated keys:', keys); // Log the generated keys

        const existingKeyQuery = db.prepare(`
          SELECT COUNT(*) as count FROM keys WHERE address = ?;
        `);
        existingKeyQuery.bind([keys.aliceAddress]);
        const count = existingKeyQuery.getAsObject().count as number;
        if (count > 0) {
          console.log(
            `Key for address ${keys.aliceAddress} already exists. Skipping...`
          );
          existingKeyQuery.free();
          return;
        }
        existingKeyQuery.free();

        const publicKey = keys.alicePub;
        const privateKey = keys.alicePriv;
        const address = keys.aliceAddress;
        const tokenAddress = keys.aliceTokenAddress;
        const pubkeyHash = keys.alicePkh;

        console.log('Inserting keys into database:', {
          wallet_id,
          publicKey,
          privateKey,
          address,
          tokenAddress,
          pubkeyHash,
          accountNumber,
          changeNumber,
          addressNumber,
        }); // Log the keys being inserted

        const insertQuery = db.prepare(`
          INSERT INTO keys (wallet_id, public_key, private_key, address, token_address, pubkey_hash, account_index, change_index, address_index) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        `);
        insertQuery.run([
          wallet_id,
          publicKey,
          privateKey,
          address,
          tokenAddress,
          pubkeyHash,
          accountNumber,
          changeNumber,
          addressNumber,
        ]);
        insertQuery.free();

        const newAddress: Address = {
          wallet_id: wallet_id,
          address: keys.aliceAddress,
          balance: 0,
          hd_index: addressNumber,
          change_index: changeNumber,
          prefix: 'bchtest',
        };

        console.log('Registering new address:', newAddress); // Log the new address

        await ManageAddress.registerAddress(newAddress);
        await dbService.saveDatabaseToFile();
        console.log('Keys created and saved successfully.');
      } else {
        console.error('Failed to generate keys.');
      }
    } catch (error) {
      console.error('Error creating keys:', error);
      throw error;
    }
  }

  // Function to fetch private key by address
  function fetchAddressPrivateKey(address: string): Uint8Array | null {
    console.log('Attempting to fetch private key for address:', address);

    // Ensure the database is started
    dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    // Check if the database is properly initialized
    if (db == null) {
      console.error('Database is null, cannot fetch private key');
      return null;
    }

    console.log('Database connection established.');

    // Prepare the query to fetch the private key from the database
    const fetchAddressQuery = db.prepare(`
    SELECT private_key 
    FROM keys 
    WHERE address = ?;
  `);

    console.log('Query prepared to fetch private key for address:', address);

    // Get the result
    const result = fetchAddressQuery.get([address]) as any;
    fetchAddressQuery.free();

    // Log the raw result
    console.log('Raw query result:', result);

    // Check if the result is a valid array with the Uint8Array inside
    if (
      Array.isArray(result) &&
      result.length > 0 &&
      result[0] instanceof Uint8Array
    ) {
      const privateKey = result[0];
      console.log('Private key extracted:', privateKey);
      return privateKey;
    } else {
      console.warn('No private key found for address:', address);
      return null;
    }
  }
}

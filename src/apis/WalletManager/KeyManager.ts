import DatabaseService from '../DatabaseManager/DatabaseService';
import KeyGeneration from './KeyGeneration';
import AddressManager from '../AddressManager/AddressManager';
import { Address } from '../../types/types';
import { Network } from '../../redux/networkSlice';
import { PREFIX } from '../../utils/constants';
import { isArrayBufferLike, isString } from '../../utils/typeGuards';
import SecretCryptoService, {
  isEncryptedPayload,
} from '../../services/SecretCryptoService';
import { zeroize } from '../../utils/secureMemory';

function toString(value: unknown): string {
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

    const getIdQuery = db.prepare(
      `SELECT mnemonic, passphrase FROM wallets WHERE id = ?;`
    );
    const row =
      (getIdQuery.get([wallet_id]) as
        | (string | number | undefined)[]
        | undefined) ?? [];
    getIdQuery.free();

    const encryptedMnemonic = toString(row[0]);
    const encryptedPassphrase = toString(row[1]);
    const mnemonic = await SecretCryptoService.decryptText(encryptedMnemonic);
    const passphrase = await SecretCryptoService.decryptText(
      encryptedPassphrase
    );

    if (!mnemonic) {
      throw new Error(
        'Mnemonic or passphrase not found for the given wallet id'
      );
    }

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

      const encryptedPrivateKey = await SecretCryptoService.encryptBytes(
        keys.alicePriv
      );
      const insertQuery = db.prepare(`
        INSERT INTO keys (wallet_id, public_key, private_key, address, token_address, pubkey_hash, account_index, change_index, address_index) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      insertQuery.run([
        wallet_id,
        keys.alicePub,
        encryptedPrivateKey,
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
      zeroize(keys.alicePriv);
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
}

import DatabaseService from '../DatabaseManager/DatabaseService';
import AddressManager from '../AddressManager/AddressManager';
import { Address } from '../../types/types';
import { Network } from '../../redux/networkSlice';
import { PREFIX } from '../../utils/constants';
import { isArrayBufferLike, isString } from '../../utils/typeGuards';
import {
  deriveBchChild,
  deriveBchStandardXpubs,
  type DerivedBchPublicAddress,
  type BchStandardBranchName,
} from '../../services/HdWalletService';
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
  };

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
}

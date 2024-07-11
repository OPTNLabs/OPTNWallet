// @ts-nocheck
import DatabaseService from '../DatabaseManager/DatabaseService';
import KeyGeneration from './KeyGeneration';
import AddressManager from '../AddressManager/AddressManager';
import { Address } from '../types';
import bip39 from 'bip39';

export default function KeyManager() {
  const dbService = DatabaseService();
  const KeyGen = KeyGeneration();
  const ManageAddress = AddressManager();

  return {
    retrieveKeys,
    createKeys,
    fetchAddressPrivateKey,
  };

  async function retrieveKeys(wallet_id: number): Promise<
    {
      id: number;
      publicKey: Uint8Array;
      privateKey: Uint8Array;
      address: string;
      tokenAddress: string;
      accountIndex: number;
      changeIndex: number;
      addressIndex: number;
    }[]
  > {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (db == null) {
        return [];
      }

      const query = `
                SELECT 
                    id, 
                    public_key, 
                    private_key, 
                    address,
                    token_address,
                    account_index,
                    change_index,
                    address_index
                FROM keys 
                WHERE wallet_id = :walletid
            `;
      const statement = db.prepare(query);
      statement.bind({ ':walletid': wallet_id });

      const result: {
        id: number;
        publicKey: Uint8Array;
        privateKey: Uint8Array;
        address: string;
        tokenAddress: string;
        accountIndex: number;
        changeIndex: number;
        addressIndex: number;
      }[] = [];

      while (statement.step()) {
        const row = statement.getAsObject();
        result.push({
          id: row.id as number,
          publicKey: new Uint8Array(row.public_key),
          privateKey: new Uint8Array(row.private_key),
          address: row.address as string,
          tokenAddress: row.token_address as string,
          accountIndex: row.account_index as number,
          changeIndex: row.change_index as number,
          addressIndex: row.address_index as number,
        });
      }

      statement.free();
      return result;
    } catch (error) {
      console.error('Error retrieving keys:', error);
      throw error;
    }
  }

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
        return;
      }

      const getIdQuery = db.prepare(
        `SELECT 
                    mnemonic, 
                    passphrase 
                FROM wallets 
                WHERE id = ?;`
      );
      const result = getIdQuery.get([wallet_id]);
      getIdQuery.free();

      if (!result) {
        console.error(
          'Mnemonic or passphrase not found for the given wallet name'
        );
        return;
      }
      const mnemonic = JSON.stringify(result[0]).replace(/^"|"$/g, '');
      const passphrase = JSON.stringify(result[1]).replace(/^"|"$/g, '');

      const keys = await KeyGen.generateKeys(
        mnemonic,
        passphrase,
        accountNumber,
        changeNumber,
        addressNumber
      );

      if (keys) {
        const publicKey = keys.alicePub;
        const privateKey = keys.alicePriv;
        const address = keys.aliceAddress;
        const tokenAddress = keys.aliceTokenAddress;

        const insertQuery = db.prepare(`
                    INSERT INTO keys (wallet_id, public_key, private_key, address, token_address, account_index, change_index, address_index) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                `);
        insertQuery.run([
          wallet_id,
          publicKey,
          privateKey,
          address,
          tokenAddress,
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

        await ManageAddress.registerAddress(newAddress);
        await dbService.saveDatabaseToFile();
      }
    } catch (error) {
      console.error('Error creating keys:', error);
      throw error;
    }
  }

  function fetchAddressPrivateKey(address: string) {
    dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      return null;
    }
    const fetchAddressQuery = db.prepare(`
            SELECT private_key 
            FROM keys 
            WHERE address = ?;
        `);
    const result = fetchAddressQuery.get([address]);
    fetchAddressQuery.free();
    return result;
  }
}

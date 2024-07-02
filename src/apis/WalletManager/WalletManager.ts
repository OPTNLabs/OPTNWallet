// @ts-nocheck
import { hexToBin } from "@bitauth/libauth";
import KeyManager from "./KeyManager";
import { createTables } from "../../utils/schema/schema";
import DatabaseService from "../DatabaseManager/DatabaseService";

const KeyManage = KeyManager();

export default function WalletManager() {
  return {
    createInputs,
    createWallet,
    checkAccount,
    setWalletId
  };

  async function setWalletId(
    mnemonic: string,
    passphrase: string
  ): number {
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      return null;
    }
    createTables(db);
    try {
      const query = db.prepare(
        `SELECT id FROM wallets WHERE mnemonic = :mnemonic AND passphrase = :passphrase`
      );
      query.bind({ ':mnemonic' : mnemonic, ':passphrase' : passphrase });
      let walletId: number | null = null;
      

      while (query.step()) {
        const row = query.getAsObject();
        if (row.id) {
          walletId = row.id;
          break; 
        }
      }
      query.free(); 
      return walletId;
    } catch (error) {
      console.error('Error setting wallet ID:', error);
      return null;
    }
  }

  async function checkAccount(
    mnemonic: string,
    passphrase: string
  ): Promise<boolean> {

    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      return null;
    }

    createTables(db);
    try {
      const query = db.prepare(
        `SELECT COUNT(*) as count FROM wallets WHERE mnemonic = ? AND passphrase = ?`
      );
      query.bind([mnemonic, passphrase]);
      
      let accountExists = false;
  
      while (query.step()) {
        const row = query.getAsObject();
        if (row.count > 0) {
          accountExists = true;
        }
      }
  
      query.free(); // Free the query to avoid memory leaks
  
      return accountExists;
    } catch (error) {
      console.error('Error checking account:', error);
      return false;
    }
  }

  async function createWallet(
    wallet_name: string,
    mnemonic: string,
    passphrase: string
  ): Promise<bool> {
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      return null;
    }
    createTables(db);
    
    const query = db.prepare(
        `SELECT COUNT(*) as count FROM wallets WHERE mnemonic = ? AND passphrase = ?`
    );
    query.bind([mnemonic, passphrase]);
    
    let accountExists = false;

    while (query.step()) {
        const row = query.getAsObject();
        if (row.count > 0) {
            accountExists = true;
        }
    }

    if (accountExists) {
        return false;
    }
    const createAccountQuery = db.prepare(
      "INSERT INTO wallets (wallet_name, mnemonic, passphrase, balance) VALUES (?, ?, ?, ?);"
    );
    createAccountQuery.run([wallet_name, mnemonic, passphrase, 0]);
    
    createAccountQuery.free();
    await dbService.saveDatabaseToFile();
    return true;
  }

  function createInputs(inputs: any, compiler) {
    const transactionInputs = inputs.map((input) => ({
      outpointTransactionHash: hexToBin(input.tx_hash),
      outpointIndex: input.tx_pos,
      sequenceNumber: 0,
      unlockingBytecode: {
        compiler,
        script: "unlock",
        valueSatoshis: BigInt(input.value),
        data: {
          keys: {
            privateKeys: {
              key: KeyManage.fetchAddressPrivateKey(input.address),
            },
          },
        },
      },
    }));
    return transactionInputs;
  }
}

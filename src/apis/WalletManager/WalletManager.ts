// @ts-expect-error
import { hexToBin } from '@bitauth/libauth';
import KeyManager from './KeyManager';
import { createTables } from '../../utils/schema/schema';
import DatabaseService from '../DatabaseManager/DatabaseService';

const KeyManage = KeyManager();

export default function WalletManager() {
  return {
    createWallet,
    checkAccount,
    checkAnyWallet,
    setWalletId,
    deleteWallet,
    walletExists,
    getWalletInfo,
    clearAllData, // Add this
  };

  async function clearAllData(): Promise<void> {
    const dbService = DatabaseService();
    await dbService.clearDatabase(); // Call clearDatabase function
  }

  async function deleteWallet(wallet_id: number): Promise<boolean | null> {
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      return null;
    }
    createTables(db);

    try {
      let query = db.prepare(`DELETE FROM wallets WHERE id = :walletid`);
      query.bind({ ':walletid': wallet_id });
      query.run();

      query = db.prepare(`DELETE FROM keys WHERE wallet_id = :walletid`);
      query.bind({ ':walletid': wallet_id });
      query.run();

      query = db.prepare(`DELETE FROM addresses WHERE wallet_id = :walletid`);
      query.bind({ ':walletid': wallet_id });
      query.run();

      query = db.prepare(`DELETE FROM UTXOs WHERE wallet_id = :walletid`);
      query.bind({ ':walletid': wallet_id });
      query.run();

      // Also delete from other tables as needed
      query = db.prepare(
        `DELETE FROM cashscript_artifacts WHERE id IN (SELECT artifact_id FROM cashscript_addresses WHERE wallet_id = :walletid)`
      );
      query.bind({ ':walletid': wallet_id });
      query.run();

      query = db.prepare(
        `DELETE FROM cashscript_addresses WHERE wallet_id = :walletid`
      );
      query.bind({ ':walletid': wallet_id });
      query.run();

      query = db.prepare(
        `DELETE FROM instantiated_contracts WHERE address IN (SELECT address FROM cashscript_addresses WHERE wallet_id = :walletid)`
      );
      query.bind({ ':walletid': wallet_id });
      query.run();

      await dbService.saveDatabaseToFile();
      return true;
    } catch (e) {
      console.log(e);
      return false;
    }
  }

  async function walletExists(): Promise<number | null> {
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      console.log('Database not started.');
      return null;
    }

    createTables(db);
    try {
      const query = db.prepare(`SELECT id FROM wallets LIMIT 1`);

      let walletId: number | null = null;

      if (query.step()) {
        const row = query.getAsObject();
        walletId = row.id;
        console.log(`Found wallet ID: ${walletId}`);
      } else {
        console.log('No wallet found in the database.');
      }

      query.free();
      return walletId;
    } catch (error) {
      console.error('Error checking wallet existence:', error);
      return null;
    }
  }

  async function setWalletId(mnemonic: string, passphrase: string): number {
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
      query.bind({ ':mnemonic': mnemonic, ':passphrase': passphrase });
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
      return false;
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

      const queryMnemonic = db.prepare(
        `SELECT COUNT(*) as count FROM wallets WHERE mnemonic = ?`
      );
      queryMnemonic.bind([mnemonic]);

      while (queryMnemonic.step()) {
        const rowMnemonic = queryMnemonic.getAsObject();
        if (rowMnemonic.count > 0) {
          accountExists = true;
        }
      }

      query.free();
      queryMnemonic.free();
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
  ): Promise<boolean> {
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      return false;
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
      'INSERT INTO wallets (wallet_name, mnemonic, passphrase, balance) VALUES (?, ?, ?, ?);'
    );
    createAccountQuery.run([wallet_name, mnemonic, passphrase, 0]);
    createAccountQuery.free();
    await dbService.saveDatabaseToFile();
    return true;
  }

  async function checkAnyWallet(): Promise<boolean> {
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      return false;
    }

    createTables(db);
    try {
      const query = db.prepare('SELECT COUNT(*) as count FROM wallets');
      let walletExists = false;

      if (query.step()) {
        const row = query.getAsObject();
        if (row.count > 0) {
          walletExists = true;
        }
      }

      query.free();
      return walletExists;
    } catch (error) {
      console.error('Error checking for any wallet:', error);
      return false;
    }
  }

  async function getWalletInfo(walletId: number) {
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      console.log('Database not started.');
      return null;
    }

    createTables(db);
    try {
      const query = db.prepare(`SELECT * FROM wallets WHERE id = ?`);
      query.bind([walletId]);

      let walletInfo = null;

      if (query.step()) {
        walletInfo = query.getAsObject();
      }

      query.free();
      return walletInfo;
    } catch (error) {
      console.error('Error getting wallet info:', error);
      return null;
    }
  }
}

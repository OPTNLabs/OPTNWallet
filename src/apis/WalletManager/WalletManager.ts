import { createTables } from '../../utils/schema/schema';
import DatabaseService from '../DatabaseManager/DatabaseService';
import { Network } from '../../redux/networkSlice';
import SecretCryptoService from '../../services/SecretCryptoService';
import { WalletLookup, WalletRecord, WalletType } from '../../types/wallet';

// Helper function to safely cast SQL values to number
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : parseInt(String(value), 10);
}

export default function WalletManager() {
  return {
    createWallet,
    checkAccount,
    checkAnyWallet,
    setWalletId,
    deleteWallet,
    walletExists,
    getWalletInfo,
    clearAllData,
  };

  async function clearAllData(): Promise<void> {
    const dbService = DatabaseService();
    await dbService.clearDatabase(); // Call clearDatabase function
    // await dbService.saveDatabaseToFile();
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

      query = db.prepare(`DELETE FROM quantumroot_vaults WHERE wallet_id = :walletid`);
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

      // await dbService.saveDatabaseToFile();
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  async function walletExists(): Promise<number | null> {
    const dbService = DatabaseService();
    const db = dbService.getDatabase();
    if (!db) {
      console.error('Database not started.');
      return null;
    }

    createTables(db);
    try {
      const query = db.prepare(`SELECT id FROM wallets LIMIT 1`);

      let walletId: number | null = null;

      if (query.step()) {
        const row = query.getAsObject();
        walletId = toNumber(row.id); // Explicitly cast to number
        // console.log(`Found wallet ID: ${walletId}`);
      } else {
        console.error('No wallet found in the database.');
      }

      query.free();
      return walletId;
    } catch (error) {
      console.error('Error checking wallet existence:', error);
      return null;
    }
  }

  async function setWalletId(
    mnemonic: string,
    passphrase: string,
    lookup?: Pick<WalletLookup, 'networkType' | 'walletType'>
  ): Promise<number | null> {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      return null;
    }
    createTables(db);
    try {
      const query = db.prepare(
        `SELECT id, mnemonic, passphrase, networkType, walletType FROM wallets`
      );
      let walletId: number | null = null;
      while (query.step()) {
        const row = query.getAsObject() as Record<string, unknown>;
        const rowMnemonic = await SecretCryptoService.decryptText(
          typeof row.mnemonic === 'string' ? row.mnemonic : ''
        );
        const rowPassphrase = await SecretCryptoService.decryptText(
          typeof row.passphrase === 'string' ? row.passphrase : ''
        );
        const rowNetwork =
          row.networkType === Network.MAINNET
            ? Network.MAINNET
            : row.networkType === Network.CHIPNET
              ? Network.CHIPNET
              : null;
        const rowWalletType =
          row.walletType === WalletType.QUANTUMROOT
            ? WalletType.QUANTUMROOT
            : WalletType.STANDARD;
        const networkMatches =
          lookup?.networkType === undefined || rowNetwork === lookup.networkType;
        const walletTypeMatches =
          lookup?.walletType === undefined ||
          rowWalletType === lookup.walletType;

        if (
          rowMnemonic === mnemonic &&
          rowPassphrase === passphrase &&
          networkMatches &&
          walletTypeMatches
        ) {
          walletId = toNumber(row.id);
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
    passphrase: string,
    lookup?: Pick<WalletLookup, 'networkType' | 'walletType'>
  ): Promise<boolean> {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      return false;
    }

    createTables(db);
    try {
      const query = db.prepare(
        `SELECT mnemonic, passphrase, networkType, walletType FROM wallets`
      );
      let accountExists = false;

      while (query.step()) {
        const row = query.getAsObject() as Record<string, unknown>;
        const rowMnemonic = await SecretCryptoService.decryptText(
          typeof row.mnemonic === 'string' ? row.mnemonic : ''
        );
        const rowPassphrase = await SecretCryptoService.decryptText(
          typeof row.passphrase === 'string' ? row.passphrase : ''
        );
        const rowNetwork =
          row.networkType === Network.MAINNET
            ? Network.MAINNET
            : row.networkType === Network.CHIPNET
              ? Network.CHIPNET
              : null;
        const rowWalletType =
          row.walletType === WalletType.QUANTUMROOT
            ? WalletType.QUANTUMROOT
            : WalletType.STANDARD;
        const networkMatches =
          lookup?.networkType === undefined || rowNetwork === lookup.networkType;
        const walletTypeMatches =
          lookup?.walletType === undefined ||
          rowWalletType === lookup.walletType;
        if (
          rowMnemonic === mnemonic &&
          rowPassphrase === passphrase &&
          networkMatches &&
          walletTypeMatches
        ) {
          accountExists = true;
          break;
        }
      }

      query.free();
      return accountExists;
    } catch (error) {
      console.error('Error checking account:', error);
      return false;
    }
  }

  async function createWallet(
    wallet_name: string,
    mnemonic: string,
    passphrase: string,
    networkType: Network,
    walletType: WalletType = WalletType.STANDARD
  ): Promise<boolean> {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      return false;
    }

    createTables(db);
    const accountExists = await checkAccount(mnemonic, passphrase, {
      networkType,
      walletType,
    });
    if (accountExists) {
      return false;
    }

    const encryptedMnemonic = await SecretCryptoService.encryptText(mnemonic);
    const encryptedPassphrase =
      await SecretCryptoService.encryptText(passphrase);
    const createAccountQuery = db.prepare(
      'INSERT INTO wallets (wallet_name, mnemonic, passphrase, networkType, walletType, balance) VALUES (?, ?, ?, ?, ?, ?);'
    );
    createAccountQuery.run([
      wallet_name,
      encryptedMnemonic,
      encryptedPassphrase,
      networkType,
      walletType,
      0,
    ]);
    createAccountQuery.free();
    await dbService.flushDatabaseToFile();
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
        if (toNumber(row.count) > 0) {
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
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      console.error('Database not started.');
      return null;
    }

    createTables(db);
    try {
      const query = db.prepare(`SELECT * FROM wallets WHERE id = ?`);
      query.bind([walletId]);

      let walletInfo = null;

      if (query.step()) {
        const rawWalletInfo = query.getAsObject() as Record<string, unknown>;
        const networkType =
          rawWalletInfo.networkType === Network.MAINNET
            ? Network.MAINNET
            : rawWalletInfo.networkType === Network.CHIPNET
              ? Network.CHIPNET
              : null;
        const walletType =
          rawWalletInfo.walletType === WalletType.QUANTUMROOT
            ? WalletType.QUANTUMROOT
            : WalletType.STANDARD;
        walletInfo = {
          ...rawWalletInfo,
          networkType,
          walletType,
        } as Record<string, unknown>;
        if (typeof walletInfo.mnemonic === 'string') {
          walletInfo.mnemonic = await SecretCryptoService.decryptText(
            walletInfo.mnemonic
          );
        }
        if (typeof walletInfo.passphrase === 'string') {
          walletInfo.passphrase = await SecretCryptoService.decryptText(
            walletInfo.passphrase
          );
        }
      }

      query.free();
      return walletInfo as WalletRecord | null;
    } catch (error) {
      console.error('Error getting wallet info:', error);
      return null;
    }
  }
}

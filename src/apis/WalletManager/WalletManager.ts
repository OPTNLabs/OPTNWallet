import { createTables } from '../../utils/schema/schema';
import DatabaseService from '../DatabaseManager/DatabaseService';
import { Network } from '../../state/slices/networkSlice';
import SecretCryptoService from '../../services/SecretCryptoService';
import QuantumrootVaultCacheService from '../../services/QuantumrootVaultCacheService';
import WalletDiscoveryService from '../../services/WalletDiscoveryService';
import {
  WalletLookup,
  WalletRecord,
  WalletType,
  type ExtendedWalletType,
  type WalletMetadata,
} from '../../types/wallet';
import { DerivationPathSource } from '../../types/wallet';
import { getBchAccountPath, normalizeBchAccountPath } from '../../services/HdWalletService';

// Helper function to safely cast SQL values to number
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : parseInt(String(value), 10);
}

/**
 * Map a stored walletType TEXT value to the app's type union. Unknown values
 * fall back to STANDARD exactly as before; desktop-only types (watch-only) are
 * passed through rather than erased, because a watch-only row has no mnemonic
 * and must not be treated as a signing standard wallet.
 */
function normalizeWalletType(raw: unknown): ExtendedWalletType {
  if (raw === WalletType.QUANTUMROOT) return WalletType.QUANTUMROOT;
  if (raw === 'watch-only') return 'watch-only';
  // Desktop USB hardware keystore (Ledger etc.) — public keys on disk, signs on device.
  if (raw === 'hardware') return 'hardware';
  return WalletType.STANDARD;
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
    getWalletMetadata,
    getAllWallets,
    clearAllData,
  };

  // Lists wallets without decrypting mnemonic/passphrase — for a wallet
  // picker/switcher UI. Desktop-only today (mobile has exactly one implicit
  // wallet and no switcher UI), but this is a plain read with no encryption
  // dependency, so it's safe to expose from the shared manager.
  async function getAllWallets(): Promise<
    Array<Pick<WalletRecord, 'id' | 'wallet_name' | 'networkType' | 'walletType'>>
  > {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      return [];
    }

    createTables(db);
    try {
      const query = db.prepare(
        `SELECT id, wallet_name, networkType, walletType FROM wallets ORDER BY id ASC`
      );
      const rows: Array<Pick<WalletRecord, 'id' | 'wallet_name' | 'networkType' | 'walletType'>> = [];
      while (query.step()) {
        const row = query.getAsObject() as Record<string, unknown>;
        const networkType =
          row.networkType === Network.MAINNET
            ? Network.MAINNET
            : row.networkType === Network.CHIPNET
              ? Network.CHIPNET
              : Network.MAINNET;
        const walletType =
          row.walletType === WalletType.QUANTUMROOT
            ? WalletType.QUANTUMROOT
            : normalizeWalletType(row.walletType);
        rows.push({
          id: toNumber(row.id),
          wallet_name: typeof row.wallet_name === 'string' ? row.wallet_name : '',
          networkType,
          walletType,
        });
      }
      query.free();
      return rows;
    } catch (error) {
      console.error('Error listing wallets:', error);
      return [];
    }
  }

  /**
   * Read only the public fields required to establish a wallet session.
   * Unlock already proved the candidate key against the encrypted mnemonic;
   * decrypting both secrets again merely to learn the network/path delayed the
   * route transition and unnecessarily widened secret exposure in memory.
   */
  async function getWalletMetadata(
    walletId: number
  ): Promise<WalletMetadata | null> {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) return null;

    createTables(db);
    try {
      const query = db.prepare(
        `SELECT id, wallet_name, networkType, walletType, balance,
                derivation_path, derivation_path_source
           FROM wallets WHERE id = ?`
      );
      query.bind([walletId]);
      if (!query.step()) {
        query.free();
        return null;
      }
      const row = query.getAsObject() as Record<string, unknown>;
      query.free();

      const networkType =
        row.networkType === Network.MAINNET
          ? Network.MAINNET
          : row.networkType === Network.CHIPNET
            ? Network.CHIPNET
            : null;
      const walletType =
        row.walletType === WalletType.QUANTUMROOT
          ? WalletType.QUANTUMROOT
          : normalizeWalletType(row.walletType);
      const fallbackNetwork = networkType ?? Network.MAINNET;
      let derivationPath = getBchAccountPath(fallbackNetwork);
      if (typeof row.derivation_path === 'string') {
        try {
          derivationPath = normalizeBchAccountPath(row.derivation_path);
        } catch {
          // Repair malformed/legacy metadata to the network default in memory.
        }
      }

      return {
        id: toNumber(row.id),
        wallet_name:
          typeof row.wallet_name === 'string' ? row.wallet_name : null,
        networkType,
        walletType,
        balance:
          row.balance === null || row.balance === undefined
            ? null
            : toNumber(row.balance),
        derivation_path: derivationPath,
        derivation_path_source:
          row.derivation_path_source === 'custom' ? 'custom' : 'default',
      };
    } catch (error) {
      console.error('Error getting wallet metadata:', error);
      return null;
    }
  }

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

      query = db.prepare(
        `DELETE FROM wallet_special_activities WHERE wallet_id = :walletid`
      );
      query.bind({ ':walletid': wallet_id });
      query.run();

      query = db.prepare(`DELETE FROM quantumroot_vaults WHERE wallet_id = :walletid`);
      query.bind({ ':walletid': wallet_id });
      query.run();
      QuantumrootVaultCacheService.clear(wallet_id);
      WalletDiscoveryService.clear(wallet_id);

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
    walletType: WalletType = WalletType.STANDARD,
    derivationPath = getBchAccountPath(networkType),
    derivationPathSource: DerivationPathSource = 'default'
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

    const normalizedDerivationPath = normalizeBchAccountPath(derivationPath);

    const encryptedMnemonic = await SecretCryptoService.encryptText(mnemonic);
    const encryptedPassphrase =
      await SecretCryptoService.encryptText(passphrase);
    const createAccountQuery = db.prepare(
      'INSERT INTO wallets (wallet_name, mnemonic, passphrase, networkType, walletType, balance, derivation_path, derivation_path_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?);'
    );
    createAccountQuery.run([
      wallet_name,
      encryptedMnemonic,
      encryptedPassphrase,
      networkType,
      walletType,
      0,
      normalizedDerivationPath,
      derivationPathSource,
    ]);
    createAccountQuery.free();
    const idResult = db.exec('SELECT last_insert_rowid()');
    const localWalletId = toNumber(idResult?.[0]?.values?.[0]?.[0]);
    if (!Number.isSafeInteger(localWalletId) || localWalletId <= 0) {
      throw new Error('Unable to identify the newly-created wallet.');
    }
    await dbService.persistNewWalletToFile(localWalletId);
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
            : normalizeWalletType(rawWalletInfo.walletType);
        const fallbackNetwork = networkType ?? Network.MAINNET;
        let derivationPath = getBchAccountPath(fallbackNetwork);
        if (typeof rawWalletInfo.derivation_path === 'string') {
          try {
            derivationPath = normalizeBchAccountPath(rawWalletInfo.derivation_path);
          } catch {
            // A legacy or malformed value is repaired to the network default.
          }
        }
        const derivationPathSource: DerivationPathSource =
          rawWalletInfo.derivation_path_source === 'custom' ? 'custom' : 'default';
        walletInfo = {
          ...rawWalletInfo,
          networkType,
          walletType,
          derivation_path: derivationPath,
          derivation_path_source: derivationPathSource,
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

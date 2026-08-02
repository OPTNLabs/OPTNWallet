// Create and persist a watch-only wallet from an account xPub.
//
// The wallet holds public keys only: it can show a balance, do coin control and
// build a transaction, but every signature comes from an external device. There
// is no mnemonic to encrypt, so unlike every other wallet here this one has
// nothing secret at rest — which is the entire point of scanning an xPub off a
// device that never goes online.
//
// The xPub itself is stored because addresses are DERIVED from it. Without it a
// restart cannot regenerate the address set and the wallet looks empty even
// though its coins are on chain.

import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import { Network } from '../../../state/slices/networkSlice';
import { WalletType } from '../../../types/wallet';
import {
  deriveBchAddressFromHdPublicKey,
  getBchAccountPath,
} from '../../../services/HdWalletService';
import {
  deriveWatchOnlyAccountPreview,
  watchOnlyBranchXpub,
} from './watchOnlyAccountPreview';

/**
 * Addresses derived per branch at creation.
 *
 * Electron Cash keeps a gap of 20 unused addresses so a wallet funded elsewhere
 * still finds its coins. Deriving them up front costs nothing and avoids a
 * wallet that reports zero simply because the sender used address 5.
 */
export const WATCH_ONLY_GAP_LIMIT = 20;

export interface CreateWatchOnlyWalletArgs {
  name: string;
  /** Account-level xPub, exported at m/44'/145'/account'. */
  accountXpub: string;
  network: Network;
  gapLimit?: number;
}

/** Branch 0 is receive, branch 1 is change — the standard BIP44 split. */
const BRANCHES = [0, 1] as const;

export async function createWatchOnlyWallet(
  args: CreateWatchOnlyWalletArgs
): Promise<number> {
  const name = args.name.trim();
  if (!name) throw new Error('Give the wallet a name.');

  // Validated before anything is written: this throws with a message aimed at
  // the person holding the device ("use a hardened account xPub at
  // m/44'/145'/account'") rather than leaving a half-created wallet behind.
  const preview = deriveWatchOnlyAccountPreview(args.network, args.accountXpub);
  const accountXpub = args.accountXpub.trim();
  const gapLimit = args.gapLimit ?? WATCH_ONLY_GAP_LIMIT;

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');

  const insertWallet = db.prepare(
    `INSERT INTO wallets
       (wallet_name, mnemonic, passphrase, networkType, walletType, balance,
        derivation_path, derivation_path_source, account_xpub)
     VALUES (?, NULL, NULL, ?, ?, 0, ?, 'default', ?)`
  );
  try {
    insertWallet.run([
      name,
      args.network,
      WalletType.WATCH_ONLY,
      preview.accountPath || getBchAccountPath(args.network),
      accountXpub,
    ]);
  } finally {
    insertWallet.free();
  }

  const idQuery = db.prepare('SELECT last_insert_rowid() AS id');
  let walletId = 0;
  try {
    if (idQuery.step()) {
      const row = idQuery.getAsObject() as Record<string, unknown>;
      walletId = Number(row.id);
    }
  } finally {
    idQuery.free();
  }
  if (!walletId) throw new Error('Could not create the watch-only wallet.');

  const insertKey = db.prepare(
    `INSERT INTO keys
       (wallet_id, public_key, private_key, address, token_address, pubkey_hash,
        account_index, change_index, address_index)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)`
  );
  try {
    for (const branch of BRANCHES) {
      const branchXpub = watchOnlyBranchXpub(accountXpub, args.network, branch);
      for (let index = 0; index < gapLimit; index += 1) {
        const derived = deriveBchAddressFromHdPublicKey(
          args.network,
          branchXpub,
          BigInt(index)
        );
        // A gap in the middle would silently shorten the watched range, so this
        // fails loudly rather than persisting a wallet that quietly misses
        // addresses.
        if (!derived) {
          throw new Error(
            `Could not derive ${branch === 0 ? 'receive' : 'change'} address ${index}.`
          );
        }
        insertKey.run([
          walletId,
          derived.publicKey,
          derived.address,
          derived.tokenAddress,
          derived.publicKeyHash,
          branch,
          index,
        ]);
      }
    }
  } finally {
    insertKey.free();
  }

  await dbService.saveDatabaseToFile(walletId);
  return walletId;
}

/** The stored xPub, or null for a wallet that is not watch-only. */
export async function watchOnlyAccountXpub(
  walletId: number
): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare(
    'SELECT account_xpub FROM wallets WHERE id = ? AND walletType = ?'
  );
  try {
    query.bind([walletId, WalletType.WATCH_ONLY]);
    if (!query.step()) return null;
    const row = query.getAsObject() as Record<string, unknown>;
    return typeof row.account_xpub === 'string' && row.account_xpub
      ? row.account_xpub
      : null;
  } finally {
    query.free();
  }
}

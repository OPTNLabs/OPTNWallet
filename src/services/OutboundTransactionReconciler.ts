import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import ElectrumService from './ElectrumService';
import OutboundTransactionTracker, {
  type OutboundTransactionRecord,
} from './OutboundTransactionTracker';

async function fetchWalletAddresses(walletId: number): Promise<string[]> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return [];

  const addresses: string[] = [];
  const statement = db.prepare(`
    SELECT address
    FROM keys
    WHERE wallet_id = ?;
  `);
  statement.bind([walletId]);

  while (statement.step()) {
    const row = statement.getAsObject();
    if (typeof row.address === 'string' && row.address.length > 0) {
      addresses.push(row.address);
    }
  }
  statement.free();

  return Array.from(new Set(addresses));
}

async function listSeenTxids(
  walletId: number,
  txids: string[]
): Promise<Set<string>> {
  if (txids.length === 0) return new Set();

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return new Set();

  const quoted = txids.map(() => '?').join(', ');
  const statement = db.prepare(`
    SELECT tx_hash
    FROM transactions
    WHERE wallet_id = ?
      AND tx_hash IN (${quoted});
  `);
  statement.bind([walletId, ...txids]);

  const seen = new Set<string>();
  while (statement.step()) {
    const row = statement.getAsObject();
    if (typeof row.tx_hash === 'string' && row.tx_hash.length > 0) {
      seen.add(row.tx_hash);
    }
  }
  statement.free();

  return seen;
}

export async function reconcileOutboundTransactions(
  walletId: number | null | undefined
): Promise<OutboundTransactionRecord[]> {
  if (!walletId || walletId <= 0) return [];

  const active = await OutboundTransactionTracker.listActive(walletId);
  if (active.length === 0) return [];

  await Promise.all(
    active.map((record) =>
      OutboundTransactionTracker.markStaleBroadcastingAsSubmitted(record.txid)
    )
  );

  const addresses = await fetchWalletAddresses(walletId);
  if (addresses.length === 0) return active;

  try {
    await ElectrumService.reconnect();
  } catch {
    return active;
  }

  const visibilityByTxid = await ElectrumService.getTransactionVisibilityMany(
    active.map((record) => record.txid)
  );

  await Promise.all(
    active
      .filter((record) => visibilityByTxid[record.txid]?.seen)
      .map((record) => OutboundTransactionTracker.markState(record.txid, 'seen'))
  );

  const remaining = await OutboundTransactionTracker.listActive(walletId);
  if (remaining.length === 0) return [];

  const transactionManager = TransactionManager();
  await Promise.all(
    remaining
      .filter((record) => OutboundTransactionTracker.shouldRebroadcast(record))
      .map((record) =>
        transactionManager.sendTransaction(record.rawTx).catch(() => null)
      )
  );

  const afterRetry = await OutboundTransactionTracker.listActive(walletId);
  if (afterRetry.length === 0) return [];

  try {
    await transactionManager.fetchAndStoreTransactionHistories(
      walletId,
      addresses
    );
  } catch {
    // Reconciliation is best-effort; leave unresolved items in place.
  }

  const seen = await listSeenTxids(
    walletId,
    afterRetry.map((record) => record.txid)
  );

  await Promise.all(
    afterRetry
      .filter((record) => seen.has(record.txid))
      .map((record) => OutboundTransactionTracker.markState(record.txid, 'seen'))
  );

  return await OutboundTransactionTracker.listActive(walletId);
}

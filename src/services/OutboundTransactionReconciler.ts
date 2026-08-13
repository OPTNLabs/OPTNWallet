import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import ElectrumService from './ElectrumService';
import { isDeterministicBroadcastError } from '../utils/broadcastErrors';
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

  // Normalize for case / accidental 0x — Electrum vs our store can differ.
  const wanted = new Set(
    txids.map((t) => t.replace(/^0x/i, '').toLowerCase())
  );
  const quoted = txids.map(() => '?').join(', ');
  const statement = db.prepare(`
    SELECT tx_hash
    FROM transactions
    WHERE wallet_id = ?
      AND lower(replace(tx_hash, '0x', '')) IN (${quoted});
  `);
  // Bind lowercased bare hashes so IN matches lower(replace(...)).
  statement.bind([
    walletId,
    ...txids.map((t) => t.replace(/^0x/i, '').toLowerCase()),
  ]);

  const seen = new Set<string>();
  while (statement.step()) {
    const row = statement.getAsObject();
    if (typeof row.tx_hash === 'string' && row.tx_hash.length > 0) {
      const norm = row.tx_hash.replace(/^0x/i, '').toLowerCase();
      // Return original-cased ids from input list when possible
      for (const t of txids) {
        if (t.replace(/^0x/i, '').toLowerCase() === norm) {
          seen.add(t);
          seen.add(row.tx_hash);
        }
      }
      if (wanted.has(norm)) seen.add(norm);
    }
  }
  statement.free();

  return seen;
}

/**
 * If every spent outpoint for a record is gone from the UTXOs table, the spend
 * already applied (or the coins were replaced). Treat as seen so Simple Send
 * unlocks after a real wallet sync even when `transactions` rows lag (hardware).
 */
async function listRecordsWithSpentCoinsGone(
  walletId: number,
  records: OutboundTransactionRecord[]
): Promise<Set<string>> {
  const withOutpoints = records.filter((r) => r.spentOutpoints.length > 0);
  if (withOutpoints.length === 0) return new Set();

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return new Set();

  const remaining = new Set<string>();
  const q = db.prepare(`
    SELECT 1 AS ok FROM UTXOs
    WHERE wallet_id = ?
      AND lower(tx_hash) = lower(?)
      AND tx_pos = ?
    LIMIT 1
  `);
  try {
    for (const record of withOutpoints) {
      let anyStillPresent = false;
      for (const op of record.spentOutpoints) {
        q.bind([walletId, op.tx_hash, op.tx_pos]);
        if (q.step()) {
          anyStillPresent = true;
        }
        q.reset();
        if (anyStillPresent) break;
      }
      if (!anyStillPresent) {
        remaining.add(record.txid);
      }
    }
  } finally {
    q.free();
  }
  return remaining;
}

export async function reconcileOutboundTransactions(
  walletId: number | null | undefined
): Promise<OutboundTransactionRecord[]> {
  if (!walletId || walletId <= 0) return [];

  const active = await OutboundTransactionTracker.listActive(walletId);
  if (active.length === 0) return [];

  await Promise.all(
    active
      .filter((record) => isDeterministicBroadcastError(record.lastError))
      .map((record) =>
        OutboundTransactionTracker.remove(record.txid, record.walletId)
      )
  );

  const retryableActive = await OutboundTransactionTracker.listActive(walletId);
  if (retryableActive.length === 0) return [];

  await Promise.all(
    retryableActive.map((record) =>
      OutboundTransactionTracker.markStaleBroadcastingAsSubmitted(
        record.txid,
        record.walletId
      )
    )
  );

  // A normal wallet sync may already have stored one of these transactions.
  // Resolve that from the local database first; this is also the only automatic
  // reconciliation allowed for Tor-only Fusion records.
  const locallySeen = await listSeenTxids(
    walletId,
    retryableActive.map((record) => record.txid)
  );
  await Promise.all(
    retryableActive
      .filter(
        (record) =>
          locallySeen.has(record.txid) ||
          locallySeen.has(record.txid.toLowerCase())
      )
      .map((record) =>
        OutboundTransactionTracker.markState(
          record.txid,
          'seen',
          null,
          record.walletId
        )
      )
  );

  // Hardware / laggy history: spent UTXOs already dropped from the table.
  const afterLocal = await OutboundTransactionTracker.listActive(walletId);
  const spentGone = await listRecordsWithSpentCoinsGone(walletId, afterLocal);
  await Promise.all(
    afterLocal
      .filter((record) => spentGone.has(record.txid))
      .map((record) =>
        OutboundTransactionTracker.markState(
          record.txid,
          'seen',
          null,
          record.walletId
        )
      )
  );

  const unresolved = await OutboundTransactionTracker.listActive(walletId);
  const ordinary = unresolved.filter(
    (record) => record.privacyRoute !== 'tor-only'
  );
  if (ordinary.length === 0) return unresolved;

  const addresses = await fetchWalletAddresses(walletId);
  if (addresses.length === 0) return unresolved;

  const visibilityByTxid = await ElectrumService.getTransactionVisibilityMany(
    ordinary.map((record) => record.txid)
  );

  await Promise.all(
    ordinary
      .filter((record) => visibilityByTxid[record.txid]?.seen)
      .map((record) =>
        OutboundTransactionTracker.markState(
          record.txid,
          'seen',
          null,
          record.walletId
        )
      )
  );

  const remaining = await OutboundTransactionTracker.listActive(walletId);
  const ordinaryRemaining = remaining.filter(
    (record) => record.privacyRoute !== 'tor-only'
  );
  if (ordinaryRemaining.length === 0) return remaining;

  const transactionManager = TransactionManager();
  await Promise.all(
    ordinaryRemaining
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
      .map((record) =>
        OutboundTransactionTracker.markState(
          record.txid,
          'seen',
          null,
          record.walletId
        )
      )
  );

  return await OutboundTransactionTracker.listActive(walletId);
}

import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import ElectrumService from './ElectrumService';
import { isDeterministicBroadcastError } from '../utils/broadcastErrors';
import OutboundTransactionTracker, {
  type OutboundTransactionRecord,
} from './OutboundTransactionTracker';

function logReconcileTiming(
  stage: string,
  startedAt: number,
  details: Record<string, number | boolean>
): void {
  if (!import.meta.env.DEV) return;
  console.debug('[OutboundTransactionReconciler]', {
    stage,
    durationMs: Date.now() - startedAt,
    ...details,
  });
}

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

async function listConfirmedTxids(
  walletId: number,
  txids: string[]
): Promise<Set<string>> {
  if (txids.length === 0) return new Set();

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return new Set();

  // Normalize for case / accidental 0x — Electrum vs our store can differ.
  const wanted = new Set(txids.map((t) => t.replace(/^0x/i, '').toLowerCase()));
  const quoted = txids.map(() => '?').join(', ');
  const statement = db.prepare(`
    SELECT tx_hash, height
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
    if (
      typeof row.tx_hash === 'string' &&
      row.tx_hash.length > 0 &&
      Number(row.height ?? 0) > 0
    ) {
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

export async function reconcileOutboundTransactions(
  walletId: number | null | undefined
): Promise<OutboundTransactionRecord[]> {
  if (!walletId || walletId <= 0) return [];

  const startedAt = Date.now();
  const active = await OutboundTransactionTracker.listActive(walletId);
  if (active.length === 0) return [];
  logReconcileTiming('start', startedAt, { activeCount: active.length });

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
  // Only confirmed history resolves the reservation. Mempool rows must keep
  // their inputs reserved until a block includes the transaction.
  // Resolve that from the local database first; this is also the only automatic
  // reconciliation allowed for Tor-only Fusion records.
  const locallyConfirmed = await listConfirmedTxids(
    walletId,
    retryableActive.map((record) => record.txid)
  );
  await Promise.all(
    retryableActive
      .filter(
        (record) =>
          locallyConfirmed.has(record.txid) ||
          locallyConfirmed.has(record.txid.toLowerCase())
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

  // A missing input is not sufficient confirmation: an unconfirmed child can
  // temporarily remove an ancestor from the UTXO cache. Leave the reservation
  // active until history or Electrum reports the tracked transaction confirmed.

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
  logReconcileTiming('visibility-complete', startedAt, {
    ordinaryCount: ordinary.length,
    visibleCount: Object.values(visibilityByTxid).filter(
      (visibility) => visibility.seen
    ).length,
  });

  await Promise.all(
    ordinary
      .filter((record) => visibilityByTxid[record.txid]?.confirmed)
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
        transactionManager
          .sendTransaction(record.rawTx, record.walletId)
          .catch(() => null)
      )
  );

  const afterRetry = await OutboundTransactionTracker.listActive(walletId);
  if (afterRetry.length === 0) return [];

  let historyFetchSucceeded = true;
  try {
    await transactionManager.fetchAndStoreTransactionHistories(
      walletId,
      addresses
    );
  } catch {
    // Reconciliation is best-effort; leave unresolved items in place.
    historyFetchSucceeded = false;
  }
  logReconcileTiming('history-complete', startedAt, {
    addressCount: addresses.length,
    historyFetchSucceeded,
  });

  const confirmed = await listConfirmedTxids(
    walletId,
    afterRetry.map((record) => record.txid)
  );

  await Promise.all(
    afterRetry
      .filter((record) => confirmed.has(record.txid))
      .map((record) =>
        OutboundTransactionTracker.markState(
          record.txid,
          'seen',
          null,
          record.walletId
        )
      )
  );

  const finalRecords = await OutboundTransactionTracker.listActive(walletId);
  logReconcileTiming('complete', startedAt, {
    unresolvedCount: finalRecords.length,
  });
  return finalRecords;
}

import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { store } from '../../state/store';
import { logError } from '../../utils/errorHandling';
import { TransactionDetailParticipant, TransactionDetails } from '../../types/types';
import {
  ElectrumVerboseTransaction,
  extractOutputAddress,
  isVerboseTransaction,
  toSats,
} from './helpers';

function getDbService() {
  return DatabaseService();
}

function currentWalletId(): number | null {
  return store.getState().wallet_id.currentWalletId ?? null;
}

export async function readTransactionDetailsFromDb(
  txHash: string
): Promise<TransactionDetails | null> {
  const walletId = currentWalletId();
  if (!walletId) return null;

  const dbService = getDbService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const stmt = db.prepare(`
    SELECT tx_hash, confirmations, height, fee_sats, timestamp, inputs_json, outputs_json
    FROM transaction_details
    WHERE wallet_id = ? AND tx_hash = ?
    LIMIT 1;
  `);

  try {
    stmt.bind([walletId, txHash]);
    if (!stmt.step()) return null;

    const row = stmt.getAsObject() as Record<string, unknown>;
    const inputs = normalizeParticipantRows(
      typeof row.inputs_json === 'string' ? JSON.parse(row.inputs_json) : []
    );
    const outputs = normalizeParticipantRows(
      typeof row.outputs_json === 'string' ? JSON.parse(row.outputs_json) : []
    );

    return {
      txid: typeof row.tx_hash === 'string' ? row.tx_hash : txHash,
      confirmations: Number(row.confirmations ?? 0),
      height:
        row.height === null || row.height === undefined
          ? undefined
          : Number(row.height),
      feeSats:
        row.fee_sats === null || row.fee_sats === undefined
          ? undefined
          : Number(row.fee_sats),
      timestamp:
        typeof row.timestamp === 'string' && row.timestamp.trim()
          ? row.timestamp
          : undefined,
      inputs,
      outputs,
    };
  } catch (error) {
    logError('ElectrumService.readTransactionDetailsFromDb', error, { txHash });
    return null;
  } finally {
    stmt.free();
  }
}

export async function persistTransactionDetails(
  details: TransactionDetails
): Promise<void> {
  const walletId = currentWalletId();
  if (!walletId) return;

  const dbService = getDbService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return;

  try {
    const stmt = db.prepare(`
      INSERT INTO transaction_details (
        wallet_id, tx_hash, confirmations, height, fee_sats, timestamp,
        inputs_json, outputs_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
        confirmations = excluded.confirmations,
        height = excluded.height,
        fee_sats = excluded.fee_sats,
        timestamp = excluded.timestamp,
        inputs_json = excluded.inputs_json,
        outputs_json = excluded.outputs_json,
        updated_at = excluded.updated_at
    `);

    stmt.run([
      walletId,
      details.txid,
      details.confirmations,
      details.height ?? null,
      details.feeSats ?? null,
      details.timestamp ?? '',
      JSON.stringify(details.inputs),
      JSON.stringify(details.outputs),
      new Date().toISOString(),
    ]);
    stmt.free();
    dbService.scheduleDatabaseSave();
  } catch (error) {
    logError('ElectrumService.persistTransactionDetails', error, {
      txHash: details.txid,
    });
  }
}

async function fetchVerboseTransactions(
  server: ReturnType<typeof ElectrumServer>,
  txids: string[]
): Promise<Record<string, ElectrumVerboseTransaction>> {
  const uniqueTxids = Array.from(new Set(txids.filter(Boolean)));
  if (uniqueTxids.length === 0) return {};

  const responses = await server.requestMany(
    uniqueTxids.map((txid) => ({
      method: 'blockchain.transaction.get',
      params: [txid, true],
    }))
  );

  const resolved: Record<string, ElectrumVerboseTransaction> = {};
  responses.forEach((response, index) => {
    const txid = uniqueTxids[index];
    if (response instanceof Error) return;
    if (!isVerboseTransaction(response)) return;
    resolved[txid] = response;
  });
  return resolved;
}

function normalizeParticipantRows(
  raw: unknown
): TransactionDetailParticipant[] {
  if (!Array.isArray(raw)) return [];
  const rows: TransactionDetailParticipant[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    rows.push({
      address: typeof row.address === 'string' ? row.address : 'Unknown',
      amountSats:
        typeof row.amountSats === 'number' && Number.isFinite(row.amountSats)
          ? row.amountSats
          : undefined,
      outputIndex:
        typeof row.outputIndex === 'number' && Number.isFinite(row.outputIndex)
          ? row.outputIndex
          : undefined,
    });
  }
  return rows;
}

export async function resolveInputParticipants(
  server: ReturnType<typeof ElectrumServer>,
  tx: ElectrumVerboseTransaction
): Promise<TransactionDetailParticipant[]> {
  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  const prevTxids = vin
    .map((input) => (typeof input.txid === 'string' ? input.txid : ''))
    .filter(Boolean);
  const prevTxs = await fetchVerboseTransactions(server, prevTxids);

  return vin.map((input) => {
    if (typeof input.coinbase === 'string' && input.coinbase.length > 0) {
      return { address: 'Coinbase' };
    }

    const prevTxid = typeof input.txid === 'string' ? input.txid : '';
    const prevIndex =
      typeof input.vout === 'number' && Number.isFinite(input.vout)
        ? input.vout
        : Number(input.vout ?? -1);
    const prevTx = prevTxs[prevTxid];
    const prevOut =
      prevTx && Array.isArray(prevTx.vout) && prevIndex >= 0
        ? prevTx.vout.find((output) => Number(output.n ?? -1) === prevIndex)
        : undefined;

    if (!prevOut) {
      return {
        address: prevTxid ? `Prevout ${prevTxid.slice(0, 10)}...:${prevIndex}` : 'Unknown input',
      };
    }

    return {
      address: extractOutputAddress(prevOut),
      amountSats: toSats(prevOut.value),
      outputIndex: prevIndex >= 0 ? prevIndex : undefined,
    };
  });
}

import { binToHex } from '@bitauth/libauth';

import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { createMultisigTables } from '../../utils/schema/schema';

export type MultisigSpendStage =
  | 'intent'
  | 'build'
  | 'sign'
  | 'merge'
  | 'validate'
  | 'broadcast'
  | 'submitted'
  | 'confirmed'
  | 'rejected';

export type MultisigSpendSession = {
  sessionId: string;
  walletId: number;
  policyId: string;
  unsignedTxHash: string;
  psbtBytes: Uint8Array;
  stage: MultisigSpendStage;
  signatures: string[];
  rawTxHex: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

const STAGE_ORDER: Record<MultisigSpendStage, number> = {
  intent: 0,
  build: 1,
  sign: 2,
  merge: 3,
  validate: 4,
  broadcast: 5,
  submitted: 6,
  confirmed: 7,
  rejected: 99,
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array();
}

function sessionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (randomUuid) return randomUuid.call(globalThis.crypto);
  return `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function database() {
  const service = DatabaseService();
  await service.ensureDatabaseStarted();
  const db = service.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');
  createMultisigTables(db);
  return { service, db };
}

function rowToSession(row: Record<string, unknown>): MultisigSpendSession {
  let signatures: string[] = [];
  try {
    const parsed = JSON.parse(asString(row.signatures_json));
    if (Array.isArray(parsed)) {
      signatures = parsed.filter(
        (value): value is string => typeof value === 'string'
      );
    }
  } catch {
    throw new Error('Multisig spend session has malformed signature state.');
  }
  return {
    sessionId: asString(row.session_id),
    walletId: asNumber(row.wallet_id),
    policyId: asString(row.policy_id),
    unsignedTxHash: asString(row.unsigned_tx_hash),
    psbtBytes: asBytes(row.psbt_bytes),
    stage: asString(row.stage) as MultisigSpendStage,
    signatures,
    rawTxHex: row.raw_tx_hex === null ? null : asString(row.raw_tx_hex),
    retryCount: asNumber(row.retry_count),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export async function getMultisigSpendSession(
  sessionIdValue: string
): Promise<MultisigSpendSession | null> {
  const { db } = await database();
  const query = db.prepare(
    `SELECT session_id, wallet_id, policy_id, unsigned_tx_hash, psbt_bytes,
            stage, signatures_json, raw_tx_hex, retry_count, created_at, updated_at
       FROM multisig_spend_sessions WHERE session_id = ?`
  );
  try {
    query.bind([sessionIdValue]);
    if (!query.step()) return null;
    return rowToSession(query.getAsObject() as Record<string, unknown>);
  } finally {
    query.free();
  }
}

export async function listMultisigSpendSessions(
  walletId: number
): Promise<MultisigSpendSession[]> {
  const { db } = await database();
  const query = db.prepare(
    `SELECT session_id, wallet_id, policy_id, unsigned_tx_hash, psbt_bytes,
            stage, signatures_json, raw_tx_hex, retry_count, created_at, updated_at
       FROM multisig_spend_sessions
      WHERE wallet_id = ?
        AND stage NOT IN ('confirmed', 'rejected', 'submitted', 'broadcast')
      ORDER BY updated_at DESC`
  );
  const sessions: MultisigSpendSession[] = [];
  try {
    query.bind([walletId]);
    while (query.step()) {
      sessions.push(
        rowToSession(query.getAsObject() as Record<string, unknown>)
      );
    }
  } finally {
    query.free();
  }
  return sessions;
}

export async function createMultisigSpendSession(args: {
  walletId: number;
  policyId: string;
  unsignedTxHash: string;
  psbtBytes: Uint8Array;
}): Promise<MultisigSpendSession> {
  if (!args.policyId || !args.unsignedTxHash || args.psbtBytes.length === 0) {
    throw new Error(
      'A multisig spend session needs policy, transaction, and PSBT bindings.'
    );
  }
  const { service, db } = await database();
  const existingQuery = db.prepare(
    `SELECT session_id, wallet_id, policy_id, unsigned_tx_hash, psbt_bytes,
            stage, signatures_json, raw_tx_hex, retry_count, created_at, updated_at
       FROM multisig_spend_sessions
      WHERE wallet_id = ? AND unsigned_tx_hash = ?`
  );
  try {
    existingQuery.bind([args.walletId, args.unsignedTxHash]);
    if (existingQuery.step()) {
      const existing = rowToSession(
        existingQuery.getAsObject() as Record<string, unknown>
      );
      if (existing.policyId !== args.policyId) {
        throw new Error(
          'A different PSBT is already bound to this unsigned transaction hash.'
        );
      }
      if (binToHex(existing.psbtBytes) !== binToHex(args.psbtBytes)) {
        if (existing.stage === 'rejected' || existing.stage === 'confirmed') {
          throw new Error(
            `The multisig spend session is already ${existing.stage}.`
          );
        }
        const update = db.prepare(
          `UPDATE multisig_spend_sessions
              SET psbt_bytes = ?, updated_at = ?
            WHERE session_id = ?`
        );
        try {
          update.run([
            Uint8Array.from(args.psbtBytes),
            new Date().toISOString(),
            existing.sessionId,
          ]);
        } finally {
          update.free();
        }
        await service.saveDatabaseToFile(args.walletId);
        const rebound = await getMultisigSpendSession(existing.sessionId);
        if (!rebound) {
          throw new Error('Could not update the multisig spend session.');
        }
        return rebound;
      }
      return existing;
    }
  } finally {
    existingQuery.free();
  }
  const id = sessionId();
  const timestamp = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO multisig_spend_sessions
       (session_id, wallet_id, policy_id, unsigned_tx_hash, psbt_bytes, stage,
        signatures_json, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'intent', '[]', 0, ?, ?)`
  );
  try {
    insert.run([
      id,
      args.walletId,
      args.policyId,
      args.unsignedTxHash,
      Uint8Array.from(args.psbtBytes),
      timestamp,
      timestamp,
    ]);
  } finally {
    insert.free();
  }
  await service.saveDatabaseToFile(args.walletId);
  const session = await getMultisigSpendSession(id);
  if (!session)
    throw new Error('Could not persist the multisig spend session.');
  return session;
}

export async function assertMultisigSpendSessionBinding(args: {
  sessionId: string;
  walletId: number;
  policyId: string;
  unsignedTxHash: string;
  psbtBytes: Uint8Array;
}): Promise<MultisigSpendSession> {
  const session = await getMultisigSpendSession(args.sessionId);
  if (!session) throw new Error('The multisig spend session no longer exists.');
  if (
    session.walletId !== args.walletId ||
    session.policyId !== args.policyId ||
    session.unsignedTxHash !== args.unsignedTxHash ||
    binToHex(session.psbtBytes) !== binToHex(args.psbtBytes)
  ) {
    throw new Error(
      'The PSBT is not bound to the active multisig spend session.'
    );
  }
  if (session.stage === 'rejected' || session.stage === 'confirmed') {
    throw new Error(`The multisig spend session is already ${session.stage}.`);
  }
  return session;
}

export async function advanceMultisigSpendSession(args: {
  sessionId: string;
  stage: MultisigSpendStage;
  psbtBytes?: Uint8Array;
  rawTxHex?: string;
  signaturePsbtHex?: string;
  retry?: boolean;
}): Promise<MultisigSpendSession> {
  const { service, db } = await database();
  const current = await getMultisigSpendSession(args.sessionId);
  if (!current) throw new Error('The multisig spend session no longer exists.');
  if (
    args.stage !== 'rejected' &&
    STAGE_ORDER[args.stage] < STAGE_ORDER[current.stage]
  ) {
    throw new Error(
      `Cannot move a multisig session from ${current.stage} back to ${args.stage}.`
    );
  }
  const signatures = new Set(current.signatures);
  if (args.signaturePsbtHex) signatures.add(args.signaturePsbtHex);
  const timestamp = new Date().toISOString();
  const update = db.prepare(
    `UPDATE multisig_spend_sessions
        SET stage = ?, psbt_bytes = COALESCE(?, psbt_bytes),
            signatures_json = ?, raw_tx_hex = COALESCE(?, raw_tx_hex),
            retry_count = retry_count + ?, updated_at = ?
      WHERE session_id = ? AND stage = ?`
  );
  try {
    update.run([
      args.stage,
      args.psbtBytes ? Uint8Array.from(args.psbtBytes) : null,
      JSON.stringify([...signatures]),
      args.rawTxHex ?? null,
      args.retry ? 1 : 0,
      timestamp,
      args.sessionId,
      current.stage,
    ]);
    if (
      typeof db.getRowsModified === 'function' &&
      db.getRowsModified() !== 1
    ) {
      throw new Error(
        'The multisig spend session changed before this update completed.'
      );
    }
  } finally {
    update.free();
  }
  await service.saveDatabaseToFile(current.walletId);
  const updated = await getMultisigSpendSession(args.sessionId);
  if (!updated)
    throw new Error('Multisig spend session disappeared after update.');
  return updated;
}

export default {
  getMultisigSpendSession,
  listMultisigSpendSessions,
  createMultisigSpendSession,
  assertMultisigSpendSessionBinding,
  advanceMultisigSpendSession,
};

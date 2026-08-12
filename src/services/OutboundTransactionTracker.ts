import localForage from 'localforage';
import { isDeterministicBroadcastError } from '../utils/broadcastErrors';
import { binToHex, hexToBin } from '../utils/hex';
import { sha256 } from '../utils/hash';
import type { UTXO } from '../types/types';

export type OutboundTransactionState =
  | 'broadcasting'
  | 'submitted'
  | 'broadcasted'
  | 'seen';

export const OUTBOUND_BROADCASTING_STALE_MS = 90 * 1000;
export const OUTBOUND_RELEASE_DELAY_MS = 20 * 60 * 1000;
export const OUTBOUND_REBROADCAST_COOLDOWN_MS = 30 * 1000;

export type TrackedOutpoint = {
  tx_hash: string;
  tx_pos: number;
};

export type OutboundTransactionRecord = {
  txid: string;
  rawTx: string;
  walletId: number | null;
  source: string;
  sourceLabel?: string | null;
  recipientSummary?: string | null;
  amountSummary?: string | null;
  sessionTopic?: string | null;
  dappName?: string | null;
  dappUrl?: string | null;
  requestId?: string | null;
  userPrompt?: string | null;
  state: OutboundTransactionState;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string | null;
  spentOutpoints: TrackedOutpoint[];
  lastError?: string | null;
};

type TrackAttemptArgs = {
  rawTx: string;
  walletId: number | null;
  source: string;
  sourceLabel?: string | null;
  recipientSummary?: string | null;
  amountSummary?: string | null;
  sessionTopic?: string | null;
  dappName?: string | null;
  dappUrl?: string | null;
  requestId?: string | null;
  userPrompt?: string | null;
  spentInputs?: UTXO[];
};

type RecordBroadcastArgs = TrackAttemptArgs & {
  expectedTxid: string;
};

const STORAGE_PREFIX = 'outbound-tx:';
const trackerStore = localForage.createInstance({
  name: 'optn-wallet',
  storeName: 'outbound_transactions',
});
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Keep tracker notifications isolated from UI subscribers.
    }
  }
}

function walletStorageId(walletId: number | null): string {
  return walletId === null ? 'none' : String(walletId);
}

function storageKey(txid: string, walletId: number | null): string {
  return `${STORAGE_PREFIX}${walletStorageId(walletId)}:${txid}`;
}

function legacyStorageKey(txid: string): string {
  return `${STORAGE_PREFIX}${txid}`;
}

function toTrackedOutpoints(inputs?: UTXO[]): TrackedOutpoint[] {
  return (inputs ?? []).map((utxo) => ({
    tx_hash: utxo.tx_hash,
    tx_pos: utxo.tx_pos,
  }));
}

export function deriveTrackedTxid(rawTx: string): string | null {
  try {
    return binToHex(sha256.hash(sha256.hash(hexToBin(rawTx))).reverse());
  } catch {
    return null;
  }
}

async function saveRecord(record: OutboundTransactionRecord): Promise<void> {
  await trackerStore.setItem(storageKey(record.txid, record.walletId), record);
  emitChange();
}

const OutboundTransactionTracker = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  async getByTxid(
    txid: string,
    walletId?: number | null
  ): Promise<OutboundTransactionRecord | null> {
    if (walletId !== undefined) {
      const scoped = await trackerStore.getItem<OutboundTransactionRecord>(
        storageKey(txid, walletId)
      );
      if (scoped) return scoped;

      const legacy = await trackerStore.getItem<OutboundTransactionRecord>(
        legacyStorageKey(txid)
      );
      if (legacy?.walletId === walletId) {
        await saveRecord(legacy);
        await trackerStore.removeItem(legacyStorageKey(txid));
        return legacy;
      }
      return null;
    }

    const legacy = await trackerStore.getItem<OutboundTransactionRecord>(
      legacyStorageKey(txid)
    );
    if (legacy) return legacy;

    let found: OutboundTransactionRecord | null = null;
    await trackerStore.iterate<OutboundTransactionRecord, void>(
      (value, key) => {
        if (
          !found &&
          key.startsWith(STORAGE_PREFIX) &&
          value?.txid === txid
        ) {
          found = value;
        }
      }
    );
    return found;
  },

  async getByRawTx(
    rawTx: string,
    walletId?: number | null
  ): Promise<OutboundTransactionRecord | null> {
    const txid = deriveTrackedTxid(rawTx);
    if (!txid) return null;
    return await this.getByTxid(txid, walletId);
  },

  async trackAttempt(
    args: TrackAttemptArgs
  ): Promise<OutboundTransactionRecord | null> {
    const txid = deriveTrackedTxid(args.rawTx);
    if (!txid) return null;

    const existing = await this.getByTxid(txid, args.walletId);
    const now = new Date().toISOString();
    const record: OutboundTransactionRecord = {
      txid,
      rawTx: args.rawTx,
      walletId: args.walletId,
      source: existing?.source ?? args.source,
      sourceLabel: existing?.sourceLabel ?? args.sourceLabel ?? null,
      recipientSummary:
        existing?.recipientSummary ?? args.recipientSummary ?? null,
      amountSummary: existing?.amountSummary ?? args.amountSummary ?? null,
      sessionTopic: existing?.sessionTopic ?? args.sessionTopic ?? null,
      dappName: existing?.dappName ?? args.dappName ?? null,
      dappUrl: existing?.dappUrl ?? args.dappUrl ?? null,
      requestId: existing?.requestId ?? args.requestId ?? null,
      userPrompt: existing?.userPrompt ?? args.userPrompt ?? null,
      state:
        existing?.state === 'submitted' || existing?.state === 'broadcasted'
          ? existing.state
          : 'broadcasting',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastCheckedAt: existing?.lastCheckedAt ?? null,
      spentOutpoints: existing?.spentOutpoints.length
        ? existing.spentOutpoints
        : toTrackedOutpoints(args.spentInputs),
      lastError: existing?.lastError ?? null,
    };
    await saveRecord(record);
    return record;
  },

  async recordBroadcast(
    args: RecordBroadcastArgs
  ): Promise<OutboundTransactionRecord> {
    const { expectedTxid, ...attempt } = args;
    const derivedTxid = deriveTrackedTxid(attempt.rawTx);
    if (!derivedTxid || derivedTxid !== expectedTxid.toLowerCase()) {
      throw new Error(
        'Broadcast transaction id does not match its raw transaction.'
      );
    }

    const tracked = await this.trackAttempt(attempt);
    if (!tracked) {
      throw new Error('Unable to persist the broadcast transaction.');
    }
    const completed = await this.markState(
      tracked.txid,
      'broadcasted',
      null,
      tracked.walletId
    );
    if (!completed) {
      throw new Error('Unable to mark the broadcast transaction as complete.');
    }
    return completed;
  },

  async markState(
    txid: string,
    state: OutboundTransactionState,
    lastError: string | null = null,
    walletId?: number | null
  ): Promise<OutboundTransactionRecord | null> {
    const existing = await this.getByTxid(txid, walletId);
    if (!existing) return null;
    const next: OutboundTransactionRecord = {
      ...existing,
      state,
      updatedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      lastError,
    };
    await saveRecord(next);
    return next;
  },

  async markStaleBroadcastingAsSubmitted(
    txid: string,
    walletId?: number | null
  ): Promise<OutboundTransactionRecord | null> {
    const existing = await this.getByTxid(txid, walletId);
    if (!existing || existing.state !== 'broadcasting') return existing;
    const ageMs = Date.now() - Date.parse(existing.updatedAt);
    if (Number.isNaN(ageMs) || ageMs < OUTBOUND_BROADCASTING_STALE_MS) {
      return existing;
    }
    return await this.markState(
      txid,
      'submitted',
      existing.lastError ?? null,
      existing.walletId
    );
  },

  canRelease(record: OutboundTransactionRecord): boolean {
    if (record.state === 'seen' || record.state === 'broadcasted') return false;
    const ageMs = Date.now() - Date.parse(record.updatedAt);
    return !Number.isNaN(ageMs) && ageMs >= OUTBOUND_RELEASE_DELAY_MS;
  },

  canClear(record: OutboundTransactionRecord): boolean {
    if (isDeterministicBroadcastError(record.lastError)) return true;
    if (record.state === 'submitted') return true;
    return this.canRelease(record);
  },

  shouldRebroadcast(record: OutboundTransactionRecord): boolean {
    if (record.state !== 'submitted') return false;
    const baseline = record.lastCheckedAt ?? record.updatedAt;
    const ageMs = Date.now() - Date.parse(baseline);
    return !Number.isNaN(ageMs) && ageMs >= OUTBOUND_REBROADCAST_COOLDOWN_MS;
  },

  async remove(txid: string, walletId?: number | null): Promise<void> {
    if (walletId !== undefined) {
      await trackerStore.removeItem(storageKey(txid, walletId));
      const legacy = await trackerStore.getItem<OutboundTransactionRecord>(
        legacyStorageKey(txid)
      );
      if (legacy?.walletId === walletId) {
        await trackerStore.removeItem(legacyStorageKey(txid));
      }
      emitChange();
      return;
    }

    const keys: string[] = [legacyStorageKey(txid)];
    await trackerStore.iterate<OutboundTransactionRecord, void>(
      (value, key) => {
        if (key.startsWith(STORAGE_PREFIX) && value?.txid === txid) {
          keys.push(key);
        }
      }
    );
    await Promise.all(
      Array.from(new Set(keys)).map((key) => trackerStore.removeItem(key))
    );
    emitChange();
  },

  async listAll(
    walletId?: number | null
  ): Promise<OutboundTransactionRecord[]> {
    const records: OutboundTransactionRecord[] = [];
    await trackerStore.iterate<OutboundTransactionRecord, void>(
      (value, key) => {
        if (!key.startsWith(STORAGE_PREFIX) || !value) return;
        if (
          walletId !== undefined &&
          walletId !== null &&
          value.walletId !== walletId
        ) {
          return;
        }
        records.push(value);
      }
    );
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async listActive(
    walletId?: number | null
  ): Promise<OutboundTransactionRecord[]> {
    const records = await this.listAll(walletId);
    return records.filter((record) => record.state !== 'seen');
  },

  async listReservedOutpoints(
    walletId?: number | null
  ): Promise<TrackedOutpoint[]> {
    const records = await this.listActive(walletId);
    return records
      .filter((record) => !isDeterministicBroadcastError(record.lastError))
      .flatMap((record) => record.spentOutpoints);
  },
};

export default OutboundTransactionTracker;

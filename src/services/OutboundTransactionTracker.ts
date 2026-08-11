import localForage from 'localforage';
import { isDeterministicBroadcastError } from '../utils/broadcastErrors';
import { binToHex, hexToBin } from '../utils/hex';
import { sha256 } from '../utils/hash';
import type { UTXO } from '../types/types';
import { getLocalStorage } from '../utils/browserStorage';

export type OutboundTransactionState =
  | 'broadcasting'
  | 'submitted'
  | 'broadcasted'
  | 'seen';

export type OutboundPrivacyRoute = 'default' | 'tor-only';

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
  /**
   * `tor-only` records must never be queried or rebroadcast through the normal
   * Electrum/HTTP path. Optional for backwards compatibility with records saved
   * before route metadata existed; an absent value means `default`.
   */
  privacyRoute?: OutboundPrivacyRoute;
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
  /** Signed Tor-only transaction whose network visibility is still unknown. */
  verificationPending?: boolean;
  verificationMessage?: string | null;
};

export function isFusionVerificationPending(
  record: OutboundTransactionRecord
): boolean {
  if (record.verificationPending === true) return true;
  return (
    record.privacyRoute === 'tor-only' &&
    /fusion/i.test(record.source) &&
    record.state !== 'seen' &&
    !isDeterministicBroadcastError(record.lastError)
  );
}

type TrackAttemptArgs = {
  rawTx: string;
  walletId: number | null;
  source: string;
  sourceLabel?: string | null;
  privacyRoute?: OutboundPrivacyRoute;
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
const FALLBACK_STORAGE_KEY = 'optn-outbound-recovery-v1';
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

function readFallbackRecords(): Record<string, OutboundTransactionRecord> {
  try {
    const raw = getLocalStorage()?.getItem(FALLBACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, OutboundTransactionRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeFallbackRecords(
  records: Record<string, OutboundTransactionRecord>
): boolean {
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    const keys = Object.keys(records);
    if (keys.length === 0) storage.removeItem(FALLBACK_STORAGE_KEY);
    else storage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

function fallbackRecord(
  txid: string,
  walletId?: number | null
): OutboundTransactionRecord | null {
  const records = readFallbackRecords();
  if (walletId !== undefined) {
    return records[storageKey(txid, walletId)] ?? null;
  }
  return Object.values(records).find((record) => record.txid === txid) ?? null;
}

function saveFallbackRecord(record: OutboundTransactionRecord): boolean {
  const records = readFallbackRecords();
  records[storageKey(record.txid, record.walletId)] = record;
  return writeFallbackRecords(records);
}

function removeFallbackRecords(
  predicate: (record: OutboundTransactionRecord) => boolean
): void {
  const records = readFallbackRecords();
  let changed = false;
  for (const [key, record] of Object.entries(records)) {
    if (!predicate(record)) continue;
    delete records[key];
    changed = true;
  }
  if (changed) writeFallbackRecords(records);
}

async function migrateFallbackRecords(): Promise<
  Record<string, OutboundTransactionRecord>
> {
  const records = readFallbackRecords();
  let changed = false;
  for (const [key, record] of Object.entries(records)) {
    try {
      await trackerStore.setItem(key, record);
      delete records[key];
      changed = true;
    } catch {
      // Keep the recovery record until IndexedDB accepts it.
    }
  }
  if (changed) writeFallbackRecords(records);
  return records;
}

function toTrackedOutpoints(inputs?: UTXO[]): TrackedOutpoint[] {
  return (inputs ?? []).map((utxo) => ({
    tx_hash: String(utxo.tx_hash).trim().toLowerCase(),
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
  const key = storageKey(record.txid, record.walletId);
  try {
    await trackerStore.setItem(key, record);
    removeFallbackRecords(
      (fallback) =>
        fallback.txid === record.txid && fallback.walletId === record.walletId
    );
  } catch (error) {
    // IndexedDB can be temporarily unavailable (notably during WebView storage
    // recovery). Keep a small localStorage shadow so spent outpoints remain
    // reserved and the reconciler can migrate the broadcast later.
    if (!saveFallbackRecord(record)) throw error;
  }
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
      try {
        const scoped = await trackerStore.getItem<OutboundTransactionRecord>(
          storageKey(txid, walletId)
        );
        if (scoped) return scoped;

        const legacy = await trackerStore.getItem<OutboundTransactionRecord>(
          legacyStorageKey(txid)
        );
        if (legacy?.walletId === walletId) {
          // Migration is best-effort; never discard the record we already
          // recovered just because the replacement write is unavailable.
          try {
            await saveRecord(legacy);
            await trackerStore.removeItem(legacyStorageKey(txid));
          } catch {
            // Keep the legacy row in place and return it to the caller.
          }
          return legacy;
        }
      } catch {
        // Fall through to the durable localStorage recovery shadow.
      }
      return fallbackRecord(txid, walletId);
    }

    try {
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
      if (found) return found;
    } catch {
      // Fall through to the durable localStorage recovery shadow.
    }
    return fallbackRecord(txid);
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
      ...(existing?.privacyRoute || args.privacyRoute
        ? {
            privacyRoute:
              existing?.privacyRoute ?? args.privacyRoute ?? 'default',
          }
        : {}),
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
      verificationPending: existing?.verificationPending ?? false,
      verificationMessage: existing?.verificationMessage ?? null,
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
      verificationPending:
        state === 'seen' || state === 'broadcasted'
          ? false
          : existing.verificationPending,
      verificationMessage:
        state === 'seen' || state === 'broadcasted'
          ? null
          : existing.verificationMessage,
    };
    await saveRecord(next);
    return next;
  },

  async markVerificationPending(
    txid: string,
    message: string,
    walletId?: number | null
  ): Promise<OutboundTransactionRecord | null> {
    const existing = await this.getByTxid(txid, walletId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const next: OutboundTransactionRecord = {
      ...existing,
      state: 'submitted',
      updatedAt: now,
      lastCheckedAt: now,
      lastError: null,
      verificationPending: true,
      verificationMessage: message,
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
    if (isFusionVerificationPending(record)) return false;
    if (record.state === 'seen' || record.state === 'broadcasted') return false;
    const ageMs = Date.now() - Date.parse(record.updatedAt);
    return !Number.isNaN(ageMs) && ageMs >= OUTBOUND_RELEASE_DELAY_MS;
  },

  canClear(record: OutboundTransactionRecord): boolean {
    if (isFusionVerificationPending(record)) return false;
    if (isDeterministicBroadcastError(record.lastError)) return true;
    // submitted = we lost the broadcast race; broadcasted = already on wire.
    // User must be able to unblock Simple Send without waiting 20 minutes when
    // history sync has not written the tx row yet (common on hardware wallets).
    if (record.state === 'submitted' || record.state === 'broadcasted')
      return true;
    return this.canRelease(record);
  },

  shouldRebroadcast(record: OutboundTransactionRecord): boolean {
    // Tor-only transactions have their own native relay path. Sending one
    // through the ordinary transaction manager would link the Fusion to the
    // wallet's normal network identity.
    if (record.privacyRoute === 'tor-only') return false;
    if (record.state !== 'submitted') return false;
    const baseline = record.lastCheckedAt ?? record.updatedAt;
    const ageMs = Date.now() - Date.parse(baseline);
    return !Number.isNaN(ageMs) && ageMs >= OUTBOUND_REBROADCAST_COOLDOWN_MS;
  },

  async remove(txid: string, walletId?: number | null): Promise<void> {
    if (walletId !== undefined) {
      try {
        await trackerStore.removeItem(storageKey(txid, walletId));
        const legacy = await trackerStore.getItem<OutboundTransactionRecord>(
          legacyStorageKey(txid)
        );
        if (legacy?.walletId === walletId) {
          await trackerStore.removeItem(legacyStorageKey(txid));
        }
      } catch {
        // The recovery shadow remains independently removable.
      }
      removeFallbackRecords(
        (record) => record.txid === txid && record.walletId === walletId
      );
      emitChange();
      return;
    }

    try {
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
    } catch {
      // The recovery shadow remains independently removable.
    }
    removeFallbackRecords((record) => record.txid === txid);
    emitChange();
  },

  async listAll(
    walletId?: number | null
  ): Promise<OutboundTransactionRecord[]> {
    const records = new Map<string, OutboundTransactionRecord>();
    const fallback = await migrateFallbackRecords();
    try {
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
          records.set(storageKey(value.txid, value.walletId), value);
        }
      );
    } catch {
      // Return the recovery shadow while IndexedDB is unavailable.
    }
    for (const [key, value] of Object.entries(fallback)) {
      if (
        walletId !== undefined &&
        walletId !== null &&
        value.walletId !== walletId
      ) {
        continue;
      }
      records.set(key, value);
    }
    return [...records.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  },

  async listActive(
    walletId?: number | null
  ): Promise<OutboundTransactionRecord[]> {
    const records = await this.listAll(walletId);
    return records.filter((record) => record.state !== 'seen');
  },

  async findFusionVerificationPending(
    walletId?: number | null
  ): Promise<OutboundTransactionRecord | null> {
    const records = await this.listActive(walletId);
    return records.find(isFusionVerificationPending) ?? null;
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

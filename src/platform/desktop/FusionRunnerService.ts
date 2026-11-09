// The desktop's view of CashFusion, which runs in Rust.
//
// A round -- manual or Auto -- is the shared driver's
// (`optn_fusion_native::driver`, the loop the CLI and the docker lab run),
// reached through `nativeFusion`. It chooses coins from the runtime's own
// synchronized record, holds them, runs the round on a server or over Nostr,
// records depth and keeps Auto's timing. This file starts and stops it and
// turns what it reports into what the screens show: the live activity, the
// last result, and the coins a round holds, mirrored for the synchronous
// checks of the send screens (`fusionRoundState`). It decides nothing.
//
// One run at a time, for the whole app: the Rust side refuses a second, and a
// run fuses only the wallet session it was started for.

import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import { reconcileOutboundTransactions } from '../../services/OutboundTransactionReconciler';
import { reconcileActiveWalletUtxosForSpend } from '../../services/WalletUtxoRefreshService';
import type { Network } from '../../state/slices/networkSlice';
import { logError } from '../../utils/errorHandling';
import type { FusionMode } from './fusionAutoEngine';
import {
  clearOutpointReservations,
  releaseOutpoints,
  reserveOutpoints,
} from './fusionRoundState';
import {
  listenNativeFusion,
  nativeFusionRunning,
  startNativeFusion,
  stopNativeFusion,
  type NativeFusionEvent,
  type NativeFusionFinished,
  type NativeFusionRound,
  type NativeFusionVenue,
} from './nativeFusion';

/** Structured, so callers never parse a human string to learn what happened. */
export type FusionRunOutcome =
  | {
      status: 'fused';
      mode: FusionMode;
      txid: string;
      warning?: string;
    }
  | {
      status: 'verification-pending';
      mode: FusionMode;
      txid: string;
      message: string;
    }
  | { status: 'busy' }
  | { status: 'no-eligible-coins'; detail?: string }
  | { status: 'cancelled' }
  | { status: 'failed'; mode: FusionMode; message: string };

/**
 * A live round, for the screens. Settings pages can unmount while a round is
 * gathering peers or signing; navigation neither hides nor cancels it.
 */
export interface FusionActivity {
  walletId: number;
  mode: FusionMode;
  trigger: 'auto' | 'manual';
  startedAt: number;
  /** Live phase 0–5 (P2P stepper / server labels). */
  phase?: number;
  /** Latest status line for CashFusion UI / shell (auto + manual). */
  status?: string | null;
}

/** Last finished auto/manual outcome so the panel shows why fuse failed after idle. */
export interface FusionLastResult {
  walletId: number;
  mode: FusionMode;
  trigger: 'auto' | 'manual';
  ok: boolean;
  message: string;
  at: number;
}

interface NativeRun {
  walletId: number;
  mode: FusionMode;
  trigger: 'auto' | 'manual';
  /** The Auto settings it was started with, so a change can restart it. */
  key: string | null;
  /** The coins the round in progress holds, as the driver reported them. */
  held: string[];
  /** A manual start's caller, told how the run ended. */
  settle: ((outcome: FusionRunOutcome) => void) | null;
  /** Resolves once the driver says the run finished. */
  finished: Promise<void>;
  markFinished: () => void;
  /** Rust has not yet confirmed the start, so it may not report the run. */
  starting: boolean;
}

/** The settings of an Auto run this view adopted rather than started. */
const ADOPTED = 'adopted';

let run: NativeRun | null = null;
/** A manual start is waiting for Auto to step aside; Auto must not restart. */
let manualStarting = false;
const activities = new Map<number, FusionActivity>();
const lastResults = new Map<number, FusionLastResult>();

type FusionActivityListener = (activity: FusionActivity | null) => void;
const activityListeners = new Map<number, Set<FusionActivityListener>>();
const runListeners = new Set<() => void>();

function emitActivity(walletId: number): void {
  const activity = getFusionActivity(walletId);
  for (const listener of activityListeners.get(walletId) ?? []) {
    try {
      listener(activity);
    } catch {
      // A view subscriber must never be able to interrupt a financial action.
    }
  }
}

function emitRun(): void {
  for (const listener of runListeners) {
    try {
      listener();
    } catch {
      /* a view subscriber only */
    }
  }
}

/** Disk + stdout via tauri-plugin-log, so agents can tail a live run. */
function logLine(walletId: number, line: string): void {
  void import('./logger')
    .then(({ log }) => log.info('p2p-live', `w${walletId} ${line}`))
    .catch(() => undefined);
}

export function getFusionActivity(walletId: number): FusionActivity | null {
  return activities.get(walletId) ?? null;
}

export function getFusionLastResult(walletId: number): FusionLastResult | null {
  return lastResults.get(walletId) ?? null;
}

export function setFusionLastResult(
  walletId: number,
  result: Omit<FusionLastResult, 'walletId' | 'at'>
): void {
  lastResults.set(walletId, { ...result, walletId, at: Date.now() });
  emitActivity(walletId);
}

export function subscribeFusionActivity(
  walletId: number,
  listener: FusionActivityListener
): () => void {
  const listeners =
    activityListeners.get(walletId) ?? new Set<FusionActivityListener>();
  listeners.add(listener);
  activityListeners.set(walletId, listeners);
  listener(getFusionActivity(walletId));
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) activityListeners.delete(walletId);
  };
}

/** Told whenever a run starts or finishes, for `useSyncExternalStore`. */
export function subscribeFusionRun(listener: () => void): () => void {
  runListeners.add(listener);
  return () => {
    runListeners.delete(listener);
  };
}

/** A round in progress, or a manual run, for this wallet. */
export function isFusionRunning(walletId: number): boolean {
  return (
    activities.has(walletId) ||
    (run?.walletId === walletId && run.trigger === 'manual')
  );
}

/** The Auto run for this wallet, and the settings it was started with. */
export function autoFusionRun(walletId: number): { key: string } | null {
  return run?.walletId === walletId && run.trigger === 'auto'
    ? { key: run.key ?? '' }
    : null;
}

/** Any run at all, for any wallet. */
export function isNativeFusionBusy(): boolean {
  return run !== null;
}

function setActivity(walletId: number, activity: FusionActivity | null): void {
  if (activity) activities.set(walletId, activity);
  else activities.delete(walletId);
  emitActivity(walletId);
}

function progress(
  walletId: number,
  update: { phase?: number; status?: string | null }
): void {
  const current = activities.get(walletId);
  if (!current) return;
  setActivity(walletId, {
    ...current,
    ...(update.phase !== undefined ? { phase: update.phase } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
  });
  if (update.status) logLine(walletId, update.status);
}

/** Let go of the coins the round in progress held, in this view. */
function releaseHeld(current: NativeRun): void {
  if (current.held.length > 0) {
    releaseOutpoints(current.walletId, current.held);
    current.held = [];
  }
}

/** The history row for a CoinJoin the network holds, before Electrum lists it. */
async function persistFusionHistoryRow(
  walletId: number,
  txid: string
): Promise<void> {
  const hash = txid.trim().toLowerCase();
  const timestamp = new Date().toISOString();
  const DatabaseService = (
    await import('../../apis/DatabaseManager/DatabaseService')
  ).default;
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');
  // height 0 = not yet in a block. Never overwrite a height Electrum wrote.
  db.run(
    `INSERT INTO transactions (wallet_id, tx_hash, height, timestamp, amount)
     VALUES (?, ?, 0, ?, 0)
     ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
       timestamp = CASE
         WHEN transactions.timestamp IS NULL OR transactions.timestamp = ''
         THEN excluded.timestamp
         ELSE transactions.timestamp
       END,
       height = CASE
         WHEN COALESCE(transactions.height, 0) > 0 THEN transactions.height
         ELSE excluded.height
       END`,
    [walletId, hash, timestamp]
  );
  await dbService.saveDatabaseToFile(walletId);
  const { store } = await import('../../state/store');
  const { addTransactions } = await import(
    '../../state/slices/transactionSlice'
  );
  store.dispatch(
    addTransactions({
      wallet_id: walletId,
      transactions: [{ tx_hash: hash, height: 0, timestamp }],
    })
  );
}

/**
 * What the screens keep of a round the driver fused: the Fused label, the
 * depth the runtime recorded, the history row and fresh coins. The runtime
 * already recorded the round; none of this decides anything.
 */
async function showFused(
  walletId: number,
  round: NativeFusionRound
): Promise<void> {
  const depth = await import('./fusionCoinDepth');
  if (round.seen) {
    depth.recordFusionTxid(walletId, round.txid);
    await depth.syncRuntimeFusionDepth(walletId);
    await persistFusionHistoryRow(walletId, round.txid).catch((error) =>
      logError('FusionRunnerService.history', error, {
        walletId,
        txid: round.txid,
      })
    );
  }
  await reconcileActiveWalletUtxosForSpend(walletId).catch(() => null);
}

function fusedMessage(round: NativeFusionRound): string {
  return round.seen
    ? `Fused ✓ — ${round.txid}`
    : `Fusion verification pending — ${round.txid}. The signed Fusion transaction is awaiting independent network visibility.`;
}

function onEvent(event: NativeFusionEvent): void {
  const current = run;
  if (!current || current.walletId !== event.walletId) return;
  const { walletId, trigger } = current;
  const auto = trigger === 'auto';
  switch (event.event) {
    case 'round':
      current.mode = event.mode;
      current.held = event.outpoints;
      reserveOutpoints(walletId, event.outpoints);
      setActivity(walletId, {
        walletId,
        mode: event.mode,
        trigger,
        startedAt: Date.now(),
        phase: 1,
        status: `${auto ? 'Auto-fuse: ' : ''}${event.coins} coin(s) — finding peers…`,
      });
      logLine(walletId, `round ${event.mode} coins=${event.coins}`);
      return;
    case 'status':
      progress(walletId, { status: event.message });
      return;
    case 'phase':
      progress(walletId, { phase: event.phase });
      return;
    case 'released':
      releaseOutpoints(walletId, event.outpoints);
      current.held = current.held.filter(
        (outpoint) => !event.outpoints.includes(outpoint)
      );
      return;
    case 'fused': {
      const message = fusedMessage(event.round);
      logLine(walletId, `OUTCOME fused: ${message}`);
      void showFused(walletId, event.round).catch((error) =>
        logError('FusionRunnerService.fused', error, { walletId })
      );
      if (auto) {
        setActivity(walletId, null);
        setFusionLastResult(walletId, {
          mode: current.mode,
          trigger,
          ok: event.round.seen,
          message: `Auto: ${message}`,
        });
      } else {
        progress(walletId, { status: message });
      }
      return;
    }
    case 'idle':
    case 'waiting':
      if (!auto) return;
      setActivity(walletId, null);
      setFusionLastResult(walletId, {
        mode: current.mode,
        trigger,
        ok: true,
        message:
          event.event === 'idle'
            ? `Auto: ${event.reason}`
            : `Auto: waiting for ${event.reason}.`,
      });
      return;
    case 'retry':
      if (!auto) return;
      releaseHeld(current);
      setActivity(walletId, null);
      setFusionLastResult(walletId, {
        mode: current.mode,
        trigger,
        ok: false,
        message: `Auto: ${event.error} — retrying…`,
      });
      logLine(walletId, `OUTCOME failed: ${event.error}`);
      return;
  }
}

/** How a manual run ended, from the driver's own summary. */
export function outcomeOf(
  finished: NativeFusionFinished,
  mode: FusionMode
): FusionRunOutcome {
  if (!finished.ok) {
    return {
      status: 'failed',
      mode,
      message: finished.error ?? 'Fusion failed.',
    };
  }
  const round = finished.rounds?.[finished.rounds.length - 1];
  if (round) {
    return round.seen
      ? { status: 'fused', mode, txid: round.txid }
      : {
          status: 'verification-pending',
          mode,
          txid: round.txid,
          message:
            'The signed Fusion transaction is awaiting independent network visibility.',
        };
  }
  if (finished.stopped === 'interrupted') return { status: 'cancelled' };
  return {
    status: 'no-eligible-coins',
    ...(finished.stopped ? { detail: finished.stopped } : {}),
  };
}

function onFinished(finished: NativeFusionFinished): void {
  const current = run;
  if (!current || current.walletId !== finished.walletId) return;
  run = null;
  releaseHeld(current);
  setActivity(current.walletId, null);
  const outcome = outcomeOf(finished, current.mode);
  if (current.trigger === 'manual') {
    setFusionLastResult(current.walletId, {
      mode: current.mode,
      trigger: 'manual',
      ok: outcome.status === 'fused' || outcome.status === 'no-eligible-coins',
      message: describeOutcome(outcome),
    });
  } else if (!finished.ok) {
    setFusionLastResult(current.walletId, {
      mode: current.mode,
      trigger: 'auto',
      ok: false,
      message: `Auto: ${finished.error ?? 'stopped.'}`,
    });
  }
  logLine(current.walletId, `run finished: ${outcome.status}`);
  current.settle?.(outcome);
  current.markFinished();
  emitRun();
}

function describeOutcome(outcome: FusionRunOutcome): string {
  switch (outcome.status) {
    case 'fused':
      return `Fused ✓ — ${outcome.txid}`;
    case 'verification-pending':
      return `Fusion verification pending — ${outcome.txid}. ${outcome.message}`;
    case 'no-eligible-coins':
      return outcome.detail ?? 'No eligible coins to fuse.';
    case 'cancelled':
      return 'Fusion stopped.';
    case 'busy':
      return 'Fusion busy (another round is running).';
    case 'failed':
      return outcome.message;
  }
}

let listening: Promise<void> | null = null;

/** Hear the driver from the first start on, for as long as the window lives. */
function ensureListening(): Promise<void> {
  listening ??= listenNativeFusion(onEvent, onFinished).then(
    () => undefined,
    (error) => {
      listening = null;
      throw error;
    }
  );
  return listening;
}

/**
 * A Fusion transaction an earlier, renderer-run round signed and the network
 * has not yet been seen to hold. Another fee-spending round waits for it.
 */
async function pendingVerification(
  walletId: number
): Promise<{ txid: string; source: string } | null> {
  const pending =
    await OutboundTransactionTracker.findFusionVerificationPending(walletId);
  if (!pending) return null;
  await reconcileOutboundTransactions(walletId).catch(() => undefined);
  return (
    (await OutboundTransactionTracker.findFusionVerificationPending(
      walletId
    )) ?? null
  );
}

function newRun(
  walletId: number,
  mode: FusionMode,
  trigger: 'auto' | 'manual',
  key: string | null
): NativeRun {
  let markFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  return {
    walletId,
    mode,
    trigger,
    key,
    held: [],
    settle: null,
    finished,
    markFinished,
    starting: true,
  };
}

/** Ask Rust to start, keeping this view's run only if it did. */
async function begin(
  next: NativeRun,
  request: Parameters<typeof startNativeFusion>[0]
) {
  await ensureListening();
  run = next;
  emitRun();
  try {
    await startNativeFusion(request);
    next.starting = false;
  } catch (error) {
    if (run === next) run = null;
    emitRun();
    throw error;
  }
}

export interface StartFusionRoundOptions {
  walletId: number;
  network: Network;
  mode: FusionMode;
  /** Where to fuse: the chosen server and the rest, or the Nostr relays. */
  venue: NativeFusionVenue;
  fuseDepth: number;
}

/**
 * One manual round. An Auto run of the same wallet steps aside for it; the
 * Auto hook starts Auto again once it ends.
 */
export async function startFusionRound(
  options: StartFusionRoundOptions
): Promise<FusionRunOutcome> {
  const { walletId } = options;
  if (!Number.isInteger(walletId) || walletId <= 0) return { status: 'busy' };
  if (run && !(run.walletId === walletId && run.trigger === 'auto')) {
    return { status: 'busy' };
  }
  const pending = await pendingVerification(walletId);
  if (pending) {
    return {
      status: 'verification-pending',
      mode: /server/i.test(pending.source) ? 'server' : 'p2p',
      txid: pending.txid,
      message:
        'A previous Fusion transaction is still awaiting independent network visibility.',
    };
  }
  if (manualStarting) return { status: 'busy' };
  manualStarting = true;
  try {
    return await startManual(options);
  } finally {
    manualStarting = false;
  }
}

async function startManual(
  options: StartFusionRoundOptions
): Promise<FusionRunOutcome> {
  const { walletId, mode } = options;
  if (run) {
    const auto = run;
    await stopNativeFusion().catch(() => false);
    await auto.finished;
  }
  if (run) return { status: 'busy' };

  const next = newRun(walletId, mode, 'manual', null);
  const outcome = new Promise<FusionRunOutcome>((resolve) => {
    next.settle = resolve;
  });
  setActivity(walletId, {
    walletId,
    mode,
    trigger: 'manual',
    startedAt: Date.now(),
    phase: 1,
    status: 'Refreshing coins…',
  });
  try {
    await begin(next, {
      walletId,
      venue: options.venue,
      auto: false,
      fuseDepth: options.fuseDepth,
    });
  } catch (error) {
    setActivity(walletId, null);
    const message = error instanceof Error ? error.message : String(error);
    const failed: FusionRunOutcome = /already running/i.test(message)
      ? { status: 'busy' }
      : { status: 'failed', mode, message };
    setFusionLastResult(walletId, {
      mode,
      trigger: 'manual',
      ok: false,
      message: describeOutcome(failed),
    });
    return failed;
  }
  return outcome;
}

export interface StartAutoFusionOptions {
  walletId: number;
  mode: FusionMode;
  venue: NativeFusionVenue;
  fuseDepth: number;
  /** The settings this run uses, so the hook can tell when they change. */
  key: string;
}

/**
 * Keep fusing this wallet as Auto Fusion until stopped. Rust keeps the
 * cooldowns, the depth target and the P2P rendezvous window.
 */
export async function startAutoFusion(
  options: StartAutoFusionOptions
): Promise<'started' | 'busy' | 'pending'> {
  const { walletId, mode } = options;
  if (run || manualStarting) return 'busy';
  const pending = await pendingVerification(walletId);
  if (pending) {
    setFusionLastResult(walletId, {
      mode,
      trigger: 'auto',
      ok: false,
      message: `Auto: Fusion verification pending — ${pending.txid}. Waiting before another round.`,
    });
    return 'pending';
  }
  if (run || manualStarting) return 'busy';
  await begin(newRun(walletId, mode, 'auto', options.key), {
    walletId,
    venue: options.venue,
    auto: true,
    fuseDepth: options.fuseDepth,
  });
  return 'started';
}

/**
 * Stop this wallet's run, cancelling its round. The engine still finishes
 * what it must once components are disclosed. `false` when none was running.
 */
export function cancelFusionRound(
  walletId: number,
  reason = 'wallet session changed'
): boolean {
  if (run?.walletId !== walletId) return false;
  logLine(walletId, `stop: ${reason}`);
  void stopNativeFusion().catch((error) =>
    logError('FusionRunnerService.stop', error, { walletId })
  );
  return true;
}

/** Stop the run and wait until the driver says it finished. */
export async function stopFusionRun(walletId: number): Promise<void> {
  const current = run;
  if (current?.walletId !== walletId) return;
  cancelFusionRound(walletId, 'stopped');
  await current.finished;
}

/**
 * Drop what this view mirrors of a run Rust no longer has -- a reload while
 * a round ran, or a lost finish event. Called when the CashFusion panel opens.
 */
export async function reconcileIdleFusionState(
  walletId: number
): Promise<void> {
  if (!Number.isInteger(walletId) || walletId <= 0) return;
  // A start still on its way to Rust is not a lost run.
  if (run?.starting) return;
  let native;
  try {
    native = await nativeFusionRunning();
  } catch {
    return; // Rust could not say; change nothing.
  }
  if (run?.starting) return;
  if (run) {
    if (native?.walletId === run.walletId) return;
    onFinished({
      walletId: run.walletId,
      mode: run.mode,
      auto: run.trigger === 'auto',
      ok: true,
      stopped: 'interrupted',
    });
    return;
  }
  if (native?.walletId === walletId) {
    // A run this view lost track of, after a reload while it ran: show it,
    // and let Stop and the Auto hook reach it. An adopted Auto run is
    // restarted with the current settings, or stopped if Auto is not armed.
    await ensureListening();
    if (run) return;
    const adopted = newRun(
      walletId,
      native.mode,
      native.auto ? 'auto' : 'manual',
      native.auto ? ADOPTED : null
    );
    adopted.starting = false;
    run = adopted;
    emitRun();
    return;
  }
  if (activities.has(walletId)) setActivity(walletId, null);
  if (!native) clearOutpointReservations(walletId);
}

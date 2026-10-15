// The desktop's CashFusion is the shared Rust driver
// (`optn_fusion_native::driver`, behind `src-tauri/src/fusion_driver.rs`) --
// the loop the CLI and the docker lab run. This file only asks it to start or
// stop and hears what it reports. Coin choice, keys, holds, the round itself,
// the depth record and Auto's timing all stay in Rust; no key and no coin
// list crosses to the renderer.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const NATIVE_FUSION_EVENT = 'optn://fusion-event';
export const NATIVE_FUSION_FINISHED = 'optn://fusion-finished';

/** Where to fuse. Rust reads the Electrum selection and Tor proxy itself. */
export type NativeFusionVenue =
  | {
      mode: 'server';
      /** The holder's choice, tried first; then the rest, in order. */
      selected?: string | null;
      configured: string[];
      onlyTiers?: number[];
    }
  | { mode: 'p2p'; relays?: string[] };

export interface NativeFusionStart {
  walletId: number;
  venue: NativeFusionVenue;
  /** Keep fusing as Auto Fusion, rather than run once. */
  auto: boolean;
  rounds?: number;
  fuseDepth: number;
}

export interface NativeFusionRound {
  txid: string;
  /** Whether the network was seen to hold it; only then does depth move. */
  seen: boolean;
  spent: string[];
  created: string[];
}

/** One line the driver reports, as `optn_fusion_native::driver` writes it. */
export type NativeFusionEvent = { walletId: number } & (
  | {
      event: 'round';
      mode: 'server' | 'p2p';
      coins: number;
      outpoints: string[];
    }
  | { event: 'status'; message: string }
  /** The step a P2P round reached, as the stepper numbers them. */
  | { event: 'phase'; phase: number }
  | { event: 'released'; outpoints: string[] }
  | { event: 'fused'; round: NativeFusionRound }
  | { event: 'idle'; reason: string }
  | { event: 'waiting'; reason: string; next_in_ms: number }
  | {
      event: 'retry';
      error: string;
      transient: boolean;
      next_in_ms?: number;
    }
);

export interface NativeFusionFinished {
  walletId: number;
  mode: 'server' | 'p2p';
  auto: boolean;
  ok: boolean;
  error?: string;
  rounds?: NativeFusionRound[];
  /** Why a run ended without an error: "interrupted", or why nothing fused. */
  stopped?: string | null;
}

interface EngineSession {
  active: string | null;
  legacy_source_id: number | null;
  epoch: number;
}

/**
 * The shared engine's session for `walletId`. Rust refuses a run, or a depth
 * read, for any other wallet or a later session; this only fails earlier.
 */
export async function engineSessionEpoch(walletId: number): Promise<number> {
  const session = await invoke<EngineSession>('optn_wallet_security', {
    request: { command: 'status' },
  });
  if (
    !session.active ||
    session.legacy_source_id !== walletId ||
    !Number.isSafeInteger(session.epoch) ||
    session.epoch < 0
  ) {
    throw new Error('Open this wallet in the shared engine before fusing.');
  }
  return session.epoch;
}

/** Start a run. Resolves once it is under way; the rest arrives as events. */
export async function startNativeFusion(
  request: NativeFusionStart
): Promise<void> {
  const epoch = await engineSessionEpoch(request.walletId);
  await invoke('optn_fusion_start', { request: { ...request, epoch } });
}

/** Stop the run, cancelling its round. `false` when none was running. */
export function stopNativeFusion(): Promise<boolean> {
  return invoke<boolean>('optn_fusion_stop');
}

export function nativeFusionRunning(): Promise<boolean> {
  return invoke<boolean>('optn_fusion_running');
}

export async function listenNativeFusion(
  onEvent: (event: NativeFusionEvent) => void,
  onFinished: (finished: NativeFusionFinished) => void
): Promise<UnlistenFn> {
  const events = await listen<NativeFusionEvent>(NATIVE_FUSION_EVENT, (e) =>
    onEvent(e.payload)
  );
  try {
    const finished = await listen<NativeFusionFinished>(
      NATIVE_FUSION_FINISHED,
      (e) => onFinished(e.payload)
    );
    return () => {
      events();
      finished();
    };
  } catch (error) {
    events();
    throw error;
  }
}

/** The runtime's depth record, in its stored forms. */
export interface NativeFusionDepth {
  coins: string;
  txDepth: string;
  txids: string[];
}

export async function nativeFusionDepth(
  walletId: number
): Promise<NativeFusionDepth> {
  const epoch = await engineSessionEpoch(walletId);
  return invoke<NativeFusionDepth>('optn_fusion_depth', { walletId, epoch });
}

/** Merge a depth record kept in the renderer into the runtime's. */
export async function importNativeFusionDepth(
  walletId: number,
  record: { coins: string | null; txDepth: string | null; txids: string[] }
): Promise<void> {
  const epoch = await engineSessionEpoch(walletId);
  await invoke('optn_fusion_depth_import', { walletId, epoch, ...record });
}

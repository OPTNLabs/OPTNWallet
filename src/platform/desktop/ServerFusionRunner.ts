// Shared server fusion runner — used by both manual settings and auto mode.
// Takes a ServerHello snapshot from the native handshake, which refuses a
// server outside Electron Cash's limits before any key is derived. Tier
// planning (EC allocate_outputs and random_outputs_for_tier: every feasible
// tier, a random excess fee per tier, exponential output amounts) runs
// natively in optn-fusion, the same code for every surface.
//
// The runner never claims a result is "fused" until the Rust engine returns an
// exact txid + tx_hex, the attempt is persisted, and the network is shown to
// hold the transaction. CashFusion servers broadcast the CoinJoin themselves,
// so we confirm with Electrum first (fast, same truth as "is it on the net?").
// Dual-peer Tor relay+observe is only a backup when Electrum does not yet have
// it — that path can take ~25s and is the wrong default after a server round.

import { invoke } from '@tauri-apps/api/core';

import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import {
  fetchFusionServerStatus,
} from '../../services/fusion/FusionStatusService';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import { getElectrumServers } from '../../utils/servers/InfraUrls';
import {
  gatherInputs,
  createFreshFusionOutputScripts,
  type FusionOutcome,
} from './FusionService';
import {
  completeFusionBroadcast,
  fusionCompletionWarning,
} from './FusionCompletionService';
import {
  outpointKey,
  releaseOutpoints,
  reserveOutpoints,
  reservedOutpoints,
} from './fusionRoundState';
import { isLocalFusionDestination } from './FusionTorResolver';
import { networkProfile } from '../../utils/networkProfile';

// ── ServerHello snapshot ──────────────────────────────────────────────────
export interface ServerHelloSnapshot {
  tiers: number[];
  numComponents: number;
  componentFeerate: number;
  minExcessFee: number;
  maxExcessFee: number;
  donationAddress?: string | null;
}

/** One tier's plan, as native planning returns it and `fusion_run` takes it. */
interface FusionTierPlan {
  tier: number;
  outputValues: number[];
  excessFee: number;
}

interface FusionExecutionStatus {
  ready: boolean;
  message?: string | null;
}

export interface FusionRelayObservation {
  txid: string;
  relaySubmitted: boolean;
  observerSeen: boolean;
}

export interface FusionRelayEndpoints {
  relayHost: string;
  relayPort: number;
  observerHost: string;
  observerPort: number;
}

export interface FusionElectrumEndpoint {
  host: string;
  port: number;
  useSsl: boolean;
}

export interface FusionServerTarget {
  host: string;
  port: number;
  useSsl: boolean;
}

export function parseFusionServerTarget(server: string): FusionServerTarget {
  const token = server.trim().split(/\s+/)[0] ?? '';
  const match = /^([^:\s]+)(?::(\d+))?(?::([st]))?$/.exec(token);
  if (!match) throw new Error('CashFusion server address is invalid.');
  const port = match[2] === undefined ? 8789 : Number(match[2]);
  if (!match[1] || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CashFusion server address is invalid.');
  }
  const host = match[1];
  const explicitScheme = match[3];
  return {
    host,
    port,
    // Electron Cash's server.py speaks PLAIN TCP — it has no TLS of its own;
    // the public servers are fronted by something else that terminates it. So
    // defaulting every address to SSL made a local server unreachable, and the
    // failure was "TLS handshake failed: tls handshake eof", which reads as a
    // broken server rather than as us speaking the wrong protocol at it.
    //
    // A remote server still defaults to SSL, because sending fusion traffic to
    // the internet in the clear is the worse mistake. An explicit `:s` or `:t`
    // suffix always wins over both defaults.
    useSsl: explicitScheme
      ? explicitScheme === 's'
      : !isLocalFusionDestination(host),
  };
}

export function serverFusionPrivacyDestination(
  serverHost: string,
  lookupHost: string
): string {
  return isLocalFusionDestination(serverHost)
    ? lookupHost
    : serverHost;
}

export function parseElectrumLookupEndpoint(
  server: string
): FusionElectrumEndpoint {
  const token = server.trim().split(/\s+/)[0] ?? '';
  if (!token) throw new Error('No Electrum server is configured.');
  if (/^wss?:\/\//i.test(token)) {
    const url = new URL(token);
    const secure = url.protocol.toLowerCase() === 'wss:';
    const requestedPort = Number(url.port || (secure ? 50004 : 50003));
    const port =
      requestedPort === 50004
        ? 50002
        : requestedPort === 50003
          ? 50001
          : requestedPort;
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Electrum server address is invalid.');
    }
    return { host: url.hostname, port, useSsl: secure };
  }

  const match = /^([^:\s]+)(?::(\d+))?(?::([st]))?$/.exec(token);
  if (!match) throw new Error('Electrum server address is invalid.');
  const port = match[2] === undefined ? 50002 : Number(match[2]);
  if (!match[1] || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Electrum server address is invalid.');
  }
  return { host: match[1], port, useSsl: match[3] !== 't' };
}

export function defaultInputLookupEndpoint(
  network: Network
): FusionElectrumEndpoint {
  const server = getElectrumServers(network)[0];
  if (!server) throw new Error('No Electrum server is configured.');
  return parseElectrumLookupEndpoint(server);
}

/**
 * Every configured Electrum server, in preference order, for verifying peer
 * inputs during blame.
 *
 * Verifying against one fixed server means one unreachable host makes every
 * peer's coin unverifiable — and because absent evidence must never be turned
 * into an accusation, the round is abandoned instead. Chipnet showed exactly
 * that: the first configured server timed out over Tor while the other two
 * answered, so every round reached StartRound and died there.
 */
export function inputLookupEndpoints(
  network: Network,
  preferred?: FusionElectrumEndpoint
): FusionElectrumEndpoint[] {
  const configured = getElectrumServers(network).map(parseElectrumLookupEndpoint);
  const ordered = preferred ? [preferred, ...configured] : configured;
  if (ordered.length === 0) {
    throw new Error('No Electrum server is configured.');
  }
  const seen = new Set<string>();
  return ordered.filter((endpoint) => {
    const key = `${endpoint.host}:${endpoint.port}:${endpoint.useSsl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function defaultRelayEndpoints(network: Network): FusionRelayEndpoints {
  if (network !== Network.MAINNET && network !== Network.CHIPNET) {
    throw new Error(
      `CashFusion is not available on ${networkProfile(network).label}.`
    );
  }
  if (network === Network.CHIPNET) {
    return {
      relayHost: 'chipnet.bitjson.com',
      relayPort: 48333,
      observerHost: 'seed.cbch.loping.net',
      observerPort: 48333,
    };
  }
  return {
    relayHost: 'seed.flowee.cash',
    relayPort: 8333,
    observerHost: 'seed.bch.loping.net',
    observerPort: 8333,
  };
}

// ── Shared runner ─────────────────────────────────────────────────────────
export interface ServerRunnerConfig {
  walletId: number;
  network: Network;
  host: string;
  port: number;
  useSsl: boolean;
  tor: { host: string; port: number } | null;
  /** Tests may pin a snapshot; production callers omit this so the native
   * process performs a live handshake (coalesced briefly across windows). */
  expectedHello?: ServerHelloSnapshot;
  onServerHello?: (hello: ServerHelloSnapshot) => void;
  inputLookupEndpoint?: FusionElectrumEndpoint;
  relayEndpoints?: FusionRelayEndpoints;
  /** Electron Cash Auto-only idle deadline. Manual rounds omit this. */
  joinInactiveTimeoutMs?: number;
  /**
   * Register for these tiers only, instead of every tier the coins can fund.
   *
   * Two wallets each register for whichever tiers their amounts happen to
   * allow — a set that is not even stable across runs, because a random fuzz
   * fee feeds the calculation. They queue in different pools and wait, with
   * nothing on screen explaining why. Pinning the same tier in both makes them
   * meet deliberately rather than by luck.
   */
  onlyTiers?: readonly number[];
}

async function requireNativeExecutionReady(): Promise<void> {
  const status = await invoke<FusionExecutionStatus>(
    'fusion_execution_status'
  );
  if (!status.ready) {
    throw new Error(
      status.message || 'CashFusion execution is not available in this build.'
    );
  }
}

function createRoundId(): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `srv-${Date.now()}-${random[0].toString(36)}${random[1].toString(36)}`;
}

export type ServerRunnerProgress = {
  onStatus?: (message: string) => void;
  onPhase?: (phase: number) => void;
};

/**
 * Build a `runServer` function matching the FusionRunnerService runner
 * signature: `(coins, signal?, progress?) => Promise<{txid, warning?}>`.
 *
 * Both manual and auto callers use the same builder. The runner:
 *  - plans every feasible tier natively and pre-generates the max output
 *    script pool
 *  - passes the snapshot to fusion_run for live match before JoinPools
 *  - persists the assembled transaction before any relay attempt
 *  - relays and independently observes the exact transaction over Tor
 *  - invokes fusion_cancel_round on AbortSignal
 */
export function buildServerRunner(
  config: ServerRunnerConfig
): (
  coins: UTXO[],
  signal?: AbortSignal,
  progress?: ServerRunnerProgress
) => Promise<{ txid: string; warning?: string }> {
  return async (coins, signal, progress) => {
    if (signal?.aborted) throw new Error('fusion round cancelled');

    const status = (message: string, phase?: number) => {
      progress?.onStatus?.(message);
      if (phase !== undefined) progress?.onPhase?.(phase);
    };

    status(
      `Contacting fusion server ${config.host}:${config.port}…`,
      1
    );
    await requireNativeExecutionReady();
    if (signal?.aborted) throw new Error('fusion round cancelled');

    const expectedHello =
      config.expectedHello ??
      (await fetchFusionServerStatus(
        config.host,
        config.port,
        config.useSsl,
        config.tor ?? undefined
      ));
    config.onServerHello?.(expectedHello);
    status(
      `Server ready — ${expectedHello.tiers.length} tier(s), preparing inputs…`,
      2
    );
    if (signal?.aborted) throw new Error('fusion round cancelled');

    const roundId = createRoundId();
    await invoke('fusion_prepare_round', { roundId });

    let cancelSent = false;
    let runSettled = false;
    let reservedForRound: string[] = [];
    let retainTemporaryReservation = false;
    const sendCancel = () => {
      if (cancelSent) return;
      cancelSent = true;
      void invoke('fusion_cancel_round', { roundId }).catch(() => undefined);
    };
    signal?.addEventListener('abort', sendCancel, { once: true });

    try {
      if (signal?.aborted) throw new Error('fusion round cancelled');
      reservedForRound = coins.map((coin) =>
        outpointKey(coin.tx_hash, coin.tx_pos)
      );
      const alreadyReserved = reservedOutpoints(config.walletId);
      if (reservedForRound.some((outpoint) => alreadyReserved.has(outpoint))) {
        throw new Error(
          'One or more selected coins are already reserved by another Fusion round.'
        );
      }
      reserveOutpoints(config.walletId, reservedForRound);

      const inputs = await gatherInputs(config.walletId, coins);
      if (signal?.aborted) throw new Error('fusion round cancelled');

      // Planned natively from public keys and values only. It refuses a
      // snapshot outside Electron Cash's limits and a contribution that funds
      // no tier, naming pinned tiers when they are the reason.
      const tierPlans = await invoke<FusionTierPlan[]>('fusion_allocate_tiers', {
        expectedHello,
        inputs: inputs.map(({ pubkey, value }) => ({ pubkey, value })),
        onlyTiers: config.onlyTiers ?? null,
      });
      if (signal?.aborted) throw new Error('fusion round cancelled');
      const maxOutputCount = tierPlans.reduce(
        (most, plan) => Math.max(most, plan.outputValues.length),
        0
      );

      const allScripts = await createFreshFusionOutputScripts(
        config.walletId,
        config.network,
        maxOutputCount
      );
      if (signal?.aborted) throw new Error('fusion round cancelled');

      // From this point an interrupted native invocation may already have
      // disclosed signatures. Keep the temporary lock unless a definitive
      // failure is returned or the durable outbound tracker takes over.
      retainTemporaryReservation = true;
      const lookupChain = inputLookupEndpoints(
        config.network,
        config.inputLookupEndpoint
      );
      const [lookupEndpoint, ...lookupFallbacks] = lookupChain;
      // Auto: 600s inactivity if the server never advertises time_remaining.
      // Manual: no client cutoff — wait until players show or the user cancels.
      const aloneCapSec =
        typeof config.joinInactiveTimeoutMs === 'number' &&
        config.joinInactiveTimeoutMs > 0
          ? Math.round(config.joinInactiveTimeoutMs / 1000)
          : null;
      status(
        `In server pool (${tierPlans.length} tier(s), ${inputs.length} input(s)) — waiting for other wallets…`,
        3
      );
      const poolStartedAt = Date.now();
      const poolHeartbeat = setInterval(() => {
        if (signal?.aborted) return;
        const waited = Math.floor((Date.now() - poolStartedAt) / 1000);
        const hint =
          aloneCapSec != null
            ? `alone up to ${aloneCapSec}s then Auto retries`
            : 'no time limit — needs other people in this server pool (Stop to cancel)';
        status(
          `In server pool — waiting for other wallets… (${waited}s; ${hint})`
        );
      }, 8_000);
      let outcome: FusionOutcome;
      try {
        outcome = await invoke<FusionOutcome>('fusion_run', {
          roundId,
          // Stable per wallet, deliberately NOT per round: the server uses it to
          // refuse putting the same wallet in one fusion twice. Hashed native-side
          // with a per-process salt, so it is not a pseudonym that outlives the
          // process.
          walletTag: String(config.walletId),
          host: config.host,
          port: config.port,
          useSsl: config.useSsl,
          tierPlans,
          inputs,
          outputScripts: allScripts,
          lookupHost: lookupEndpoint.host,
          lookupPort: lookupEndpoint.port,
          lookupUseSsl: lookupEndpoint.useSsl,
          lookupFallbacks,
          torHost: config.tor?.host ?? null,
          torPort: config.tor?.port ?? null,
          expectedHello,
          joinInactiveTimeoutMs: config.joinInactiveTimeoutMs ?? null,
        });
      } finally {
        clearInterval(poolHeartbeat);
      }
      runSettled = true;
      status('Round finished on server — confirming broadcast…', 5);

      // The round engine assembles and validates the fully signed transaction.
      // Network acceptance is verified independently of the Fusion server.
      if (!outcome.ok) {
        retainTemporaryReservation = false;
        throw new Error(
          outcome.message || 'Fusion round did not produce a signed transaction.'
        );
      }
      if (!outcome.txid || !outcome.tx_hex) {
        throw new Error(
          outcome.message || 'Fusion round did not produce a signed transaction.'
        );
      }

      const trackedAttempt = await OutboundTransactionTracker.trackAttempt({
        walletId: config.walletId,
        rawTx: outcome.tx_hex,
        spentInputs: coins,
        source: 'server-fusion',
        sourceLabel: 'CashFusion server',
        privacyRoute: 'tor-only',
      });
      if (trackedAttempt) retainTemporaryReservation = false;
      if (
        !trackedAttempt ||
        trackedAttempt.txid.toLowerCase() !== outcome.txid.toLowerCase()
      ) {
        throw new Error(
          'The signed Fusion transaction could not be safely reserved before relay.'
        );
      }

      // Fast path (normal case): the Fusion server already broadcast the
      // CoinJoin. Electrum `transaction_is_known` answers in ~1s over Tor —
      // same question as dual-peer observe, without a 10s+15s P2P wait that
      // usually cannot hear an echo (nodes already have the tx).
      const knownLookup = {
        txid: outcome.txid,
        lookupHost: lookupEndpoint.host,
        lookupPort: lookupEndpoint.port,
        lookupUseSsl: lookupEndpoint.useSsl,
        lookupFallbacks,
        torHost: config.tor?.host ?? null,
        torPort: config.tor?.port ?? null,
      };
      let networkHoldsTx = await invoke<boolean>(
        'fusion_transaction_is_known',
        knownLookup
      ).catch(() => false);

      if (!networkHoldsTx) {
        // Slow backup only: server may have failed to announce. Push via
        // Tor dual-peer relay; treat observer miss / command error as soft —
        // re-ask Electrum afterward (Rust used to Err on no echo, which
        // skipped this fallback entirely).
        status('Announcing transaction (backup)…', 5);
        const relayEndpoints =
          config.relayEndpoints ?? defaultRelayEndpoints(config.network);
        try {
          const observation = await invoke<FusionRelayObservation>(
            'fusion_relay_broadcast_and_observe',
            {
              txHex: outcome.tx_hex,
              network: config.network,
              ...relayEndpoints,
              torHost: config.tor?.host ?? null,
              torPort: config.tor?.port ?? null,
            }
          );
          networkHoldsTx =
            observation.relaySubmitted &&
            observation.observerSeen &&
            observation.txid.toLowerCase() === outcome.txid.toLowerCase();
        } catch {
          networkHoldsTx = false;
        }
        if (!networkHoldsTx) {
          networkHoldsTx = await invoke<boolean>(
            'fusion_transaction_is_known',
            knownLookup
          ).catch(() => false);
        }
      }

      if (!networkHoldsTx) {
        throw new Error(
          'The Fusion transaction was not independently observed after relay.'
        );
      }

      // Same completion path as P2P (depth, history SQL, labels, outbox clear).
      const completion = await completeFusionBroadcast({
        walletId: config.walletId,
        txid: outcome.txid,
        txHex: outcome.tx_hex,
        spentInputs: coins,
        source: 'server-fusion',
        sourceLabel: 'CashFusion server',
        privacyRoute: 'tor-only',
        ownedOutputScripts: allScripts,
      });
      const warning = fusionCompletionWarning(completion);
      return { txid: outcome.txid, ...(warning ? { warning } : {}) };
    } finally {
      signal?.removeEventListener('abort', sendCancel);
      if (!runSettled) sendCancel();
      if (reservedForRound.length > 0 && !retainTemporaryReservation) {
        releaseOutpoints(config.walletId, reservedForRound);
      }
    }
  };
}

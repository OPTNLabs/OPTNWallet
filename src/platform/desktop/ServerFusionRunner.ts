// Shared server fusion runner — used by both manual settings and future auto
// mode. Accepts a ServerHello snapshot from the handshake probe and validates
// it against Electron Cash limits BEFORE spending any keys. Registers every
// feasible tier (EC allocate_outputs), randomizes the excess fee per tier, and
// uses random_outputs_for_tier semantics with exponential distribution.
//
// The runner never claims a result is "fused" until the Rust engine returns an
// exact txid + tx_hex, the attempt is persisted, a Tor-routed BCH peer accepts
// the relay, and a distinct Tor-routed peer returns the exact transaction.

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

// ── EC protocol constants (fusion.py) ─────────────────────────────────────
const MAX_COMPONENT_FEERATE = 5000;
const MAX_EXCESS_FEE = 10_000;
const MAX_COMPONENTS = 40;
const MAX_FEE = 45_000;
const MIN_TX_COMPONENTS = 11;
const MIN_OUTPUT = 10_000;

// ── Fee formulas (util.py) ────────────────────────────────────────────────
const componentFee = (size: number, feerate: number) =>
  Math.ceil((size * feerate) / 1000); // ponytail: matches (size*feerate+999)//1000
const sizeOfInput = (pubkeyLen: number) => 108 + pubkeyLen;
const feePerOutput = (feerate: number) => componentFee(34, feerate); // P2PKH output

// ── ServerHello snapshot ──────────────────────────────────────────────────
export interface ServerHelloSnapshot {
  tiers: number[];
  numComponents: number;
  componentFeerate: number;
  minExcessFee: number;
  maxExcessFee: number;
  donationAddress?: string | null;
}

interface FusionExecutionStatus {
  ready: boolean;
  message?: string | null;
}

interface FusionRelayObservation {
  txid: string;
  relaySubmitted: boolean;
  observerSeen: boolean;
}

interface FusionRelayEndpoints {
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
  return {
    host: match[1],
    port,
    useSsl: match[3] !== 't',
  };
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

function defaultInputLookupEndpoint(network: Network): FusionElectrumEndpoint {
  const server = getElectrumServers(network)[0];
  if (!server) throw new Error('No Electrum server is configured.');
  return parseElectrumLookupEndpoint(server);
}

function defaultRelayEndpoints(network: Network): FusionRelayEndpoints {
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

const isSafeNonNegativeInteger = (value: number) =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * Validate a ServerHello against the EC safety limits.
 * Throws on any violation — the round must not proceed.
 */
export function validateServerHello(hello: ServerHelloSnapshot): void {
  if (
    !Array.isArray(hello.tiers) ||
    hello.tiers.length === 0 ||
    hello.tiers.length > 64 ||
    hello.tiers.some(
      (tier) => !Number.isSafeInteger(tier) || tier < MIN_OUTPUT
    ) ||
    new Set(hello.tiers).size !== hello.tiers.length
  ) {
    throw new Error('bad config on server: tiers');
  }
  if (
    !isSafeNonNegativeInteger(hello.componentFeerate) ||
    !isSafeNonNegativeInteger(hello.minExcessFee) ||
    !isSafeNonNegativeInteger(hello.maxExcessFee)
  ) {
    throw new Error('bad config on server: numeric values');
  }
  if (hello.componentFeerate > MAX_COMPONENT_FEERATE) {
    throw new Error('excessive component feerate from server');
  }
  if (hello.minExcessFee > 400) {
    throw new Error('excessive min excess fee from server');
  }
  if (hello.minExcessFee > hello.maxExcessFee) {
    throw new Error('bad config on server: fees');
  }
  if (
    !Number.isSafeInteger(hello.numComponents) ||
    hello.numComponents < Math.ceil(MIN_TX_COMPONENTS * 1.5) ||
    hello.numComponents > MAX_COMPONENTS
  ) {
    throw new Error('bad config on server: num_components');
  }
}

// ── random_outputs_for_tier (EC fusion.py) ────────────────────────────────
/**
 * EC-compatible exponential output allocation. Returns `null` on expected
 * failures (input too small/large for the distribution). On success, the
 * returned values sum exactly to `inputAmount`.
 *
 * `rng` returns a uniform [0, 1) random number.
 */
export function randomOutputsForTier(
  rng: () => number,
  inputAmount: number,
  scale: number,
  offset: number,
  maxCount: number
): number[] | null {
  if (
    !Number.isSafeInteger(inputAmount) ||
    !Number.isSafeInteger(scale) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(maxCount) ||
    inputAmount < offset ||
    scale <= 0 ||
    offset <= 0 ||
    maxCount < 1
  ) {
    return null;
  }

  // Exponential variate: -scale * ln(1 - U)
  const expovariate = () => {
    const sample = rng();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error('fusion random source returned an invalid sample');
    }
    return -scale * Math.log(1 - sample);
  };

  let remaining = inputAmount;
  const values: number[] = [];
  for (let i = 0; i < maxCount + 1; i++) {
    const val = expovariate();
    remaining -= Math.ceil(val) + offset;
    if (remaining < 0) break;
    values.push(val);
  }
  // If we exhausted maxCount+1 iterations without breaking, too many outputs
  if (values.length > maxCount) return null;
  if (values.length === 0) return null;

  const desiredRandomSum = inputAmount - values.length * offset;
  if (desiredRandomSum < 0) return null;

  // Rescale + round in cumulative space (EC method)
  const cumsum: number[] = [];
  let acc = 0;
  for (const v of values) {
    acc += v;
    cumsum.push(acc);
  }
  const rescale = desiredRandomSum / cumsum[cumsum.length - 1];
  const normedCumsum = cumsum.map((v) => Math.round(rescale * v));

  const result: number[] = [];
  let prev = 0;
  for (const cs of normedCumsum) {
    result.push(offset + (cs - prev));
    prev = cs;
  }

  return result;
}

// ── Per-tier allocation plan ──────────────────────────────────────────────
export interface TierPlan {
  values: number[]; // output values (tier-sized via random_outputs_for_tier)
  excessFee: number;
  inputFees: number;
}

/**
 * Register every feasible tier (EC allocate_outputs). Returns a map from
 * tier → allocation plan. The caller picks one after FusionBegin tells
 * which tier was selected.
 */
export function allocateAllFeasibleTiers(
  hello: ServerHelloSnapshot,
  sumIn: number,
  inputPubkeys: Uint8Array[],
  rng: () => number
): Map<number, TierPlan> {
  const numInputs = inputPubkeys.length;
  if (
    !Number.isSafeInteger(sumIn) ||
    sumIn <= 0 ||
    numInputs === 0 ||
    inputPubkeys.some(
      (key) =>
        key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03)
    )
  ) {
    return new Map();
  }
  const maxComponents = hello.numComponents;
  const maxOutputs = maxComponents - numInputs;
  if (maxOutputs < 1) return new Map();

  const numDistinct = new Set(
    inputPubkeys.map((pk) => Array.from(pk).join(','))
  ).size;
  const minOutputs = Math.max(MIN_TX_COMPONENTS - numDistinct, 1);
  if (maxOutputs < minOutputs) return new Map();

  const inputFees = inputPubkeys.reduce(
    (sum, pk) => sum + componentFee(sizeOfInput(pk.length), hello.componentFeerate),
    0
  );
  const availForOutputs = sumIn - inputFees - hello.minExcessFee;
  const outputFee = feePerOutput(hello.componentFeerate);
  const offsetPerOutput = MIN_OUTPUT + outputFee;

  if (availForOutputs < offsetPerOutput) return new Map();

  const result = new Map<number, TierPlan>();

  for (const scale of hello.tiers) {
    // Fuzz fee: tier / 1_000_000 (EC: scale // 1000000)
    const fuzzFeeMax = Math.floor(scale / 1_000_000);
    const fuzzFeeMaxReduced = Math.min(
      fuzzFeeMax,
      MAX_EXCESS_FEE - hello.minExcessFee,
      hello.maxExcessFee - hello.minExcessFee
    );
    if (fuzzFeeMaxReduced < 0) continue;

    // Uniform random fuzz fee: 0..fuzzFeeMaxReduced inclusive
    const fuzzFee = Math.floor(rng() * (fuzzFeeMaxReduced + 1));
    const reducedAvail = availForOutputs - fuzzFee;
    if (reducedAvail < offsetPerOutput) continue;

    const outputs = randomOutputsForTier(
      rng,
      reducedAvail,
      scale,
      offsetPerOutput,
      maxOutputs
    );
    if (!outputs || outputs.length < minOutputs) continue;

    // Subtract per-output fees (EC: outputs = tuple(o - fee_per_output for o in outputs))
    const finalValues = outputs.map((o) => o - outputFee);
    if (finalValues.some((value) => value < MIN_OUTPUT)) continue;
    if (numInputs + finalValues.length > MAX_COMPONENTS) continue;

    const excessFee = sumIn - inputFees - reducedAvail;
    const totalFee =
      inputFees + finalValues.length * outputFee + excessFee;
    if (!Number.isSafeInteger(totalFee) || totalFee > MAX_FEE) continue;
    result.set(scale, { values: finalValues, excessFee, inputFees });
  }

  return result;
}

// ── Shared runner ─────────────────────────────────────────────────────────
export interface ServerRunnerConfig {
  walletId: number;
  network: Network;
  host: string;
  port: number;
  useSsl: boolean;
  tor: { host: string; port: number } | null;
  /** Tests may pin a snapshot; production callers omit this so every attempt
   * performs a fresh handshake while holding the wallet-wide round lease. */
  expectedHello?: ServerHelloSnapshot;
  onServerHello?: (hello: ServerHelloSnapshot) => void;
  inputLookupEndpoint?: FusionElectrumEndpoint;
  relayEndpoints?: FusionRelayEndpoints;
  /** Injected for deterministic tests; defaults to crypto.getRandomValues. */
  _testRng?: () => number;
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

/**
 * Build a `runServer` function matching the FusionRunnerService runner
 * signature: `(coins, signal?) => Promise<{txid, warning?}>`.
 *
 * Both manual and auto callers use the same builder. The runner:
 *  - validates the snapshot against EC limits
 *  - allocates all feasible tiers and pre-generates the max output script pool
 *  - passes the snapshot to fusion_run for live match before JoinPools
 *  - persists the assembled transaction before any relay attempt
 *  - relays and independently observes the exact transaction over Tor
 *  - invokes fusion_cancel_round on AbortSignal
 */
export function buildServerRunner(
  config: ServerRunnerConfig
): (coins: UTXO[], signal?: AbortSignal) => Promise<{ txid: string; warning?: string }> {
  // Validate up front — no keys are derived if the hello is bad
  if (config.expectedHello) validateServerHello(config.expectedHello);

  return async (coins, signal) => {
    if (signal?.aborted) throw new Error('fusion round cancelled');

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
    validateServerHello(expectedHello);
    config.onServerHello?.(expectedHello);
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

      const sumIn = inputs.reduce((sum, input) => sum + input.value, 0);
      const inputPubkeys = inputs.map((input) => {
        if (!/^(02|03)[0-9a-f]{64}$/i.test(input.pubkey)) {
          throw new Error('Fusion input has an invalid compressed public key.');
        }
        return Uint8Array.from(
          input.pubkey.match(/../g)!.map((byte) => parseInt(byte, 16))
        );
      });

      const rng =
        config._testRng ??
        (() =>
          crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000);
      const plans = allocateAllFeasibleTiers(
        expectedHello,
        sumIn,
        inputPubkeys,
        rng
      );
      if (plans.size === 0) {
        throw new Error('Selected inputs cannot afford any fusion tier.');
      }

      let maxOutputCount = 0;
      for (const [, plan] of plans) {
        maxOutputCount = Math.max(maxOutputCount, plan.values.length);
      }

      const allScripts = await createFreshFusionOutputScripts(
        config.walletId,
        config.network,
        maxOutputCount
      );
      if (signal?.aborted) throw new Error('fusion round cancelled');

      const tierPlans = [...plans.entries()].map(([tier, plan]) => ({
        tier,
        outputValues: plan.values,
        excessFee: plan.excessFee,
      }));
      // From this point an interrupted native invocation may already have
      // disclosed signatures. Keep the temporary lock unless a definitive
      // failure is returned or the durable outbound tracker takes over.
      retainTemporaryReservation = true;
      const lookupEndpoint =
        config.inputLookupEndpoint ??
        defaultInputLookupEndpoint(config.network);
      const outcome = await invoke<FusionOutcome>('fusion_run', {
        roundId,
        host: config.host,
        port: config.port,
        useSsl: config.useSsl,
        tierPlans,
        inputs,
        outputScripts: allScripts,
        lookupHost: lookupEndpoint.host,
        lookupPort: lookupEndpoint.port,
        lookupUseSsl: lookupEndpoint.useSsl,
        torHost: config.tor?.host ?? null,
        torPort: config.tor?.port ?? null,
        expectedHello,
      });
      runSettled = true;

      // The round engine assembles and validates the fully signed transaction.
      // Network acceptance is verified separately through two independent BCH
      // peers so neither the Fusion server nor an ordinary wallet backend is
      // trusted as the completion signal.
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

      const relayEndpoints =
        config.relayEndpoints ?? defaultRelayEndpoints(config.network);
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
      if (
        !observation.relaySubmitted ||
        !observation.observerSeen ||
        observation.txid.toLowerCase() !== outcome.txid.toLowerCase()
      ) {
        throw new Error(
          'The Fusion transaction was not independently observed after relay.'
        );
      }

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

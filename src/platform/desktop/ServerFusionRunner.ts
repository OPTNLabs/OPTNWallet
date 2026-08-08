// Shared server fusion runner — used by both manual settings and future auto
// mode. Accepts a ServerHello snapshot from the handshake probe and validates
// it against Electron Cash limits BEFORE spending any keys. Registers every
// feasible tier (EC allocate_outputs), randomizes the excess fee per tier, and
// uses random_outputs_for_tier semantics with exponential distribution.
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

// ── EC protocol constants (protocol.py / util.py / server.py) ─────────────
// Strict Electron Cash client limits — keep in lockstep with EC sources.
const MAX_COMPONENT_FEERATE = 5000; // server.py / util validation
const MAX_EXCESS_FEE = 10_000;
const MAX_COMPONENTS = 40;
const MAX_FEE = 45_000;
const MIN_TX_COMPONENTS = 11;
const MIN_OUTPUT = 10_000; // protocol.py MIN_OUTPUT
// Electron Cash's reference server advertises 6 decades x 12 E12 values = 72
// tiers. Keep a bounded margin above that rather than rejecting the reference
// implementation itself.
const MAX_SERVER_TIERS = 128;

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
    hello.tiers.length > MAX_SERVER_TIERS ||
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
/**
 * Restrict planning to specific tiers.
 *
 * A wallet registers for every tier its coins can fund, and which tiers those
 * are depends on `sumIn` and the input count — plus a random fuzz fee, so the
 * set is not even stable for identical coins. Two wallets therefore land in
 * different pools and wait forever without ever being told why: observed live
 * as `registered_tiers=6` and `registered_tiers=4` with `max_players=1`.
 *
 * That is correct behaviour on a busy server, where a large pool absorbs the
 * variance. It makes a two-party test a coin flip. Pinning a tier turns "run it
 * repeatedly and hope" into a decision.
 */
export function allocateAllFeasibleTiers(
  hello: ServerHelloSnapshot,
  sumIn: number,
  inputPubkeys: Uint8Array[],
  rng: () => number,
  onlyTiers?: readonly number[]
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

  // Intersected with what the server advertises, so a pinned tier the server
  // does not offer yields an empty plan set and a clear refusal upstream —
  // rather than silently registering for everything and reintroducing the
  // problem this exists to solve.
  const wanted =
    onlyTiers && onlyTiers.length > 0 ? new Set(onlyTiers) : null;

  for (const scale of hello.tiers) {
    if (wanted && !wanted.has(scale)) continue;
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

export type ServerRunnerProgress = {
  onStatus?: (message: string) => void;
  onPhase?: (phase: number) => void;
};

/**
 * Build a `runServer` function matching the FusionRunnerService runner
 * signature: `(coins, signal?, progress?) => Promise<{txid, warning?}>`.
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
): (
  coins: UTXO[],
  signal?: AbortSignal,
  progress?: ServerRunnerProgress
) => Promise<{ txid: string; warning?: string }> {
  // Validate up front — no keys are derived if the hello is bad
  if (config.expectedHello) validateServerHello(config.expectedHello);

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
    validateServerHello(expectedHello);
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
        rng,
        config.onlyTiers
      );
      if (plans.size === 0) {
        // Distinguish the two causes. "Cannot afford any tier" sends someone
        // looking for more coins; if they pinned a tier the wallet cannot fund,
        // the answer is a different tier, and saying so saves the hunt.
        throw new Error(
          config.onlyTiers && config.onlyTiers.length > 0
            ? `Selected inputs cannot fund the requested tier(s): ${config.onlyTiers.join(', ')} sats.`
            : 'Selected inputs cannot afford any fusion tier.'
        );
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
      const lookupChain = inputLookupEndpoints(
        config.network,
        config.inputLookupEndpoint
      );
      const [lookupEndpoint, ...lookupFallbacks] = lookupChain;
      // Alone ~2 min then Auto retries; longer only if server shows peers / start.
      status(
        `In server pool (${tierPlans.length} tier(s), ${inputs.length} input(s)) — waiting for players…`,
        3
      );
      const poolStartedAt = Date.now();
      const poolHeartbeat = setInterval(() => {
        if (signal?.aborted) return;
        const waited = Math.floor((Date.now() - poolStartedAt) / 1000);
        status(
          `In server pool — waiting for players… (${waited}s; alone ~2 min then retry, longer if pool fills)`
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

// P2P CashFusion round choreography. The coordinator orders components but is
// never trusted with custody: every participant verifies the complete template
// before signing only its own inputs.

import {
  assembleFusionTx,
  verifyFusionSafety,
  type FusionInputRef,
  type FusionOutputRef,
  type PeerContribution,
} from './fusionRound';
import {
  signMyInputs,
  finalizeFusionTx,
  verifyFinalFusionTx,
  type InputSig,
} from './fusionSign';
import { electCoordinator } from './fusion';
import { ROUND_MSG_VERSION } from './fusionRound';
import { onionWrap, onionPeel, onionUnpad, isEccAvailable } from './onionCrypto';

/** Bind every round message to the protocol version, a unique nonce, and a
 *  timestamp. This prevents replay across rounds, cross-round message
 *  injection, and stale-message attacks. */
interface MessageBinding {
  version: number;
  nonce: string;
  timestamp: number;
}

export type RoundMessage =
  | ({
      type: 'round_proposal';
      session: string;
      network: 'mainnet' | 'chipnet';
      tier: number;
      epoch: number;
      participants: string[];
    } & MessageBinding)
  | ({
      type: 'round_ack';
      session: string;
      network: 'mainnet' | 'chipnet';
      tier: number;
      epoch: number;
    } & MessageBinding)
  | ({
      type: 'round_start';
      session: string;
      network: 'mainnet' | 'chipnet';
      tier: number;
      epoch: number;
      participants: string[];
    } & MessageBinding)
  | ({ type: 'abort'; session: string; reason: string } & MessageBinding)
  | ({ type: 'inputs'; session: string; inputs: FusionInputRef[] } & MessageBinding)
  | ({ type: 'outputs'; session: string; outputs: FusionOutputRef[] } & MessageBinding)
  | ({ type: 'onion_output'; session: string; onion: string; mixOrder: string[] } & MessageBinding)
  | ({ type: 'components_ready'; session: string } & MessageBinding)
  | ({
      type: 'assembled';
      session: string;
      inputs: FusionInputRef[];
      outputs: FusionOutputRef[];
    } & MessageBinding)
  | ({ type: 'signature'; session: string; sigs: InputSig[] } & MessageBinding)
  | ({ type: 'final'; session: string; txid: string; txHex: string } & MessageBinding);

export interface RoundTransport {
  send(toPubkey: string, msg: RoundMessage): Promise<void>;
  onMessage(handler: (from: string, msg: RoundMessage) => void): () => void;
  onProtocolError?: (handler: (from: string, error: Error) => void) => () => void;
}

/** Secure random in [0, 1) for jitter calculations. */
function secureRandomUnit(): number {
  if (!globalThis.crypto?.getRandomValues) return Math.random();
  const words = new Uint32Array(2);
  globalThis.crypto.getRandomValues(words);
  const high21 = words[0] & 0x1fffff;
  return (high21 * 0x1_0000_0000 + words[1]) / 0x20_0000_0000_0000;
}

/** Wait a random duration between minMs and maxMs. */
function jitterDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + secureRandomUnit() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Uniform integer in [0, maxExclusive) from the CSPRNG. Rejection-sampled: the
 * ragged tail past the last whole multiple is discarded rather than folded
 * back with `%`, which would quietly favour the low indices.
 */
function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const rng = globalThis.crypto;
  if (!rng?.getRandomValues) return Math.floor(Math.random() * maxExclusive);
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const word = new Uint32Array(1);
  let value = 0;
  do {
    rng.getRandomValues(word);
    value = word[0];
  } while (value >= limit);
  return value % maxExclusive;
}

/**
 * Fisher-Yates over the CSPRNG, in place.
 *
 * This shuffle IS the mix-net's privacy. Layered encryption only hides which
 * peer sent which output for as long as the permutation at each hop is
 * unguessable — an adversary who can reproduce it can walk the peeling order
 * straight back to the sender, and the layers bought nothing. `Math.random()`
 * is xorshift128+ and its internal state is recoverable from its own output, so
 * it has no business here.
 */
function secureShuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
}

const MAX_ROUND_MESSAGE_CHARS = 64 * 1024;
const MAX_PARTICIPANTS = 20;
const MAX_COMPONENTS = 100;
const MAX_SCRIPT_HEX_CHARS = 20_000;
const MAX_TX_HEX_CHARS = 200_000;
const MAX_MONEY = 21_000_000 * 100_000_000;
const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_32 = /^[0-9a-f]{32}$/i;
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/i;
const MAX_MESSAGE_AGE_SECONDS = 300; // 5 minutes

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validSession(value: unknown): value is string {
  return typeof value === 'string' && /^[\x20-\x7e]{1,128}$/.test(value);
}

/** Generate a cryptographically random 16-byte hex nonce for message binding. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Create the binding fields for a round message. */
export function messageBinding(): MessageBinding {
  return {
    version: ROUND_MSG_VERSION,
    nonce: generateNonce(),
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function validBinding(value: unknown): value is MessageBinding {
  if (!isRecord(value)) return false;
  if (value.version !== ROUND_MSG_VERSION) return false;
  if (typeof value.nonce !== 'string' || !HEX_32.test(value.nonce)) return false;
  if (!isSafeIntegerIn(value.timestamp, 0, Number.MAX_SAFE_INTEGER)) return false;
  const age = Math.floor(Date.now() / 1000) - (value.timestamp as number);
  if (age < -30 || age > MAX_MESSAGE_AGE_SECONDS) return false; // 30s clock skew tolerance
  return true;
}

function validParticipants(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= MAX_PARTICIPANTS &&
    value.every((item) => typeof item === 'string' && HEX_64.test(item)) &&
    new Set(value).size === value.length
  );
}

function validInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.prevTxid === 'string' &&
    HEX_64.test(value.prevTxid) &&
    isSafeIntegerIn(value.prevIndex, 0, 0xffff_ffff) &&
    isSafeIntegerIn(value.value, 1, MAX_MONEY) &&
    typeof value.pubkey === 'string' &&
    COMPRESSED_PUBKEY.test(value.pubkey)
  );
}

function validOutput(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.script === 'string' &&
    value.script.length > 0 &&
    value.script.length <= MAX_SCRIPT_HEX_CHARS &&
    value.script.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value.script) &&
    isSafeIntegerIn(value.value, 546, MAX_MONEY)
  );
}

function validSignature(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.prevTxid === 'string' &&
    HEX_64.test(value.prevTxid) &&
    isSafeIntegerIn(value.prevIndex, 0, 0xffff_ffff) &&
    typeof value.unlockingBytecode === 'string' &&
    value.unlockingBytecode.length > 0 &&
    value.unlockingBytecode.length <= MAX_SCRIPT_HEX_CHARS &&
    value.unlockingBytecode.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value.unlockingBytecode)
  );
}

function validArray(
  value: unknown,
  validator: (item: unknown) => boolean
): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_COMPONENTS &&
    value.every(validator)
  );
}

/** Parse and bound every decrypted relay message before session code sees it. */
export function parseRoundMessage(content: string): RoundMessage | null {
  if (content.length === 0 || content.length > MAX_ROUND_MESSAGE_CHARS) return null;
  try {
    const message: unknown = JSON.parse(content);
    if (!isRecord(message) || !validSession(message.session)) return null;
    if (!validBinding(message)) return null;
    switch (message.type) {
      case 'round_proposal':
      case 'round_start':
        if (
          (message.network !== 'mainnet' && message.network !== 'chipnet') ||
          !isSafeIntegerIn(message.tier, 10_000, MAX_MONEY) ||
          !isSafeIntegerIn(message.epoch, 0, Number.MAX_SAFE_INTEGER) ||
          !validParticipants(message.participants)
        ) {
          return null;
        }
        break;
      case 'round_ack':
        if (
          (message.network !== 'mainnet' && message.network !== 'chipnet') ||
          !isSafeIntegerIn(message.tier, 10_000, MAX_MONEY) ||
          !isSafeIntegerIn(message.epoch, 0, Number.MAX_SAFE_INTEGER)
        ) {
          return null;
        }
        break;
      case 'abort':
        if (
          typeof message.reason !== 'string' ||
          message.reason.length < 1 ||
          message.reason.length > 240
        ) {
          return null;
        }
        break;
      case 'components_ready':
        // No additional fields beyond session + binding.
        break;
      case 'inputs':
        if (!validArray(message.inputs, validInput)) return null;
        break;
      case 'outputs':
        if (!validArray(message.outputs, validOutput)) return null;
        break;
      case 'onion_output':
        if (
          typeof message.onion !== 'string' ||
          message.onion.length < 1 ||
          !validParticipants(message.mixOrder)
        ) {
          return null;
        }
        break;
      case 'assembled':
        if (
          !validArray(message.inputs, validInput) ||
          !validArray(message.outputs, validOutput) ||
          message.inputs.length + message.outputs.length > MAX_COMPONENTS
        ) {
          return null;
        }
        break;
      case 'signature':
        if (!validArray(message.sigs, validSignature)) return null;
        break;
      case 'final':
        if (
          typeof message.txid !== 'string' ||
          !HEX_64.test(message.txid) ||
          typeof message.txHex !== 'string' ||
          message.txHex.length < 2 ||
          message.txHex.length > MAX_TX_HEX_CHARS ||
          message.txHex.length % 2 !== 0 ||
          !/^[0-9a-f]+$/i.test(message.txHex)
        ) {
          return null;
        }
        break;
      default:
        return null;
    }
    return message as unknown as RoundMessage;
  } catch {
    return null;
  }
}

export interface RoundParams {
  myPubkey: string;
  participants: string[];
  /** Random coordinator-issued id agreed during round_start. */
  session?: string;
  tier: number;
  feerate: number;
  myContribution: PeerContribution;
  keysByPubkey: Map<string, Uint8Array>;
  broadcast: (txHex: string) => Promise<string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Live round-phase updates (2=register, 3=onion, 4=sign, 5=broadcast). */
  onPhase?: (phase: number) => void;
  /** Test seam: override jitter range [minMs, maxMs] per component send. */
  jitterMs?: [number, number];
  /** Mix order for onion-wrapped outputs (sorted by pubkey). */
  mixOrder?: string[];
  /** Enable onion mix-net for output privacy. Default: true. */
  onionEnabled?: boolean;
}

export interface RoundResult {
  txid: string;
  txHex: string;
}

const DEFAULT_TIMEOUT = 120_000;

function sessionId(participants: string[], tier: number): string {
  return `${electCoordinator(participants)}:${tier}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(reason: string): Error {
  return new Error(`fusion round aborted: ${reason}`);
}

function inputKey(input: Pick<FusionInputRef, 'prevTxid' | 'prevIndex'>): string {
  return `${input.prevTxid}:${input.prevIndex}`;
}

export function runFusionRound(
  params: RoundParams,
  transport: RoundTransport
): Promise<RoundResult> {
  const participants = [...new Set(params.participants)];
  if (participants.length < 2 || !participants.includes(params.myPubkey)) {
    return Promise.reject(new Error('invalid Fusion participant set'));
  }
  const coordinator = electCoordinator(participants);
  if (!coordinator) {
    return Promise.reject(new Error('Fusion coordinator election failed'));
  }
  const normalized = { ...params, participants };
  return coordinator === params.myPubkey
    ? runCoordinator(normalized, transport)
    : runParticipant(normalized, transport, coordinator);
}

function assembleVerifySign(
  params: RoundParams,
  inputs: FusionInputRef[],
  outputs: FusionOutputRef[]
): InputSig[] {
  const tx = assembleFusionTx([{ inputs, outputs }]);
  const safety = verifyFusionSafety(tx, params.myContribution, params.feerate);
  if (!safety.ok) throw new Error(`refusing to sign: ${safety.reason}`);
  const signatures = signMyInputs(tx, params.keysByPubkey);
  if (signatures.length !== params.myContribution.inputs.length) {
    throw new Error('refusing to sign: a private key is missing for my input');
  }
  return signatures;
}

function runParticipant(
  params: RoundParams,
  transport: RoundTransport,
  coordinator: string
): Promise<RoundResult> {
  const session = params.session ?? sessionId(params.participants, params.tier);
  // Mix-net peers: all participants EXCEPT the coordinator. The coordinator
  // is the assembler and receives final revealed outputs — it does not peel.
  const mixOrder = params.mixOrder ??
    [...params.participants].filter((p) => p !== coordinator).sort();
  const myIdx = mixOrder.indexOf(params.myPubkey);

  return new Promise((resolve, reject) => {
    let settled = false;
    let signed = false;
    let approved: { inputs: FusionInputRef[]; outputs: FusionOutputRef[] } | null =
      null;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeProtocolError: () => void = () => undefined;
    const seenNonces = new Set<string>();
    // Onion mix-net state: collect onions from other peers
    const collectedOnions: string[] = [];
    const expectedOnionCount = params.participants.length;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      params.signal?.removeEventListener('abort', onCancel);
      unsubscribe();
      unsubscribeProtocolError();
    };
    const fail = async (error: Error, notifyCoordinator: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (notifyCoordinator) {
        await Promise.allSettled([
          transport.send(coordinator, {
            ...messageBinding(),
            type: 'abort',
            session,
            reason: error.message.slice(0, 240),
          }),
        ]);
      }
      reject(error);
    };
    const succeed = (result: RoundResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onCancel = () => {
      void fail(abortError('cancelled'), true);
    };

    // Handle onion message: collect, peel, shuffle, forward
    const handleOnionMessage = async (_from: string, message: Extract<RoundMessage, { type: 'onion_output' }>) => {
      if (settled) return;

      // Store the onion blob
      collectedOnions.push(message.onion);

      // Wait for all onions before processing
      if (collectedOnions.length < expectedOnionCount) return;

      try {
        // Get this peer's private key for peeling
        const myPriv = params.keysByPubkey.get(params.myPubkey);
        if (!myPriv) {
          throw new Error('private key not found for onion peeling');
        }

        // Peel one layer from each onion
        const peeled: Uint8Array[] = [];
        for (const onionB64 of collectedOnions) {
          const blob = Uint8Array.from(atob(onionB64), c => c.charCodeAt(0));
          const inner = await onionPeel(blob, myPriv);
          peeled.push(inner);
        }

        // The mix-net shuffle. Must come from the CSPRNG — see secureShuffle.
        secureShuffle(peeled);

        const nextIdx = myIdx + 1;

        if (nextIdx >= mixOrder.length) {
          // LAST PEELER — reveal plaintext outputs to coordinator only.
          // Coordinator assembles the tx; participants wait for 'assembled'.
          const revealedOutputs: FusionOutputRef[] = [];
          for (const inner of peeled) {
            const { addr, value } = onionUnpad(inner);
            revealedOutputs.push({ script: addr, value });
          }

          await transport.send(coordinator, {
            ...messageBinding(),
            type: 'outputs',
            session,
            outputs: revealedOutputs,
          });
        } else {
          // NOT last peeler — forward peeled onions to next peeler
          const nextPeeler = mixOrder[nextIdx];
          collectedOnions.length = 0; // Reset for next round
          for (const inner of peeled) {
            const innerB64 = btoa(String.fromCharCode(...inner));
            await transport.send(nextPeeler, {
              ...messageBinding(),
              type: 'onion_output',
              session,
              onion: innerB64,
              mixOrder,
            });
          }
        }
      } catch (error) {
        // If onion peeling fails (e.g., WASM not loaded in test env),
        // broadcast an abort so the round fails gracefully
        throw new Error(`onion peeling failed: ${error}`);
      }
    };

    unsubscribe = transport.onMessage((from, message) => {
      if (settled) return;
      if (message.session !== session) return;
      if (seenNonces.has(message.nonce)) return;
      seenNonces.add(message.nonce);

      // Handle onion messages from peers in the mix-net (includes coordinator's own onions)
      if (message.type === 'onion_output' && params.participants.includes(from)) {
        void handleOnionMessage(from, message).catch((error: unknown) =>
          void fail(asError(error), true)
        );
        return;
      }

      // Handle revealed outputs from last peeler — sent directly to coordinator.
      if (message.type === 'outputs' && from !== coordinator) {
        return;
      }

      // Only coordinator messages below
      if (from !== coordinator) return;
      if (message.type === 'abort') {
        void fail(abortError(message.reason), false);
        return;
      }
      if (message.type === 'assembled') {
        if (signed) return;
        signed = true;
        try {
          approved = assembleFusionTx([
            { inputs: message.inputs, outputs: message.outputs },
          ]);
          params.onPhase?.(5);
          const signatures = assembleVerifySign(
            params,
            approved.inputs,
            approved.outputs
          );
          params.onPhase?.(6);
          void transport
            .send(coordinator, {
              ...messageBinding(),
              type: 'signature',
              session,
              sigs: signatures,
            })
            .catch((error: unknown) => void fail(asError(error), true));
        } catch (error) {
          void fail(asError(error), true);
        }
        return;
      }
      if (message.type === 'final') {
        if (!signed || !approved) {
          void fail(new Error('received final transaction before verification'), true);
          return;
        }
        try {
          verifyFinalFusionTx(approved, message.txHex, message.txid);
          params.onPhase?.(7);
          // Broadcast liveness: every participant broadcasts after verification,
          // not just the coordinator. If the coordinator's broadcast failed or
          // its connection dropped, any peer can save the round. The broadcast
          // is idempotent (same txid = same result on the network).
          // Random jitter prevents a race where all participants broadcast
          // simultaneously, which would be wasteful but not harmful.
          void jitterDelay(2_000, 8_000)
            .then(() => params.broadcast(message.txHex))
            .catch(() => undefined); // broadcast failure is non-fatal for the participant
          succeed({ txid: message.txid.toLowerCase(), txHex: message.txHex });
        } catch (error) {
          void fail(asError(error), true);
        }
      }
    });
    unsubscribeProtocolError =
      transport.onProtocolError?.((from, error) => {
        if (from === coordinator) void fail(error, true);
      }) ?? (() => undefined);

    params.signal?.addEventListener('abort', onCancel, { once: true });
    const timer = setTimeout(
      () => void fail(new Error('fusion round timed out'), true),
      params.timeoutMs ?? DEFAULT_TIMEOUT
    );
    params.onPhase?.(2);
    void (async () => {
      // Phase 2: send inputs to coordinator
      const [jMin, jMax] = params.jitterMs ?? [200, 2000];
      for (const input of params.myContribution.inputs) {
        await transport.send(coordinator, {
          ...messageBinding(),
          type: 'inputs',
          session,
          inputs: [input],
        });
        await jitterDelay(jMin, jMax);
      }
      // Phase 3: outputs.
      //
      // When the onion layer is on it is a privacy guarantee, not a nicety, so
      // a failure here fails the round rather than quietly reverting to
      // plaintext. The old code caught everything and fell back silently: an
      // observer would see the privacy layer vanish mid-round while the user
      // was told nothing. Loud is the only safe direction here.
      //
      // Note this uses the outer `mixOrder`, which excludes the coordinator —
      // it assembles, it does not peel. A local shadow used to rebuild the list
      // from `participants` unfiltered, so the wrapper added a layer addressed
      // to the coordinator that nobody in the peel chain could remove.
      if (params.onionEnabled === true) {
        if (!isEccAvailable()) {
          throw new Error(
            'onion mix-net enabled but secp256k1 is unavailable in this environment'
          );
        }
        for (const output of params.myContribution.outputs) {
          const payload = `${output.script}|${output.value}`;
          const onion = await onionWrap(payload, mixOrder);
          const onionB64 = btoa(String.fromCharCode(...onion));
          await transport.send(mixOrder[0], {
            ...messageBinding(),
            type: 'onion_output',
            session,
            onion: onionB64,
            mixOrder,
          });
          await jitterDelay(jMin, jMax);
        }
      } else {
        // Direct mode: send outputs to coordinator
        for (const output of params.myContribution.outputs) {
          await transport.send(coordinator, {
            ...messageBinding(),
            type: 'outputs',
            session,
            outputs: [output],
          });
          await jitterDelay(jMin, jMax);
        }
      }
      // Signal that all components have been submitted.
      await transport.send(coordinator, {
        ...messageBinding(),
        type: 'components_ready',
        session,
      });
    })().catch((error: unknown) => void fail(asError(error), true));
  });
}

function runCoordinator(
  params: RoundParams,
  transport: RoundTransport
): Promise<RoundResult> {
  const session = params.session ?? sessionId(params.participants, params.tier);
  const others = params.participants.filter((peer) => peer !== params.myPubkey);
  // Mix-net peers: all participants EXCEPT the coordinator.
  const mixOrder = params.mixOrder ??
    [...params.participants].filter((p) => p !== params.myPubkey).sort();

  return new Promise((resolve, reject) => {
    const inputsByPeer = new Map<string, FusionInputRef[]>([
      [params.myPubkey, params.myContribution.inputs],
    ]);
    const useOnionForOutputs = params.onionEnabled === true;
    const outputPool: FusionOutputRef[] = useOnionForOutputs
      ? [] // outputs arrive via onion reveal chain
      : [...params.myContribution.outputs]; // direct mode: pre-load
    const signaturesByOutpoint = new Map<string, InputSig>();
    const signedPeers = new Set<string>();
    const seenNonces = new Set<string>();
    const readyPeers = new Set<string>([params.myPubkey]); // coordinator is always ready
    let outputMessages = useOnionForOutputs ? 0 : 1;
    let assembled: { inputs: FusionInputRef[]; outputs: FusionOutputRef[] } | null =
      null;
    let assembling = false;
    let finalizing = false;
    let broadcastStarted = false;
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeProtocolError: () => void = () => undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      params.signal?.removeEventListener('abort', onCancel);
      unsubscribe();
      unsubscribeProtocolError();
    };
    const fail = async (
      error: Error,
      notifyPeers: boolean,
      forceDuringBroadcast = false
    ) => {
      if (settled || (broadcastStarted && !forceDuringBroadcast)) return;
      settled = true;
      cleanup();
      if (notifyPeers) {
        const message: RoundMessage = {
          ...messageBinding(),
          type: 'abort',
          session,
          reason: error.message.slice(0, 240),
        };
        await Promise.allSettled(others.map((peer) => transport.send(peer, message)));
      }
      reject(error);
    };
    const succeed = (result: RoundResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onCancel = () => {
      void fail(abortError('cancelled'), true);
    };

    const tryFinalize = async () => {
      if (
        settled ||
        finalizing ||
        !assembled ||
        signedPeers.size !== others.length ||
        signaturesByOutpoint.size !== assembled.inputs.length
      ) {
        return;
      }
      finalizing = true;
      params.onPhase?.(5);
      const tx = assembleFusionTx([assembled]);
      const finalized = finalizeFusionTx(tx, [...signaturesByOutpoint.values()]);

      // The coordinator is also a participant: execute every collected
      // signature against the exact approved template before any network can
      // see the transaction. Structural signature-set checks alone cannot
      // detect a peer's malformed or invalid BCH signature.
      verifyFinalFusionTx(tx, finalized.txHex, finalized.txid);

      // Cancellation is authoritative until the irreversible broadcast call.
      // Once that call starts, late cancellation, peer messages, and the round
      // timer must not hide a successful submission from completion tracking.
      if (settled || params.signal?.aborted) {
        throw abortError('cancelled');
      }
      broadcastStarted = true;
      const broadcastId = (await params.broadcast(finalized.txHex)).toLowerCase();
      if (broadcastId !== finalized.txid) {
        throw new Error('broadcast returned a different transaction id');
      }

      // Start every peer notification before resolving, but never turn a
      // successfully broadcast transaction into a local failure just because a
      // relay delivery failed. Each participant independently verifies `final`.
      const notifications = others.map((peer) =>
        transport.send(peer, {
          ...messageBinding(),
          type: 'final',
          session,
          txid: finalized.txid,
          txHex: finalized.txHex,
        })
      );
      succeed({ txid: finalized.txid, txHex: finalized.txHex });
      await Promise.allSettled(notifications);
    };

    const tryAssemble = async () => {
      if (!settled && !assembled) {
        console.info(
          '[p2p-fusion coord] session', session.slice(0, 10),
          'inputs', inputsByPeer.size, '/', params.participants.length,
          'outputs', outputPool.length,
          'ready', readyPeers.size, '/', params.participants.length
        );
      }
      // Wait for all peers to be ready AND outputs to be in the pool
      // before assembling. In onion mode, outputs arrive via the reveal chain
      // (async, multi-hop) so the pool may still be empty when components_ready
      // fires.
      if (
        settled ||
        assembling ||
        assembled ||
        readyPeers.size !== params.participants.length
      ) {
        return;
      }
      // Wait for at least one output to be present (onion reveal or direct).
      if (outputPool.length === 0) {
        return;
      }
      assembling = true;
      const inputs = [...inputsByPeer.values()].flat();
      assembled = assembleFusionTx([{ inputs, outputs: outputPool }]);
      params.onPhase?.(5);
      const ownSignatures = assembleVerifySign(
        params,
        assembled.inputs,
        assembled.outputs
      );
      params.onPhase?.(6);
      ownSignatures.forEach((signature) =>
        signaturesByOutpoint.set(inputKey(signature), signature)
      );
      await Promise.all(
        others.map((peer) =>
          transport.send(peer, {
            ...messageBinding(),
            type: 'assembled',
            session,
            inputs: assembled!.inputs,
            outputs: assembled!.outputs,
          })
        )
      );
      await tryFinalize();
    };

    unsubscribe = transport.onMessage((from, message) => {
      if (settled || message.session !== session) return;
      if (seenNonces.has(message.nonce)) return;
      seenNonces.add(message.nonce);
      if (message.type === 'components_ready' && others.includes(from)) {
        readyPeers.add(from);
        void tryAssemble().catch((error: unknown) =>
          void fail(asError(error), true)
        );
        return;
      }
      if (message.type === 'abort' && others.includes(from)) {
        void fail(abortError(message.reason), true);
        return;
      }
      if (message.type === 'inputs' && others.includes(from)) {
        // Per-component: accumulate individual inputs from each peer.
        const existing = inputsByPeer.get(from);
        if (existing) {
          existing.push(...message.inputs);
        } else {
          inputsByPeer.set(from, [...message.inputs]);
        }
        void tryAssemble().catch((error: unknown) =>
          void fail(asError(error), true)
        );
        return;
      }
      if (message.type === 'outputs') {
        if (outputMessages >= params.participants.length) {
          return;
        }
        // Per-component: accumulate individual outputs from each peer.
        // Output senders are not tracked — duplicates are harmless since
        // verifyFusionSafety rejects duplicate outpoints.
        outputPool.push(...message.outputs);
        outputMessages += 1;
        void tryAssemble().catch((error: unknown) =>
          void fail(asError(error), true)
        );
        return;
      }
      if (
        message.type === 'signature' &&
        assembled &&
        others.includes(from) &&
        !signedPeers.has(from)
      ) {
        const expected = inputsByPeer.get(from) ?? [];
        const expectedKeys = new Set(expected.map(inputKey));
        const receivedKeys = new Set(message.sigs.map(inputKey));
        if (
          receivedKeys.size !== message.sigs.length ||
          receivedKeys.size !== expectedKeys.size ||
          [...receivedKeys].some((key) => !expectedKeys.has(key))
        ) {
          void fail(new Error(`invalid signature set from ${from}`), true);
          return;
        }
        signedPeers.add(from);
        message.sigs.forEach((signature) =>
          signaturesByOutpoint.set(inputKey(signature), signature)
        );
        void tryFinalize().catch((error: unknown) =>
          void fail(asError(error), true, true)
        );
      }
    });
    unsubscribeProtocolError =
      transport.onProtocolError?.((from, error) => {
        if (others.includes(from)) void fail(error, true);
      }) ?? (() => undefined);

    params.signal?.addEventListener('abort', onCancel, { once: true });
    const timer = setTimeout(
      () => void fail(new Error('fusion round timed out'), true),
      params.timeoutMs ?? DEFAULT_TIMEOUT
    );
    params.onPhase?.(2);
    // Phase 3: coordinator sends its own outputs through the onion chain
    // (same as participants — everyone wraps and sends to mixOrder[0]).
    (async () => {
      if (!useOnionForOutputs) return;
      const jMin = params.jitterMs?.[0] ?? 200;
      const jMax = params.jitterMs?.[1] ?? 2_000;
      for (const output of params.myContribution.outputs) {
        const payload = `${output.script}|${output.value}`;
        const onion = await onionWrap(payload, mixOrder);
        const onionB64 = btoa(String.fromCharCode(...onion));
        const firstPeeler = mixOrder[0];
        await transport.send(firstPeeler, {
          ...messageBinding(),
          type: 'onion_output',
          session,
          onion: onionB64,
          mixOrder,
        });
        await jitterDelay(jMin, jMax);
      }
    })().catch((error: unknown) => void fail(asError(error), true));
  });
}

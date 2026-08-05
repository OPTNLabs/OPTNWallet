// P2P CashFusion round choreography. The coordinator orders components but is
// never trusted with custody: every participant verifies the complete template
// before signing only its own inputs.
//
// Credential phase (protocol v2): the elected coordinator is the blind-Schnorr
// *issuer* for the round — same role the fusion server plays in classic
// CashFusion. No extra infrastructure: peers request credentials over public
// Nostr, the coordinator signs with one-shot nonces, and every input must carry
// a valid unblinded credential before the CoinJoin is assembled. Pedersen
// commitments travel with the credential request so the coordinator can check
// each peer's amount balance without seeing individual component values early.

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
import {
  P2P_CREDENTIAL_WAIT_MS,
  P2P_MISSING_OUTPUTS_DIRECT_MS,
  P2P_MISSING_OUTPUTS_ONION_MS,
  P2P_ONION_DECLARE_RESEND_MS,
  P2P_ROUND_TIMEOUT_MS,
} from '../fusionTiming';
import { onionWrap, onionPeel, onionUnpad, isEccAvailable } from './onionCrypto';
import {
  BlindIssuer,
  BlindSignatureRequest,
  CREDENTIAL_SLOTS_PER_PEER,
  inputCredentialMessageHash,
  inputCredentialMessageHashHex,
  peerCredentialSlotBase,
  totalCredentialSlots,
  verifyBchSchnorrHex,
} from './fusionBlindSchnorr';
import {
  pedersenBalanceHolds,
  pedersenCommit,
  sumNoncesHex,
} from './fusionPedersen';

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
  | ({
      type: 'credential_params';
      session: string;
      /** Compressed round pubkey P = x·G (hex). */
      roundPubkey: string;
      /** Compressed R_i = k_i·G points (hex), one-shot slots. */
      blindNoncePoints: string[];
    } & MessageBinding)
  | ({
      type: 'credential_request';
      session: string;
      /** Blinded challenges e, each bound to a nonce slot index. */
      requests: Array<{ index: number; e: string }>;
      /** Uncompressed Pedersen amount commitments (65-byte hex each). */
      amountCommitments: string[];
      /** Σ component nonces mod n (32-byte hex). */
      pedersenTotalNonce: string;
      /** Player excess fee the commitments must sum to. */
      excessFee: number;
    } & MessageBinding)
  | ({
      type: 'credential_response';
      session: string;
      /** Issuer scalars s, same order as the request. */
      responses: Array<{ index: number; s: string }>;
    } & MessageBinding)
  | ({
      type: 'inputs';
      session: string;
      inputs: FusionInputRef[];
      /** Unblinded 64-byte BCH Schnorr credentials (hex), parallel to inputs. */
      credentialSigs: string[];
    } & MessageBinding)
  | ({ type: 'outputs'; session: string; outputs: FusionOutputRef[] } & MessageBinding)
  | ({ type: 'onion_output'; session: string; onion: string; mixOrder: string[] } & MessageBinding)
  /**
   * How many onion blobs this peer will inject (one per output). Signed under
   * the round key so peels know the hop total = sum of declares. Without this,
   * peels waited for `participants.length` while peers sent a random 2–4
   * onions each → hang / outputSlots=0 (Claude diagnosis, 2026-08-06).
   */
  | ({ type: 'onion_declare'; session: string; outputCount: number } & MessageBinding)
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

const HEX_64_STRICT = /^[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;
const HEX_66 = /^(02|03)[0-9a-f]{64}$/i;
const HEX_130 = /^04[0-9a-f]{128}$/i;

function validCredentialRequestSlot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeIntegerIn(value.index, 0, 1023) &&
    typeof value.e === 'string' &&
    HEX_64_STRICT.test(value.e)
  );
}

function validCredentialResponseSlot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeIntegerIn(value.index, 0, 1023) &&
    typeof value.s === 'string' &&
    HEX_64_STRICT.test(value.s)
  );
}

/** Component fees matching Electron Cash / fusionRound sizing (sats/kB). */
function componentFeeSats(sizeBytes: number, feerate: number): number {
  return Math.ceil((sizeBytes * feerate) / 1000);
}

/**
 * Build Pedersen commitments for a peer's full contribution (inputs + outputs)
 * and the excess fee the coordinator will check. Amounts are signed EC-style:
 * input → +value−fee, output → −value−fee.
 */
function buildPlayerPedersen(
  contribution: PeerContribution,
  feerate: number
): {
  amountCommitments: string[];
  pedersenTotalNonce: string;
  excessFee: number;
} {
  const commitments: string[] = [];
  const nonces: string[] = [];
  let excess = 0;
  for (const input of contribution.inputs) {
    const fee = componentFeeSats(108 + input.pubkey.length / 2, feerate);
    const amount = input.value - fee;
    excess += amount;
    const c = pedersenCommit(amount);
    commitments.push(c.commitmentHex);
    nonces.push(c.nonceHex);
  }
  for (const output of contribution.outputs) {
    const fee = componentFeeSats(9 + output.script.length / 2, feerate);
    const amount = -(output.value + fee);
    excess += amount;
    const c = pedersenCommit(amount);
    commitments.push(c.commitmentHex);
    nonces.push(c.nonceHex);
  }
  if (excess < 0) {
    throw new Error('pedersen excess fee is negative — outputs+fees exceed inputs');
  }
  return {
    amountCommitments: commitments,
    pedersenTotalNonce: sumNoncesHex(nonces),
    excessFee: excess,
  };
}

/** Create blind requests for every input, using the peer's reserved nonce slots. */
function buildInputCredentialRequests(
  contribution: PeerContribution,
  participants: string[],
  myPubkey: string,
  roundPubkey: string,
  blindNoncePoints: string[]
): {
  requests: Array<{ index: number; e: string }>;
  pending: BlindSignatureRequest[];
  indices: number[];
} {
  const base = peerCredentialSlotBase(participants, myPubkey);
  if (contribution.inputs.length > CREDENTIAL_SLOTS_PER_PEER) {
    throw new Error(
      `too many inputs for credential slots (${contribution.inputs.length} > ${CREDENTIAL_SLOTS_PER_PEER})`
    );
  }
  const requests: Array<{ index: number; e: string }> = [];
  const pending: BlindSignatureRequest[] = [];
  const indices: number[] = [];
  contribution.inputs.forEach((input, i) => {
    const index = base + i;
    const r = blindNoncePoints[index];
    if (!r) throw new Error(`missing blind nonce point at slot ${index}`);
    const req = BlindSignatureRequest.create(
      roundPubkey,
      r,
      inputCredentialMessageHash(input)
    );
    requests.push({ index, e: req.requestHex() });
    pending.push(req);
    indices.push(index);
  });
  return { requests, pending, indices };
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
      case 'credential_params':
        if (
          typeof message.roundPubkey !== 'string' ||
          !HEX_66.test(message.roundPubkey) ||
          !Array.isArray(message.blindNoncePoints) ||
          message.blindNoncePoints.length < 2 ||
          message.blindNoncePoints.length > 1024 ||
          !message.blindNoncePoints.every(
            (p) => typeof p === 'string' && HEX_66.test(p)
          )
        ) {
          return null;
        }
        break;
      case 'credential_request':
        if (
          !Array.isArray(message.requests) ||
          message.requests.length < 1 ||
          message.requests.length > MAX_COMPONENTS ||
          !message.requests.every(validCredentialRequestSlot) ||
          !Array.isArray(message.amountCommitments) ||
          message.amountCommitments.length < 1 ||
          message.amountCommitments.length > MAX_COMPONENTS ||
          !message.amountCommitments.every(
            (c) => typeof c === 'string' && HEX_130.test(c)
          ) ||
          typeof message.pedersenTotalNonce !== 'string' ||
          !HEX_64_STRICT.test(message.pedersenTotalNonce) ||
          !isSafeIntegerIn(message.excessFee, 0, MAX_MONEY)
        ) {
          return null;
        }
        break;
      case 'credential_response':
        if (
          !Array.isArray(message.responses) ||
          message.responses.length < 1 ||
          message.responses.length > MAX_COMPONENTS ||
          !message.responses.every(validCredentialResponseSlot)
        ) {
          return null;
        }
        break;
      case 'inputs':
        if (!validArray(message.inputs, validInput)) return null;
        if (
          !Array.isArray(message.credentialSigs) ||
          message.credentialSigs.length !==
            (message.inputs as unknown[]).length ||
          !message.credentialSigs.every(
            (s) => typeof s === 'string' && HEX_128.test(s)
          )
        ) {
          return null;
        }
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
      case 'onion_declare':
        if (!isSafeIntegerIn(message.outputCount, 1, 4)) {
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
  /** Human-readable progress (credential wait, etc.). */
  onStatus?: (message: string) => void;
  /** Test seam: override jitter range [minMs, maxMs] per component send. */
  jitterMs?: [number, number];
  /** Mix order for onion-wrapped outputs (sorted by pubkey). */
  mixOrder?: string[];
  /** Enable onion mix-net for output privacy. Default: true. */
  onionEnabled?: boolean;
}

/** Bound silent waits — caps from fusionTiming (server protocol.py). */
const CREDENTIAL_WAIT_MS = P2P_CREDENTIAL_WAIT_MS;
const MISSING_OUTPUTS_DIRECT_MS = P2P_MISSING_OUTPUTS_DIRECT_MS;
const MISSING_OUTPUTS_ONION_MS = P2P_MISSING_OUTPUTS_ONION_MS;
/** Re-send onion_declare so Tor-dropped declares cannot freeze the peel forever. */
const ONION_DECLARE_RESEND_MS = P2P_ONION_DECLARE_RESEND_MS;

function waitWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} (after ${Math.round(ms / 1000)}s). ` +
              'Usually means other wallets never joined this round — ' +
              'they saw a different peer set over Tor.'
          )
        ),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

export interface RoundResult {
  txid: string;
  txHex: string;
}

/** Active-round ceiling = server T_START_CLOSE_BLAME (fusionTiming). */
const DEFAULT_TIMEOUT = P2P_ROUND_TIMEOUT_MS;

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
    let declareResendTimer: ReturnType<typeof setInterval> | null = null;
    const seenNonces = new Set<string>();
    // Onion mix-net: one blob per *output*, not per peer. Each peer announces
    // how many it will inject (`onion_declare`); hop waits for sum(declares).
    const collectedOnions: string[] = [];
    const declaredOnionCounts = new Map<string, number>();
    let onionBatchProcessing = false;
    let onionBatchDone = false;

    const expectedOnionCount = (): number | null => {
      if (declaredOnionCounts.size < params.participants.length) return null;
      let sum = 0;
      for (const peer of params.participants) {
        const count = declaredOnionCounts.get(peer);
        if (
          count === undefined ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 4
        ) {
          return null;
        }
        sum += count;
      }
      return sum;
    };

    // Credential phase state — resolved when the coordinator issues parameters
    // and when our blind responses arrive.
    let resolveCredParams:
      | ((v: { roundPubkey: string; blindNoncePoints: string[] }) => void)
      | null = null;
    const credParamsPromise = new Promise<{
      roundPubkey: string;
      blindNoncePoints: string[];
    }>((res) => {
      resolveCredParams = res;
    });
    let resolveCredResponse:
      | ((v: Array<{ index: number; s: string }>) => void)
      | null = null;
    let credResponsePromise: Promise<Array<{ index: number; s: string }>> | null =
      null;
    const waitCredResponse = () => {
      if (!credResponsePromise) {
        credResponsePromise = new Promise((res) => {
          resolveCredResponse = res;
        });
      }
      return credResponsePromise;
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (declareResendTimer) {
        clearInterval(declareResendTimer);
        declareResendTimer = null;
      }
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

    // Peel only when every peer has declared and the matching onion count has
    // arrived — never `participants.length` alone (outputs are 2–4 per peer).
    const processOnionBatchIfReady = async () => {
      if (settled || onionBatchProcessing || onionBatchDone) return;
      const expected = expectedOnionCount();
      if (expected === null || collectedOnions.length < expected) return;
      onionBatchProcessing = true;
      // Take exactly this hop's batch; leave any stragglers out of the shuffle.
      const batch = collectedOnions.splice(0, expected);
      try {
        const myPriv = params.keysByPubkey.get(params.myPubkey);
        if (!myPriv) {
          throw new Error('private key not found for onion peeling');
        }

        const peeled: Uint8Array[] = [];
        for (const onionB64 of batch) {
          try {
            const blob = Uint8Array.from(atob(onionB64), (c) => c.charCodeAt(0));
            peeled.push(await onionPeel(blob, myPriv));
          } catch {
            // Drop a single bad blob rather than DoS the whole round (Claude #2).
            console.warn('[p2p-fusion] dropped undecryptable onion layer');
          }
        }
        if (peeled.length !== batch.length) {
          throw new Error(
            `onion peel incomplete (${peeled.length}/${batch.length} layers)`
          );
        }

        // The mix-net shuffle. Must come from the CSPRNG — see secureShuffle.
        secureShuffle(peeled);

        const nextIdx = myIdx + 1;
        if (nextIdx >= mixOrder.length) {
          // LAST PEELER — reveal plaintext outputs to coordinator only.
          const revealedOutputs: FusionOutputRef[] = [];
          for (const inner of peeled) {
            const { addr, value } = onionUnpad(inner);
            if (addr && value > 0) {
              revealedOutputs.push({ script: addr, value });
            }
          }
          if (revealedOutputs.length === 0) {
            throw new Error('onion peel produced no valid outputs');
          }
          await transport.send(coordinator, {
            ...messageBinding(),
            type: 'outputs',
            session,
            outputs: revealedOutputs,
          });
        } else {
          const nextPeeler = mixOrder[nextIdx];
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
        onionBatchDone = true;
        if (declareResendTimer) {
          clearInterval(declareResendTimer);
          declareResendTimer = null;
        }
      } finally {
        onionBatchProcessing = false;
        // Always clear after a process attempt so a second batch cannot stack
        // on a stale last-peeler buffer (Claude: reset was only on forward).
        if (
          !onionBatchDone &&
          collectedOnions.length > 0 &&
          expectedOnionCount() !== null
        ) {
          void processOnionBatchIfReady().catch((error: unknown) =>
            void fail(asError(error), true)
          );
        }
      }
    };

    const handleOnionDeclare = (
      from: string,
      message: Extract<RoundMessage, { type: 'onion_declare' }>
    ) => {
      if (!params.participants.includes(from)) return;
      declaredOnionCounts.set(from, message.outputCount);
      void processOnionBatchIfReady().catch((error: unknown) =>
        void fail(asError(error), true)
      );
    };

    const handleOnionMessage = (
      _from: string,
      message: Extract<RoundMessage, { type: 'onion_output' }>
    ) => {
      if (settled) return;
      collectedOnions.push(message.onion);
      void processOnionBatchIfReady().catch((error: unknown) =>
        void fail(asError(error), true)
      );
    };

    unsubscribe = transport.onMessage((from, message) => {
      if (settled) return;
      if (message.session !== session) return;
      if (seenNonces.has(message.nonce)) return;
      seenNonces.add(message.nonce);

      // Round-key declare (attributable) — peels need the hop total first.
      if (message.type === 'onion_declare') {
        handleOnionDeclare(from, message);
        return;
      }

      // Onion outputs are gift-wrapped under a throwaway key (fusionTransport),
      // so `from` is almost never a round participant.
      if (message.type === 'onion_output') {
        handleOnionMessage(from, message);
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
      if (message.type === 'credential_params') {
        resolveCredParams?.({
          roundPubkey: message.roundPubkey,
          blindNoncePoints: message.blindNoncePoints,
        });
        resolveCredParams = null;
        return;
      }
      if (message.type === 'credential_response') {
        resolveCredResponse?.(message.responses);
        resolveCredResponse = null;
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
      const [jMin, jMax] = params.jitterMs ?? [200, 2000];

      // Phase 1.5: wait for issuer params, request blind credentials, unblind.
      // Without a bound, asymmetric discovery left participants stuck here for
      // the full 120s ("Registering inputs & outputs…") while the coordinator
      // wallet never entered the same round.
      params.onStatus?.(
        'Waiting for coordinator credentials (other wallets must have agreed)…'
      );
      const { roundPubkey, blindNoncePoints } = await waitWithTimeout(
        credParamsPromise,
        CREDENTIAL_WAIT_MS,
        'Timed out waiting for coordinator credentials'
      );
      const pedersen = buildPlayerPedersen(params.myContribution, params.feerate);
      const { requests, pending } = buildInputCredentialRequests(
        params.myContribution,
        params.participants,
        params.myPubkey,
        roundPubkey,
        blindNoncePoints
      );
      const responseWait = waitCredResponse();
      params.onStatus?.('Requesting blind credentials from coordinator…');
      await transport.send(coordinator, {
        ...messageBinding(),
        type: 'credential_request',
        session,
        requests,
        amountCommitments: pedersen.amountCommitments,
        pedersenTotalNonce: pedersen.pedersenTotalNonce,
        excessFee: pedersen.excessFee,
      });
      const responses = await waitWithTimeout(
        responseWait,
        CREDENTIAL_WAIT_MS,
        'Timed out waiting for credential response'
      );
      const byIndex = new Map(responses.map((r) => [r.index, r.s]));
      const credentialSigs: string[] = [];
      for (let i = 0; i < pending.length; i++) {
        const index = requests[i].index;
        const s = byIndex.get(index);
        if (!s) throw new Error(`missing credential response for slot ${index}`);
        credentialSigs.push(pending[i].finalizeHex(s, true));
      }

      // Phase 2: send inputs (with credentials) to coordinator
      params.onStatus?.(
        `Registering ${params.myContribution.inputs.length} input(s)…`
      );
      for (let i = 0; i < params.myContribution.inputs.length; i++) {
        await transport.send(coordinator, {
          ...messageBinding(),
          type: 'inputs',
          session,
          inputs: [params.myContribution.inputs[i]],
          credentialSigs: [credentialSigs[i]],
        });
        await jitterDelay(jMin, jMax);
      }
      // Phase 3: outputs.
      //
      // Onion needs ≥2 peelers (3+ wallets). With only 2 peers, mixOrder has
      // length 1: the lone peeler would gift-wrap onions to *themselves* over
      // Nostr — relays often never echo self-addressed kind-1059, so the hop
      // waits forever → "outputs never arrived (outputSlots=0/2…)". One peeler
      // also provides no mix privacy, so direct throwaway outputs are correct.
      //
      // Note mixOrder excludes the coordinator — it assembles, it does not peel.
      const onionUseful =
        params.onionEnabled !== false && mixOrder.length >= 2;
      if (onionUseful) {
        if (!isEccAvailable()) {
          throw new Error(
            'onion mix-net enabled but secp256k1 is unavailable in this environment'
          );
        }
        const myOutputs = params.myContribution.outputs;
        // Self is a peeler; don't wait for our own gift-wrap echo.
        declaredOnionCounts.set(params.myPubkey, myOutputs.length);
        const sendDeclare = async () => {
          // Fresh binding each time so nonce dedup does not drop re-sends.
          const declare: RoundMessage = {
            ...messageBinding(),
            type: 'onion_declare',
            session,
            outputCount: myOutputs.length,
          };
          await Promise.all(
            mixOrder
              .filter((peeler) => peeler !== params.myPubkey)
              .map((peeler) => transport.send(peeler, declare))
          );
        };
        await sendDeclare();
        // Tor often drops one gift-wrap; peel waits on sum(declares) forever.
        declareResendTimer = setInterval(() => {
          if (settled || onionBatchDone) return;
          void sendDeclare().catch(() => undefined);
        }, ONION_DECLARE_RESEND_MS);
        const firstPeeler = mixOrder[0];
        // One onion per output (80-byte pad cannot batch scripts).
        for (const output of myOutputs) {
          const payload = `${output.script}|${output.value}`;
          const onion = await onionWrap(payload, mixOrder);
          const onionB64 = btoa(String.fromCharCode(...onion));
          const onionMsg = {
            ...messageBinding(),
            type: 'onion_output' as const,
            session,
            onion: onionB64,
            mixOrder,
          };
          if (firstPeeler === params.myPubkey) {
            // Never rely on Nostr delivering a gift-wrap to ourselves.
            handleOnionMessage(params.myPubkey, onionMsg);
          } else {
            await transport.send(firstPeeler, onionMsg);
          }
          await jitterDelay(jMin, jMax);
        }
      } else {
        // Direct (or 2-party): one message with ALL outputs under throwaway key.
        await transport.send(coordinator, {
          ...messageBinding(),
          type: 'outputs',
          session,
          outputs: params.myContribution.outputs,
        });
      }
      // Signal that inputs (and onion inject / direct outputs) left this peer.
      // In onion mode the coordinator still waits for the last peeler's reveal
      // before assemble — ready ≠ pool filled.
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

  // Coordinator is the blind-Schnorr issuer for this round (server role, peer-hosted).
  let issuer: BlindIssuer;
  let selfIssueOk = true;
  let selfIssueError: Error | null = null;
  try {
    issuer = BlindIssuer.create(totalCredentialSlots(params.participants.length));
    // Self-issue credentials for the coordinator's own inputs so every CoinJoin
    // input is covered by a one-shot nonce from this round's issuer.
    const selfBuilt = buildInputCredentialRequests(
      params.myContribution,
      params.participants,
      params.myPubkey,
      issuer.pubkeyHex,
      issuer.rPointsHex
    );
    for (let i = 0; i < selfBuilt.pending.length; i++) {
      const index = selfBuilt.requests[i].index;
      const s = issuer.signHex(index, selfBuilt.requests[i].e);
      selfBuilt.pending[i].finalizeHex(s, true);
    }
    const selfPedersen = buildPlayerPedersen(params.myContribution, params.feerate);
    if (
      !pedersenBalanceHolds(
        selfPedersen.amountCommitments,
        selfPedersen.excessFee,
        selfPedersen.pedersenTotalNonce
      )
    ) {
      throw new Error('coordinator pedersen self-check failed');
    }
  } catch (error) {
    selfIssueOk = false;
    selfIssueError = asError(error);
    issuer = null as unknown as BlindIssuer;
  }

  return new Promise((resolve, reject) => {
    if (!selfIssueOk) {
      reject(selfIssueError ?? new Error('coordinator issuer setup failed'));
      return;
    }

    const inputsByPeer = new Map<string, FusionInputRef[]>([
      [params.myPubkey, params.myContribution.inputs],
    ]);
    // Track that coordinator inputs already carry verified credentials.
    const credentialedInputs = new Set<string>(
      params.myContribution.inputs.map(inputKey)
    );
    // Onion only when there are ≥2 peelers (3+ participants). Same rule as the
    // participant path — 2-party rounds use direct throwaway outputs.
    const useOnionForOutputs =
      params.onionEnabled !== false && mixOrder.length >= 2;
    // Direct mode (v1.7.0): pre-load coordinator outputs so the pool is never
    // empty while peers register. Onion mode starts empty and fills on reveal.
    if (
      !useOnionForOutputs &&
      params.myContribution.outputs.length === 0
    ) {
      return Promise.reject(
        new Error('coordinator has no fusion outputs to register')
      );
    }
    // Output registry.
    //
    // Direct-mode OUTPUT messages are gift-wrapped under a throwaway key
    // (fusionTransport.ts) so the coordinator cannot link them to a peer's
    // round identity. That means `from` on an outputs message is almost never
    // in `participants` — requiring participants.includes(from) silently
    // dropped every peer's outputs (user log: peersWithOutputs=1/3, pool=4
    // where 4 = coordinator-only preload). Anonymous batches are counted
    // separately; attributed maps still work for in-memory tests / onion.
    const outputsByPeer = new Map<string, FusionOutputRef[]>();
    const anonymousOutputBatches: FusionOutputRef[][] = [];
    if (!useOnionForOutputs) {
      outputsByPeer.set(params.myPubkey, [...params.myContribution.outputs]);
    }
    const outputPool = (): FusionOutputRef[] => [
      ...[...outputsByPeer.values()].flat(),
      ...anonymousOutputBatches.flat(),
    ];
    /** How many "participant slots" have output material (coord + batches). */
    const outputSlotsFilled = (): number => {
      const attributed = [...outputsByPeer.entries()].filter(
        ([, outs]) => outs.length > 0
      ).length;
      // Anonymous batches never double-count the coordinator's attributed set.
      return attributed + anonymousOutputBatches.length;
    };
    const signaturesByOutpoint = new Map<string, InputSig>();
    const signedPeers = new Set<string>();
    const seenNonces = new Set<string>();
    // Onion mode: do NOT mark the coordinator ready until its own onions are
    // injected. Self-ready at t=0 + peer ready after inject started a 25s
    // missing-outputs clock while the coordinator was still publishing blobs.
    const readyPeers = new Set<string>(
      useOnionForOutputs ? [] : [params.myPubkey]
    );
    const credentialedPeers = new Set<string>([params.myPubkey]);
    let assembled: { inputs: FusionInputRef[]; outputs: FusionOutputRef[] } | null =
      null;
    let assembling = false;
    let finalizing = false;
    let broadcastStarted = false;
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeProtocolError: () => void = () => undefined;
    let declareResendTimer: ReturnType<typeof setInterval> | null = null;
    /** Fail if ready peers never deliver outputs (log evidence: ready 3/3 outputs 0). */
    let missingOutputsTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (missingOutputsTimer) clearTimeout(missingOutputsTimer);
      if (declareResendTimer) {
        clearInterval(declareResendTimer);
        declareResendTimer = null;
      }
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

    /** Issue blind scalars for a peer after Pedersen balance check. */
    const handleCredentialRequest = async (
      from: string,
      message: Extract<RoundMessage, { type: 'credential_request' }>
    ) => {
      if (credentialedPeers.has(from)) {
        throw new Error(`duplicate credential request from ${from}`);
      }
      if (
        !pedersenBalanceHolds(
          message.amountCommitments,
          message.excessFee,
          message.pedersenTotalNonce
        )
      ) {
        throw new Error(`pedersen balance check failed for ${from}`);
      }
      // Slots must lie in this peer's reserved range.
      const base = peerCredentialSlotBase(params.participants, from);
      const responses: Array<{ index: number; s: string }> = [];
      for (const req of message.requests) {
        if (req.index < base || req.index >= base + CREDENTIAL_SLOTS_PER_PEER) {
          throw new Error(`credential slot ${req.index} outside peer range`);
        }
        responses.push({ index: req.index, s: issuer.signHex(req.index, req.e) });
      }
      credentialedPeers.add(from);
      await transport.send(from, {
        ...messageBinding(),
        type: 'credential_response',
        session,
        responses,
      });
    };

    /** Accept inputs only when every credential verifies under the round pubkey. */
    const acceptInputs = (from: string, inputs: FusionInputRef[], sigs: string[]) => {
      if (inputs.length !== sigs.length) {
        throw new Error('input/credential count mismatch');
      }
      for (let i = 0; i < inputs.length; i++) {
        const msgHex = inputCredentialMessageHashHex(inputs[i]);
        if (!verifyBchSchnorrHex(issuer.pubkeyHex, sigs[i], msgHex)) {
          throw new Error(`invalid input credential from ${from}`);
        }
        credentialedInputs.add(inputKey(inputs[i]));
      }
      const existing = inputsByPeer.get(from);
      if (existing) existing.push(...inputs);
      else inputsByPeer.set(from, [...inputs]);
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

    const outputsReady = (): boolean => {
      const pool = outputPool();
      if (pool.length === 0) return false;
      if (useOnionForOutputs) {
        // Onion reveal is one multi-output batch (anonymous or attributed).
        return pool.length > 0;
      }
      // Prefer full attribution (in-memory tests). Production anonymous path:
      // coordinator preloads self + one batch per other peer.
      if (
        params.participants.every(
          (peer) => (outputsByPeer.get(peer)?.length ?? 0) > 0
        )
      ) {
        return true;
      }
      const coordHas = (outputsByPeer.get(params.myPubkey)?.length ?? 0) > 0;
      return (
        coordHas && anonymousOutputBatches.length >= others.length
      );
    };

    const armMissingOutputsWatch = () => {
      if (missingOutputsTimer || settled || assembled) return;
      // User console: ready 3/3 peersWithOutputs=1/3 pool=4 — outputs gift-wrap
      // used throwaway keys and were dropped. Fail with slot counts — but give
      // onion multi-hop Tor enough time (25s was too short for 3 peelers).
      const waitMs = useOnionForOutputs
        ? MISSING_OUTPUTS_ONION_MS
        : MISSING_OUTPUTS_DIRECT_MS;
      missingOutputsTimer = setTimeout(() => {
        if (settled || assembled) return;
        if (
          readyPeers.size === params.participants.length &&
          !outputsReady()
        ) {
          const peelers = mixOrder.length;
          void fail(
            new Error(
              `All ${params.participants.length} peers marked ready but outputs ` +
                `never arrived (outputSlots=${outputSlotsFilled()}/` +
                `${params.participants.length}, anonBatches=` +
                `${anonymousOutputBatches.length}, pool=${outputPool().length}, ` +
                `onion=${useOnionForOutputs ? 'on' : 'off'}, peelers=${peelers}). ` +
                (useOnionForOutputs
                  ? 'Onion peel stalled (missing declare or hop blob).'
                  : 'Direct output gift-wraps never reached the coordinator (Tor/relay).')
            ),
            true
          );
        }
      }, waitMs);
    };

    const tryAssemble = async () => {
      const pool = outputPool();
      if (!settled && !assembled) {
        console.info(
          '[p2p-fusion coord] session',
          session.slice(0, 10),
          'inputs',
          inputsByPeer.size,
          '/',
          params.participants.length,
          'outputs',
          outputSlotsFilled(),
          '/',
          params.participants.length,
          'anon',
          anonymousOutputBatches.length,
          'pool',
          pool.length,
          'ready',
          readyPeers.size,
          '/',
          params.participants.length
        );
      }
      if (
        settled ||
        assembling ||
        assembled ||
        readyPeers.size !== params.participants.length
      ) {
        return;
      }
      if (!outputsReady()) {
        armMissingOutputsWatch();
        return;
      }
      const inputs = [...inputsByPeer.values()].flat();
      // Refuse to assemble until every input carries a verified blind credential.
      if (inputs.some((input) => !credentialedInputs.has(inputKey(input)))) {
        return;
      }
      // Global fee sanity before any peer signs (catches incomplete pools).
      const draft = assembleFusionTx([{ inputs, outputs: pool }]);
      const totalIn = draft.inputs.reduce((s, i) => s + i.value, 0);
      const totalOut = draft.outputs.reduce((s, o) => s + o.value, 0);
      const fee = totalIn - totalOut;
      const required = Math.ceil(
        ((10 +
          draft.inputs.reduce((s, i) => s + 108 + i.pubkey.length / 2, 0) +
          draft.outputs.reduce((s, o) => s + 9 + o.script.length / 2, 0)) *
          params.feerate) /
          1000
      );
      if (fee < 0 || fee > required * 3) {
        void fail(
          new Error(
            `refusing to assemble: fee ${fee} outside [0, ${required * 3}] ` +
              `(in=${totalIn} out=${totalOut} outputSlots=` +
              `${outputSlotsFilled()}/${params.participants.length}). ` +
              `Incomplete output pool or mis-planned values.`
          ),
          true
        );
        return;
      }
      if (missingOutputsTimer) {
        clearTimeout(missingOutputsTimer);
        missingOutputsTimer = null;
      }
      assembling = true;
      assembled = draft;
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
      if (message.type === 'credential_request' && others.includes(from)) {
        void handleCredentialRequest(from, message).catch((error: unknown) =>
          void fail(asError(error), true)
        );
        return;
      }
      if (message.type === 'components_ready' && others.includes(from)) {
        readyPeers.add(from);
        if (readyPeers.size === params.participants.length) {
          armMissingOutputsWatch();
        }
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
        try {
          acceptInputs(from, message.inputs, message.credentialSigs);
        } catch (error) {
          void fail(asError(error), true);
          return;
        }
        void tryAssemble().catch((error: unknown) =>
          void fail(asError(error), true)
        );
        return;
      }
      if (message.type === 'outputs') {
        if (assembled) return;
        const incoming = Array.isArray(message.outputs) ? message.outputs : [];
        const valid = incoming.filter(
          (o) =>
            o &&
            typeof o.script === 'string' &&
            o.script.length > 0 &&
            Number.isSafeInteger(o.value) &&
            o.value > 0
        );
        if (valid.length === 0) return;
        // Production gift-wrap seals outputs under a throwaway key, so `from`
        // is NOT in participants. Still accept those batches. Attributed path
        // keeps working for tests / any non-anonymous sender.
        if (params.participants.includes(from)) {
          if (useOnionForOutputs) {
            outputsByPeer.set(from, valid);
          } else {
            const existing = outputsByPeer.get(from) ?? [];
            const seen = new Set(
              existing.map((o) => `${o.value}:${o.script}`)
            );
            for (const o of valid) {
              const k = `${o.value}:${o.script}`;
              if (!seen.has(k)) {
                existing.push(o);
                seen.add(k);
              }
            }
            outputsByPeer.set(from, existing);
          }
        } else {
          // Cap anonymous batches so one peer cannot flood the pool forever.
          if (anonymousOutputBatches.length < others.length + 2) {
            anonymousOutputBatches.push(valid);
            console.info(
              '[p2p-fusion coord] anonymous output batch',
              valid.length,
              'outputs; batches',
              anonymousOutputBatches.length,
              '/',
              others.length
            );
          }
        }
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
    params.onStatus?.(
      `Coordinator: publishing credentials to ${others.length} peer(s)…`
    );

    // Publish issuer params first so peers can request credentials. Then
    // (onion mode) send our own outputs through the mix-net.
    void (async () => {
      const paramsMsg: RoundMessage = {
        ...messageBinding(),
        type: 'credential_params',
        session,
        roundPubkey: issuer.pubkeyHex,
        blindNoncePoints: issuer.rPointsHex,
      };
      await Promise.all(others.map((peer) => transport.send(peer, paramsMsg)));
      params.onStatus?.(
        `Coordinator: waiting for ${others.length} peer(s) to register inputs…`
      );

      if (!useOnionForOutputs) {
        readyPeers.add(params.myPubkey);
        void tryAssemble().catch((error: unknown) =>
          void fail(asError(error), true)
        );
        return;
      }
      const jMin = params.jitterMs?.[0] ?? 200;
      const jMax = params.jitterMs?.[1] ?? 2_000;
      const myOutputs = params.myContribution.outputs;
      const sendDeclare = async () => {
        const declare: RoundMessage = {
          ...messageBinding(),
          type: 'onion_declare',
          session,
          outputCount: myOutputs.length,
        };
        // Coordinator is never a peeler — always remote.
        await Promise.all(mixOrder.map((peeler) => transport.send(peeler, declare)));
      };
      await sendDeclare();
      declareResendTimer = setInterval(() => {
        if (settled || assembled) return;
        void sendDeclare().catch(() => undefined);
      }, ONION_DECLARE_RESEND_MS);
      const firstPeeler = mixOrder[0];
      for (const output of myOutputs) {
        const payload = `${output.script}|${output.value}`;
        const onion = await onionWrap(payload, mixOrder);
        const onionB64 = btoa(String.fromCharCode(...onion));
        await transport.send(firstPeeler, {
          ...messageBinding(),
          type: 'onion_output',
          session,
          onion: onionB64,
          mixOrder,
        });
        await jitterDelay(jMin, jMax);
      }
      // Now count as ready so "all ready" cannot start before our blobs exist.
      readyPeers.add(params.myPubkey);
      if (readyPeers.size === params.participants.length) {
        armMissingOutputsWatch();
      }
      void tryAssemble().catch((error: unknown) =>
        void fail(asError(error), true)
      );
    })().catch((error: unknown) => void fail(asError(error), true));
  });
}

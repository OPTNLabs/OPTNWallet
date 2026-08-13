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
import { electCoordinator, MIN_PARTICIPANTS } from './fusion';
import { ROUND_MSG_VERSION } from './fusionRound';
import {
  P2P_ASSEMBLED_RESEND_MS,
  P2P_CREDENTIAL_PARAMS_RESEND_MAX,
  P2P_CREDENTIAL_PARAMS_RESEND_MS,
  P2P_CREDENTIAL_WAIT_MS,
  P2P_MISSING_OUTPUTS_ONION_MS,
  P2P_ONION_DECLARE_RESEND_MAX,
  P2P_ONION_DECLARE_RESEND_MS,
  P2P_ONION_OUTPUT_RESEND_MAX,
  P2P_ONION_OUTPUT_RESEND_MS,
  P2P_ROUND_TIMEOUT_MS,
  P2P_SIG_RESEND_MS,
  P2P_SIG_STATUS_MS,
} from '../fusionTiming';
import {
  onionWrap,
  onionPeel,
  onionUnpadRaw,
  encodeAuthorizedOutput,
  decodeAuthorizedOutput,
  isEccAvailable,
  type AuthorizedOnionOutput,
} from './onionCrypto';
import {
  BlindIssuer,
  BlindSignatureRequest,
  CREDENTIAL_SLOTS_PER_PEER,
  MAX_INPUT_CREDENTIALS_PER_PEER,
  MAX_OUTPUT_CREDENTIALS_PER_PEER,
  inputCredentialMessageHash,
  inputCredentialMessageHashHex,
  outputCredentialMessageHash,
  outputCredentialMessageHashHex,
  peerCredentialSlotBase,
  totalCredentialSlots,
  verifyBchSchnorrHex,
  verifyCredentialOpening,
} from './fusionBlindSchnorr';
import {
  encodeInputComponent,
  encodeOutputComponent,
  freshSaltCommitment,
  saltedComponentHashHex,
} from './fusionComponentV4';
import {
  componentCommitmentOpeningMatches,
  componentCredentialOpeningMatches,
  createBlameReport,
  findFaultInDisclosures,
  formatBlameAbortReason,
  isBlameCode,
  parseBlameEvidence,
  verifyBlameReport,
  type BlameCode,
  type BlameEvidence,
  type BlameReport,
  type ComponentDisclosure,
  type ComponentDisclosureOpening,
  type ComponentCommitmentOpening,
  type DisclosureFinding,
} from './fusionBlame';
import {
  clearRoundNullifiers,
  consumeOutputNullifiers,
} from './fusionCredentialNullifiers';
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
      /**
       * EC InitialCommitment fields, parallel to `requests`. The salted hash
       * binds each anonymous Component to the attributed Pedersen point while
       * revealing neither component until the abort-only opening phase.
       */
      componentCommitments: Array<{
        index: number;
        saltedComponentHash: string;
        amountCommitment: string;
      }>;
      /** Σ component nonces mod n (32-byte hex). */
      pedersenTotalNonce: string;
      /** Player excess fee the commitments must sum to. */
      excessFee: number;
      inputCount: number;
      outputCount: number;
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
      /**
       * v4: salt_commitment per input so the coordinator recomputes
       * sha256(EC Component) for credential verification.
       */
      saltCommitments: string[];
    } & MessageBinding)
  | ({
      type: 'outputs';
      session: string;
      outputs: AuthorizedOnionOutput[];
    } & MessageBinding)
  | ({
      type: 'onion_output';
      session: string;
      onion: string;
      mixOrder: string[];
    } & MessageBinding)
  /**
   * How many onion blobs this peer will inject (one per output). Signed under
   * the round key so peels know the hop total = sum of declares. Without this,
   * peels waited for `participants.length` while peers sent a random 2–4
   * onions each → hang / outputSlots=0 (Claude diagnosis, 2026-08-06).
   */
  | ({
      type: 'onion_declare';
      session: string;
      outputCount: number;
    } & MessageBinding)
  | ({ type: 'components_ready'; session: string } & MessageBinding)
  | ({
      type: 'assembled';
      session: string;
      inputs: FusionInputRef[];
      outputs: FusionOutputRef[];
    } & MessageBinding)
  | ({ type: 'signature'; session: string; sigs: InputSig[] } & MessageBinding)
  | ({
      type: 'final';
      session: string;
      txid: string;
      txHex: string;
    } & MessageBinding)
  /** Provable protocol fault (ephemeral session key only). Never used for timeouts. */
  | ({
      type: 'blame';
      session: string;
      accused: string;
      code: BlameCode;
      evidence: BlameEvidence;
    } & MessageBinding)
  | ({
      /**
       * Post-abort component disclosure (Electron Cash blame phase).
       *
       * Components travel anonymously, so a failed round has nobody to accuse —
       * `verifyBlameReport` rejects an accused outside the participant set. This
       * message is the answer, and it is deliberately CONTROL PLANE: it is sent
       * under the round identity, never added to the anonymous set in
       * `fusionTransport.ts`. A peer therefore proves which components were its
       * own, and a peer that stays silent is identified BY ABSENCE — which is
       * what makes an anonymous griefer attributable again.
       *
       * Sent ONLY when a round aborts. A successful round discloses nothing, so
       * the unlinkability of the happy path is untouched.
       */
      type: 'component_disclosure';
      session: string;
      /** Outpoints this peer registered, as `${prevTxid}:${prevIndex}`. */
      outpoints: string[];
      /** Credential serials this peer used for its anonymous outputs. */
      serials: string[];
      /**
       * Openings `a||b` per outpoint so the coordinator can prove the claim
       * (C3). Optional on the type for tests; live peers must send them or
       * their outpoints are ignored for blame.
       */
      openings?: ComponentDisclosureOpening[];
      /** EC salt + Pedersen nonce openings for every contributed component. */
      componentOpenings?: ComponentCommitmentOpening[];
    } & MessageBinding);

export interface RoundTransport {
  send(toPubkey: string, msg: RoundMessage): Promise<void>;
  onMessage(handler: (from: string, msg: RoundMessage) => void): () => void;
  onProtocolError?: (
    handler: (from: string, error: Error) => void
  ) => () => void;
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
const MAX_COMPONENTS = 120;
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

function isSafeIntegerIn(
  value: unknown,
  minimum: number,
  maximum: number
): value is number {
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
  if (typeof value.nonce !== 'string' || !HEX_32.test(value.nonce))
    return false;
  if (!isSafeIntegerIn(value.timestamp, 0, Number.MAX_SAFE_INTEGER))
    return false;
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

function validInitialComponentCommitment(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeIntegerIn(value.index, 0, 1023) &&
    typeof value.saltedComponentHash === 'string' &&
    HEX_64_STRICT.test(value.saltedComponentHash) &&
    typeof value.amountCommitment === 'string' &&
    HEX_130.test(value.amountCommitment)
  );
}

function validComponentCommitmentOpening(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.kind !== 'input' && value.kind !== 'output') ||
    !isSafeIntegerIn(value.slotIndex, 0, 4095) ||
    typeof value.openingHex !== 'string' ||
    !HEX_128.test(value.openingHex) ||
    typeof value.saltHex !== 'string' ||
    !HEX_64_STRICT.test(value.saltHex) ||
    typeof value.pedersenNonceHex !== 'string' ||
    !HEX_64_STRICT.test(value.pedersenNonceHex)
  ) {
    return false;
  }
  return value.kind === 'input'
    ? typeof value.outpoint === 'string' &&
        /^[0-9a-f]{64}:\d+$/i.test(value.outpoint)
    : typeof value.credentialSerial === 'string' &&
        HEX_64_STRICT.test(value.credentialSerial);
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
/** Create blind requests for every input and anonymous output component. */
function buildComponentCredentialRequests(
  contribution: PeerContribution,
  participants: string[],
  myPubkey: string,
  roundPubkey: string,
  blindNoncePoints: string[],
  context: { session: string; network: 'mainnet' | 'chipnet'; tier: number },
  feerate: number
): {
  requests: Array<{ index: number; e: string }>;
  componentCommitments: Array<{
    index: number;
    saltedComponentHash: string;
    amountCommitment: string;
  }>;
  amountCommitments: string[];
  pedersenTotalNonce: string;
  excessFee: number;
  pending: BlindSignatureRequest[];
  indices: number[];
  outputSerials: string[];
  inputSaltCommitments: string[];
  outputSaltCommitments: string[];
  componentOpenings: ComponentCommitmentOpening[];
} {
  const base = peerCredentialSlotBase(participants, myPubkey);
  const componentCount =
    contribution.inputs.length + contribution.outputs.length;
  if (componentCount > CREDENTIAL_SLOTS_PER_PEER) {
    throw new Error(
      `too many components for credential slots (${componentCount} > ${CREDENTIAL_SLOTS_PER_PEER})`
    );
  }
  const requests: Array<{ index: number; e: string }> = [];
  const pending: BlindSignatureRequest[] = [];
  const indices: number[] = [];
  const outputSerials: string[] = [];
  const inputSaltCommitments: string[] = [];
  const outputSaltCommitments: string[] = [];
  const componentCommitments: Array<{
    index: number;
    saltedComponentHash: string;
    amountCommitment: string;
  }> = [];
  const amountCommitments: string[] = [];
  const pedersenNonces: string[] = [];
  const componentOpenings: ComponentCommitmentOpening[] = [];
  let excessFee = 0;
  contribution.inputs.forEach((input, i) => {
    const index = base + i;
    const r = blindNoncePoints[index];
    if (!r) throw new Error(`missing blind nonce point at slot ${index}`);
    const { saltHex, saltCommitmentHex } = freshSaltCommitment();
    const component = encodeInputComponent({
      prevTxidDisplayHex: input.prevTxid,
      prevIndex: input.prevIndex,
      pubkeyHex: input.pubkey,
      amount: input.value,
      saltCommitmentHex,
    });
    const contributionAmount =
      input.value - componentFeeSats(108 + input.pubkey.length / 2, feerate);
    const commitment = pedersenCommit(contributionAmount);
    excessFee += contributionAmount;
    inputSaltCommitments.push(saltCommitmentHex);
    const req = BlindSignatureRequest.create(
      roundPubkey,
      r,
      inputCredentialMessageHash(input, saltCommitmentHex)
    );
    requests.push({ index, e: req.requestHex() });
    pending.push(req);
    indices.push(index);
    amountCommitments.push(commitment.commitmentHex);
    pedersenNonces.push(commitment.nonceHex);
    componentCommitments.push({
      index,
      saltedComponentHash: saltedComponentHashHex(saltHex, component),
      amountCommitment: commitment.commitmentHex,
    });
    componentOpenings.push({
      kind: 'input',
      outpoint: inputKey(input),
      slotIndex: index,
      openingHex: req.openingHex(),
      saltHex,
      pedersenNonceHex: commitment.nonceHex,
    });
  });
  contribution.outputs.forEach((output, i) => {
    const index = base + contribution.inputs.length + i;
    const r = blindNoncePoints[index];
    if (!r) throw new Error(`missing blind nonce point at slot ${index}`);
    const serialBytes = new Uint8Array(32);
    crypto.getRandomValues(serialBytes);
    const serial = Array.from(serialBytes, (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    const { saltHex, saltCommitmentHex } = freshSaltCommitment();
    const component = encodeOutputComponent({
      scriptHex: output.script,
      amount: output.value,
      saltCommitmentHex,
    });
    const contributionAmount = -(
      output.value + componentFeeSats(9 + output.script.length / 2, feerate)
    );
    const commitment = pedersenCommit(contributionAmount);
    excessFee += contributionAmount;
    outputSaltCommitments.push(saltCommitmentHex);
    const req = BlindSignatureRequest.create(
      roundPubkey,
      r,
      outputCredentialMessageHash(context, output, serial, saltCommitmentHex)
    );
    requests.push({ index, e: req.requestHex() });
    pending.push(req);
    indices.push(index);
    outputSerials.push(serial);
    amountCommitments.push(commitment.commitmentHex);
    pedersenNonces.push(commitment.nonceHex);
    componentCommitments.push({
      index,
      saltedComponentHash: saltedComponentHashHex(saltHex, component),
      amountCommitment: commitment.commitmentHex,
    });
    componentOpenings.push({
      kind: 'output',
      credentialSerial: serial,
      slotIndex: index,
      openingHex: req.openingHex(),
      saltHex,
      pedersenNonceHex: commitment.nonceHex,
    });
  });
  if (excessFee < 0) {
    throw new Error(
      'pedersen excess fee is negative — outputs+fees exceed inputs'
    );
  }
  return {
    requests,
    componentCommitments,
    amountCommitments,
    pedersenTotalNonce: sumNoncesHex(pedersenNonces),
    excessFee,
    pending,
    indices,
    outputSerials,
    inputSaltCommitments,
    outputSaltCommitments,
    componentOpenings,
  };
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

function validAuthorizedOutput(value: unknown): boolean {
  return (
    validOutput(value) &&
    isRecord(value) &&
    typeof value.credentialSerial === 'string' &&
    HEX_64_STRICT.test(value.credentialSerial) &&
    typeof value.credentialSig === 'string' &&
    HEX_128.test(value.credentialSig) &&
    typeof value.saltCommitment === 'string' &&
    HEX_64_STRICT.test(value.saltCommitment)
  );
}

export function verifyAuthorizedOutputBatch(
  outputs: AuthorizedOnionOutput[],
  expectedCount: number,
  issuerPubkey: string,
  context: { session: string; network: 'mainnet' | 'chipnet'; tier: number }
): { ok: true; serials: string[] } | { ok: false; reason: string } {
  if (outputs.length !== expectedCount || expectedCount < 1) {
    return { ok: false, reason: 'output credential quota mismatch' };
  }
  const serials = new Set<string>();
  const outputIds = new Set<string>();
  const componentHashes = new Set<string>();
  for (const output of outputs) {
    if (!validAuthorizedOutput(output)) {
      return { ok: false, reason: 'malformed authorized output' };
    }
    const serial = output.credentialSerial.toLowerCase();
    const outputId = `${output.value}:${output.script.toLowerCase()}`;
    const msgHex = outputCredentialMessageHashHex(
      context,
      output,
      serial,
      output.saltCommitment
    );
    if (
      serials.has(serial) ||
      outputIds.has(outputId) ||
      componentHashes.has(msgHex)
    ) {
      return { ok: false, reason: 'duplicate output credential or output' };
    }
    if (!verifyBchSchnorrHex(issuerPubkey, output.credentialSig, msgHex)) {
      return { ok: false, reason: 'invalid output credential' };
    }
    serials.add(serial);
    outputIds.add(outputId);
    componentHashes.add(msgHex);
  }
  return { ok: true, serials: [...serials] };
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
  if (content.length === 0 || content.length > MAX_ROUND_MESSAGE_CHARS)
    return null;
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
      case 'blame': {
        if (
          typeof message.accused !== 'string' ||
          // 64 = Nostr x-only; 66 = compressed (in-memory tests)
          !(
            HEX_64.test(message.accused) ||
            /^(02|03)[0-9a-f]{64}$/i.test(message.accused)
          ) ||
          !isBlameCode(message.code)
        ) {
          return null;
        }
        const evidence = parseBlameEvidence(
          message.code as BlameCode,
          message.evidence
        );
        if (!evidence) return null;
        message.evidence = evidence;
        break;
      }
      case 'component_disclosure': {
        // Bounded like every other component-bearing message: a disclosure is
        // parsed from an aborted round, which is exactly when a hostile peer
        // has the most reason to send something oversized.
        const outpoints = message.outpoints;
        const serials = message.serials;
        const openings = message.openings;
        if (
          !Array.isArray(outpoints) ||
          !Array.isArray(serials) ||
          outpoints.length > MAX_COMPONENTS ||
          serials.length > MAX_COMPONENTS ||
          outpoints.length + serials.length === 0 ||
          !outpoints.every(
            (outpoint) =>
              typeof outpoint === 'string' &&
              /^[0-9a-f]{64}:\d+$/i.test(outpoint)
          ) ||
          !serials.every(
            (serial) => typeof serial === 'string' && HEX_64_STRICT.test(serial)
          )
        ) {
          return null;
        }
        // Openings are optional for parser liveness (empty = no proven outpoints)
        // but when present each entry is strictly bounded.
        if (openings !== undefined) {
          if (
            !Array.isArray(openings) ||
            openings.length > MAX_COMPONENTS ||
            !openings.every(
              (entry) =>
                isRecord(entry) &&
                typeof entry.outpoint === 'string' &&
                /^[0-9a-f]{64}:\d+$/i.test(entry.outpoint) &&
                Number.isSafeInteger(entry.slotIndex) &&
                (entry.slotIndex as number) >= 0 &&
                (entry.slotIndex as number) < 4096 &&
                typeof entry.openingHex === 'string' &&
                HEX_128.test(entry.openingHex)
            )
          ) {
            return null;
          }
        }
        if (message.componentOpenings !== undefined) {
          if (
            !Array.isArray(message.componentOpenings) ||
            message.componentOpenings.length > MAX_COMPONENTS ||
            !message.componentOpenings.every(validComponentCommitmentOpening)
          ) {
            return null;
          }
        }
        break;
      }
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
          !Array.isArray(message.componentCommitments) ||
          message.componentCommitments.length !== message.requests.length ||
          !message.componentCommitments.every(
            validInitialComponentCommitment
          ) ||
          typeof message.pedersenTotalNonce !== 'string' ||
          !HEX_64_STRICT.test(message.pedersenTotalNonce) ||
          !isSafeIntegerIn(message.excessFee, 0, MAX_MONEY) ||
          !isSafeIntegerIn(
            message.inputCount,
            1,
            MAX_INPUT_CREDENTIALS_PER_PEER
          ) ||
          !isSafeIntegerIn(
            message.outputCount,
            1,
            MAX_OUTPUT_CREDENTIALS_PER_PEER
          ) ||
          message.requests.length !==
            message.inputCount + message.outputCount ||
          message.amountCommitments.length !== message.requests.length ||
          message.requests.length > CREDENTIAL_SLOTS_PER_PEER ||
          new Set(message.requests.map((request) => request.index)).size !==
            message.requests.length ||
          message.componentCommitments.some(
            (commitment, index) =>
              commitment.index !== message.requests[index].index ||
              commitment.amountCommitment.toLowerCase() !==
                message.amountCommitments[index].toLowerCase()
          )
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
          ) ||
          !Array.isArray(message.saltCommitments) ||
          message.saltCommitments.length !==
            (message.inputs as unknown[]).length ||
          !message.saltCommitments.every(
            (s) => typeof s === 'string' && HEX_64_STRICT.test(s)
          )
        ) {
          return null;
        }
        break;
      case 'outputs':
        if (!validArray(message.outputs, validAuthorizedOutput)) return null;
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
        if (
          !isSafeIntegerIn(
            message.outputCount,
            1,
            MAX_OUTPUT_CREDENTIALS_PER_PEER
          )
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
  /** Credential-domain network; production callers always provide it. */
  network?: 'mainnet' | 'chipnet';
  feerate: number;
  myContribution: PeerContribution;
  keysByPubkey: Map<string, Uint8Array>;
  /** Production supplies the native P2P-v3 signing boundary. */
  sign?: (tx: ReturnType<typeof assembleFusionTx>) => Promise<InputSig[]>;
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
  /**
   * Fired when a blame report is verified (local or remote). Service layer may
   * exclude the ephemeral session key for this attempt only — not a person ban.
   */
  onBlame?: (report: BlameReport) => void;
}

/** Bound silent waits — caps from fusionTiming (server protocol.py). */
const CREDENTIAL_WAIT_MS = P2P_CREDENTIAL_WAIT_MS;
const CREDENTIAL_PARAMS_RESEND_MS = P2P_CREDENTIAL_PARAMS_RESEND_MS;
const CREDENTIAL_PARAMS_RESEND_MAX = P2P_CREDENTIAL_PARAMS_RESEND_MAX;
const MISSING_OUTPUTS_ONION_MS = P2P_MISSING_OUTPUTS_ONION_MS;
/** Re-send onion_declare so Tor-dropped declares cannot freeze the peel forever. */
const ONION_DECLARE_RESEND_MS = P2P_ONION_DECLARE_RESEND_MS;
const ONION_DECLARE_RESEND_MAX = P2P_ONION_DECLARE_RESEND_MAX;
/** Bounded hop inject re-sends (not open-ended — that crushed Tor latency). */
const ONION_OUTPUT_RESEND_MS = P2P_ONION_OUTPUT_RESEND_MS;
const ONION_OUTPUT_RESEND_MAX = P2P_ONION_OUTPUT_RESEND_MAX;
/**
 * Forward each anonymous component through its own transport invocation, but
 * avoid serially multiplying Tor relay latency across a 16-output round.
 */
const ONION_FORWARD_CONCURRENCY = 4;

async function sendInBoundedWaves<T>(
  items: readonly T[],
  concurrency: number,
  send: (item: T) => Promise<void>
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += concurrency) {
    await Promise.all(items.slice(offset, offset + concurrency).map(send));
  }
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  hint?: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} (after ${Math.round(ms / 1000)}s). ` +
              (hint ??
                'Usually means other wallets never joined this round — ' +
                  'they saw a different peer set over Tor.')
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
/**
 * How long the coordinator keeps listening for `component_disclosure` after it
 * has already told every peer the round is dead.
 *
 * Deliberately bounded and awaited BEFORE `cleanup()`/`reject()`, never after.
 * An earlier attempt kept the transport subscription alive past the settled
 * promise instead; that leaked a live handler, which is what
 * `hub.activeHandlerCount()).toBe(0)` in the session tests exists to catch
 * (it failed as `expected 1 to be +0`). The window closes early as soon as
 * every peer has disclosed, so the honest path pays milliseconds, not this
 * ceiling.
 */
const BLAME_WINDOW_MS = 1_200;
const BLAME_POLL_MS = 20;
/**
 * E0 — how much longer than the coordinator a PEER waits before giving up.
 *
 * Every caller passes one `timeoutMs` for the whole round, so without this
 * every role hit its deadline in the same tick: peers tore down and
 * unsubscribed before the coordinator's abort could reach them, disclosed
 * nothing, and the blame phase then burned its entire ceiling waiting for
 * messages that could never arrive. The machinery was correct and the round
 * still ended with no accused.
 *
 * The coordinator must lose first. Derived from the blame window, not a
 * hand-picked number, so the two cannot drift apart: the margin has to cover
 * the abort reaching a peer plus that peer's disclosure coming back. The cost
 * is that a genuinely silent coordinator keeps peers waiting this much longer,
 * which is bounded and worth an attributable abort.
 */
const PEER_TIMEOUT_MARGIN_MS = BLAME_WINDOW_MS + 1_800;

function sessionId(participants: string[], tier: number): string {
  return `${electCoordinator(participants)}:${tier}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(reason: string): Error {
  return new Error(`fusion round aborted: ${reason}`);
}

function inputKey(
  input: Pick<FusionInputRef, 'prevTxid' | 'prevIndex'>
): string {
  return `${input.prevTxid}:${input.prevIndex}`;
}

export function runFusionRound(
  params: RoundParams,
  transport: RoundTransport
): Promise<RoundResult> {
  const participants = [...new Set(params.participants)];
  // CashFusion-style floor: ≥ MIN_PARTICIPANTS, onion always (no 2-party path).
  if (
    participants.length < MIN_PARTICIPANTS ||
    !participants.includes(params.myPubkey)
  ) {
    return Promise.reject(
      new Error(
        `invalid Fusion participant set (need ≥${MIN_PARTICIPANTS} peers for onion P2P fusion)`
      )
    );
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

async function assembleVerifySign(
  params: RoundParams,
  inputs: FusionInputRef[],
  outputs: FusionOutputRef[]
): Promise<InputSig[]> {
  const tx = assembleFusionTx([{ inputs, outputs }]);
  const safety = verifyFusionSafety(tx, params.myContribution, params.feerate);
  if (!safety.ok) throw new Error(`refusing to sign: ${safety.reason}`);
  if (params.signal?.aborted) throw abortError('cancelled before signing');
  const signatures = params.sign
    ? await params.sign(tx)
    : signMyInputs(tx, params.keysByPubkey);
  if (params.signal?.aborted) throw abortError('cancelled after signing');
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
  const mixOrder =
    params.mixOrder ??
    [...params.participants].filter((p) => p !== coordinator).sort();
  const myIdx = mixOrder.indexOf(params.myPubkey);

  return new Promise((resolve, reject) => {
    let settled = false;
    let signed = false;
    let approved: {
      inputs: FusionInputRef[];
      outputs: FusionOutputRef[];
    } | null = null;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeProtocolError: () => void = () => undefined;
    let declareResendTimer: ReturnType<typeof setInterval> | null = null;
    let onionOutputResendTimer: ReturnType<typeof setInterval> | null = null;
    let onionForwardResendTimer: ReturnType<typeof setInterval> | null = null;
    let onionStatusTimer: ReturnType<typeof setInterval> | null = null;
    let sigResendTimer: ReturnType<typeof setInterval> | null = null;
    const seenNonces = new Set<string>();
    // Onion mix-net: one blob per *output*, not per peer. Each peer announces
    // how many it will inject (`onion_declare`); hop waits for sum(declares).
    const collectedOnions: string[] = [];
    /**
     * Payload dedup (not message nonce). Hop re-sends use a fresh binding nonce
     * so Tor drops recover, but without this the same onion b64 was pushed
     * twice → peel assembled duplicate outs → fee negative / outputSlots mess
     * (live auto 2026-08-06: fee -92242745, out>in, outputSlots=1/3).
     */
    const seenOnionPayloads = new Set<string>();
    const declaredOnionCounts = new Map<string, number>();
    let onionBatchProcessing = false;
    let onionBatchDone = false;
    /**
     * Credential serials this peer used for its own anonymous outputs. Held so
     * an aborted round can be explained: disclosed ONLY on abort, never on a
     * successful round, so happy-path unlinkability is unaffected.
     */
    let myOutputSerials: string[] = [];
    /** Input openings for abort disclosure only — never sent on success. */
    let myInputOpenings: ComponentDisclosureOpening[] = [];
    let myComponentOpenings: ComponentCommitmentOpening[] = [];

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

    const reportOnionWait = () => {
      if (settled || onionBatchDone || myIdx < 0) return;
      const exp = expectedOnionCount();
      params.onStatus?.(
        `Onion peel hop ${myIdx + 1}/${mixOrder.length}: ` +
          `declares ${declaredOnionCounts.size}/${params.participants.length}, ` +
          `blobs ${collectedOnions.length}${exp != null ? `/${exp}` : ''}…`
      );
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
    let credResponsePromise: Promise<
      Array<{ index: number; s: string }>
    > | null = null;
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
      if (onionOutputResendTimer) {
        clearInterval(onionOutputResendTimer);
        onionOutputResendTimer = null;
      }
      if (onionForwardResendTimer) {
        clearInterval(onionForwardResendTimer);
        onionForwardResendTimer = null;
      }
      if (onionStatusTimer) {
        clearInterval(onionStatusTimer);
        onionStatusTimer = null;
      }
      if (sigResendTimer) {
        clearInterval(sigResendTimer);
        sigResendTimer = null;
      }
      params.signal?.removeEventListener('abort', onCancel);
      unsubscribe();
      unsubscribeProtocolError();
    };
    const fail = async (error: Error, notifyCoordinator: boolean) => {
      if (settled) return;
      settled = true;
      // Always surface — live run died at phase 5/6 with no UI text (2026-08-06).
      const exp = expectedOnionCount();
      const detail =
        myIdx >= 0
          ? ` (this hop declares=${declaredOnionCounts.size}/${params.participants.length} ` +
            `blobs=${collectedOnions.length}${exp != null ? `/${exp}` : ''})`
          : '';
      params.onStatus?.(`Round failed: ${error.message}${detail}`);
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
      params.onStatus?.(
        `Round complete — txid ${result.txid.slice(0, 12)}… (broadcasting)`
      );
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
            const blob = Uint8Array.from(atob(onionB64), (c) =>
              c.charCodeAt(0)
            );
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
          const revealedOutputs: AuthorizedOnionOutput[] = [];
          for (const inner of peeled) {
            revealedOutputs.push(decodeAuthorizedOutput(onionUnpadRaw(inner)));
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
          const forwardedPayloads = peeled.map((inner) =>
            btoa(String.fromCharCode(...inner))
          );
          let forwardSendInFlight: Promise<void> | null = null;
          const sendForwardBatch = (): Promise<void> => {
            if (forwardSendInFlight) return forwardSendInFlight;
            const run = (async () => {
              try {
                await sendInBoundedWaves(
                  forwardedPayloads,
                  ONION_FORWARD_CONCURRENCY,
                  (innerB64) =>
                    transport.send(nextPeeler, {
                      ...messageBinding(),
                      type: 'onion_output',
                      session,
                      onion: innerB64,
                      mixOrder,
                    })
                );
              } finally {
                forwardSendInFlight = null;
              }
            })();
            forwardSendInFlight = run;
            return run;
          };
          await sendForwardBatch();
          // A relay ACK proves storage, not that the next peeler observed the
          // gift-wrap. Keep a bounded copy of the shuffled batch and retry it;
          // the next hop deduplicates identical onion payloads before peeling.
          let forwardResendsLeft = ONION_OUTPUT_RESEND_MAX;
          onionForwardResendTimer = setInterval(() => {
            if (settled || signed || forwardResendsLeft <= 0) {
              if (onionForwardResendTimer) {
                clearInterval(onionForwardResendTimer);
                onionForwardResendTimer = null;
              }
              return;
            }
            if (forwardSendInFlight) return;
            forwardResendsLeft -= 1;
            void sendForwardBatch().catch(() => undefined);
          }, ONION_OUTPUT_RESEND_MS);
        }
        onionBatchDone = true;
        if (declareResendTimer) {
          clearInterval(declareResendTimer);
          declareResendTimer = null;
        }
        if (onionOutputResendTimer) {
          clearInterval(onionOutputResendTimer);
          onionOutputResendTimer = null;
        }
        if (onionStatusTimer) {
          clearInterval(onionStatusTimer);
          onionStatusTimer = null;
        }
        params.onStatus?.(
          nextIdx >= mixOrder.length
            ? 'Onion peel done — revealed outputs to coordinator…'
            : `Onion peel hop ${myIdx + 1} done — forwarded to next peeler…`
        );
      } finally {
        onionBatchProcessing = false;
        // Always clear after a process attempt so a second batch cannot stack
        // on a stale last-peeler buffer (Claude: reset was only on forward).
        if (
          !onionBatchDone &&
          collectedOnions.length > 0 &&
          expectedOnionCount() !== null
        ) {
          void processOnionBatchIfReady().catch(
            (error: unknown) => void fail(asError(error), true)
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
      reportOnionWait();
      void processOnionBatchIfReady().catch(
        (error: unknown) => void fail(asError(error), true)
      );
    };

    const handleOnionMessage = (
      _from: string,
      message: Extract<RoundMessage, { type: 'onion_output' }>
    ) => {
      if (settled || onionBatchDone) return;
      // Identical payload = hop re-send; keep first only.
      if (seenOnionPayloads.has(message.onion)) return;
      seenOnionPayloads.add(message.onion);
      collectedOnions.push(message.onion);
      reportOnionWait();
      void processOnionBatchIfReady().catch(
        (error: unknown) => void fail(asError(error), true)
      );
    };

    unsubscribe = transport.onMessage(async (from, message) => {
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

      // Verified blame from any round participant (usually coordinator).
      if (message.type === 'blame' && params.participants.includes(from)) {
        const report: BlameReport = {
          session: message.session,
          accused: message.accused,
          code: message.code,
          evidence: message.evidence,
        };
        const check = verifyBlameReport(report, {
          session,
          participants: params.participants,
          feerate: params.feerate,
        });
        if (!check.ok) return;
        params.onBlame?.(report);
        void fail(new Error(formatBlameAbortReason(report)), false);
        return;
      }

      // Only coordinator messages below
      if (from !== coordinator) return;
      if (message.type === 'abort') {
        // Electron Cash blame phase. Components travelled anonymously, so the
        // coordinator cannot name anyone for a failed round. Disclosing our own
        // components under the ROUND IDENTITY lets it cross-check who did what
        // — and makes silence itself evidence, since a griefer that never
        // discloses is identified by absence. Best-effort: the round is already
        // failing, so a send error must not mask the real abort reason.
        void transport
          .send(coordinator, {
            ...messageBinding(),
            type: 'component_disclosure',
            session,
            outpoints: params.myContribution.inputs.map(inputKey),
            serials: myOutputSerials,
            openings: myInputOpenings,
            componentOpenings: myComponentOpenings,
          })
          .catch(() => undefined)
          .finally(() => void fail(abortError(message.reason), false));
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
          params.onStatus?.('Assembled tx received — signing our inputs…');
          const signatures = await assembleVerifySign(
            params,
            approved.inputs,
            approved.outputs
          );
          params.onPhase?.(6);
          const sendSigs = () =>
            transport.send(coordinator, {
              ...messageBinding(),
              type: 'signature',
              session,
              sigs: signatures,
            });
          params.onStatus?.(
            'Signed — waiting for coordinator final (re-sending sigs if Tor drops)…'
          );
          void sendSigs().catch(
            (error: unknown) => void fail(asError(error), true)
          );
          // Tor gift-wraps drop; coordinator hung on incomplete sig set while UI
          // only showed phase=6 then auto-restarted with no message (live 2026-08-06).
          if (sigResendTimer) clearInterval(sigResendTimer);
          sigResendTimer = setInterval(() => {
            if (settled) return;
            void sendSigs().catch(() => undefined);
          }, P2P_SIG_RESEND_MS);
        } catch (error) {
          void fail(asError(error), true);
        }
        return;
      }
      if (message.type === 'final') {
        if (!signed || !approved) {
          void fail(
            new Error('received final transaction before verification'),
            true
          );
          return;
        }
        try {
          verifyFinalFusionTx(approved, message.txHex, message.txid);
          params.onPhase?.(7);
          params.onStatus?.('Final tx verified — broadcasting…');
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
      () =>
        void fail(
          new Error(
            'fusion round timed out (after assemble/sign this usually means ' +
              'signatures or final gift-wrap never arrived over Tor)'
          ),
          true
        ),
      // E0: outlast the coordinator so its abort still finds us subscribed and
      // we can disclose. Same caller timeout, later deadline for this role.
      (params.timeoutMs ?? DEFAULT_TIMEOUT) + PEER_TIMEOUT_MARGIN_MS
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
        'Timed out waiting for coordinator credentials',
        'Coordinator credential_params may have been dropped on Tor — ' +
          'keep Auto on; coordinator now re-sends params until all peers request.'
      );
      const credentialContext = {
        session,
        network: params.network ?? 'chipnet',
        tier: params.tier,
      };
      const {
        requests,
        pending,
        outputSerials,
        inputSaltCommitments,
        outputSaltCommitments,
        componentCommitments,
        amountCommitments,
        pedersenTotalNonce,
        excessFee,
        componentOpenings,
      } = buildComponentCredentialRequests(
        params.myContribution,
        params.participants,
        params.myPubkey,
        roundPubkey,
        blindNoncePoints,
        credentialContext,
        params.feerate
      );
      // Kept for the blame phase only. Never sent unless the round aborts.
      myOutputSerials = outputSerials;
      myComponentOpenings = componentOpenings;
      myInputOpenings = params.myContribution.inputs.map((input, i) => ({
        outpoint: inputKey(input),
        slotIndex: requests[i].index,
        // Capture before finalizeHex — same a||b the verifier recomputes.
        openingHex: pending[i].openingHex(),
      }));
      const myInputSalts = inputSaltCommitments;
      const myOutputSalts = outputSaltCommitments;
      const responseWait = waitCredResponse();
      params.onStatus?.('Requesting blind credentials from coordinator…');
      await transport.send(coordinator, {
        ...messageBinding(),
        type: 'credential_request',
        session,
        requests,
        amountCommitments,
        componentCommitments,
        pedersenTotalNonce,
        excessFee,
        inputCount: params.myContribution.inputs.length,
        outputCount: params.myContribution.outputs.length,
      });
      const responses = await waitWithTimeout(
        responseWait,
        CREDENTIAL_WAIT_MS,
        'Timed out waiting for credential response',
        'Coordinator may not have received our credential_request over Tor — ' +
          'Auto will retry shortly.'
      );
      const byIndex = new Map(responses.map((r) => [r.index, r.s]));
      const credentialSigs: string[] = [];
      for (let i = 0; i < pending.length; i++) {
        const index = requests[i].index;
        const s = byIndex.get(index);
        if (!s)
          throw new Error(`missing credential response for slot ${index}`);
        credentialSigs.push(pending[i].finalizeHex(s, true));
      }
      const outputCredentialSigs = credentialSigs.slice(
        params.myContribution.inputs.length
      );

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
          saltCommitments: [myInputSalts[i]],
        });
        await jitterDelay(jMin, jMax);
      }
      // Phase 3: onion outputs (always — rounds are ≥3 peers, ≥2 peelers).
      // mixOrder excludes the coordinator (assembles, does not peel).
      if (mixOrder.length < 2) {
        throw new Error(
          'onion mix-net requires ≥2 peelers (need ≥3 participants)'
        );
      }
      if (!isEccAvailable()) {
        throw new Error(
          'onion mix-net requires secp256k1 (unavailable in this environment)'
        );
      }
      const myOutputs: AuthorizedOnionOutput[] =
        params.myContribution.outputs.map((output, index) => ({
          ...output,
          credentialSerial: outputSerials[index],
          credentialSig: outputCredentialSigs[index],
          saltCommitment: myOutputSalts[index],
        }));
      // Self is a peeler; don't wait for our own gift-wrap echo.
      declaredOnionCounts.set(params.myPubkey, myOutputs.length);
      params.onPhase?.(3);
      params.onStatus?.(
        `Onion mix: injecting ${myOutputs.length} output(s) via ${mixOrder.length} peeler(s)…`
      );
      const sendDeclare = async () => {
        // Fresh binding each time so nonce dedup does not drop re-sends.
        const declare: RoundMessage = {
          ...messageBinding(),
          type: 'onion_declare',
          session,
          outputCount: myOutputs.length,
        };
        // allSettled: one unreachable peeler must not block declare to others.
        await Promise.allSettled(
          mixOrder
            .filter((peeler) => peeler !== params.myPubkey)
            .map((peeler) => transport.send(peeler, declare))
        );
      };
      await sendDeclare();
      // Bounded declare re-sends (open-ended interval made rounds feel ~90s).
      let declareResendsLeft = ONION_DECLARE_RESEND_MAX;
      declareResendTimer = setInterval(() => {
        if (settled || onionBatchDone || declareResendsLeft <= 0) {
          if (declareResendTimer) {
            clearInterval(declareResendTimer);
            declareResendTimer = null;
          }
          return;
        }
        declareResendsLeft -= 1;
        void sendDeclare().catch(() => undefined);
      }, ONION_DECLARE_RESEND_MS);
      const firstPeeler = mixOrder[0];
      // Cache inject payloads so we can re-send after Tor drops (new nonces).
      const injectPayloads: string[] = [];
      for (const output of myOutputs) {
        const payload = encodeAuthorizedOutput(output);
        const onion = await onionWrap(payload, mixOrder);
        injectPayloads.push(btoa(String.fromCharCode(...onion)));
      }
      // Resend path: no per-blob jitter (keeps recovery fast).
      let injectSendInFlight: Promise<void> | null = null;
      const sendInjectsRemote = (withJitter: boolean): Promise<void> => {
        if (injectSendInFlight) return injectSendInFlight;
        const run = (async () => {
          try {
            for (const onionB64 of injectPayloads) {
              await transport.send(firstPeeler, {
                ...messageBinding(),
                type: 'onion_output',
                session,
                onion: onionB64,
                mixOrder,
              });
              if (withJitter) await jitterDelay(jMin, jMax);
            }
          } finally {
            injectSendInFlight = null;
          }
        })();
        injectSendInFlight = run;
        return run;
      };
      // If we are first peeler, feed locally once only (no self gift-wrap).
      // Re-sends would double-count blobs in collectedOnions.
      if (firstPeeler === params.myPubkey) {
        for (const onionB64 of injectPayloads) {
          handleOnionMessage(params.myPubkey, {
            ...messageBinding(),
            type: 'onion_output',
            session,
            onion: onionB64,
            mixOrder,
          });
        }
      } else {
        await sendInjectsRemote(true);
        // Bounded hop re-sends only (not forever — that flooded Tor).
        let outputResendsLeft = ONION_OUTPUT_RESEND_MAX;
        onionOutputResendTimer = setInterval(() => {
          if (settled || onionBatchDone || signed || outputResendsLeft <= 0) {
            if (onionOutputResendTimer) {
              clearInterval(onionOutputResendTimer);
              onionOutputResendTimer = null;
            }
            return;
          }
          if (injectSendInFlight) return;
          outputResendsLeft -= 1;
          void sendInjectsRemote(false).catch(() => undefined);
        }, ONION_OUTPUT_RESEND_MS);
      }
      if (myIdx >= 0) {
        onionStatusTimer = setInterval(reportOnionWait, 4_000);
        reportOnionWait();
      }
      // Ready after inject; coordinator still waits for last peeler's reveal.
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
  const mixOrder =
    params.mixOrder ??
    [...params.participants].filter((p) => p !== params.myPubkey).sort();

  // Coordinator is the blind-Schnorr issuer for this round (server role, peer-hosted).
  let issuer: BlindIssuer;
  let selfAuthorizedOutputs: AuthorizedOnionOutput[] = [];
  let selfIssueOk = true;
  let selfIssueError: Error | null = null;
  try {
    issuer = BlindIssuer.create(
      totalCredentialSlots(params.participants.length)
    );
    const selfBuilt = buildComponentCredentialRequests(
      params.myContribution,
      params.participants,
      params.myPubkey,
      issuer.pubkeyHex,
      issuer.rPointsHex,
      { session, network: params.network ?? 'chipnet', tier: params.tier },
      params.feerate
    );
    const selfSigs: string[] = [];
    for (let i = 0; i < selfBuilt.pending.length; i++) {
      const index = selfBuilt.requests[i].index;
      const s = issuer.signHex(index, selfBuilt.requests[i].e);
      selfSigs.push(selfBuilt.pending[i].finalizeHex(s, true));
    }
    selfAuthorizedOutputs = params.myContribution.outputs.map((output, i) => ({
      ...output,
      credentialSerial: selfBuilt.outputSerials[i],
      credentialSig: selfSigs[params.myContribution.inputs.length + i],
      saltCommitment: selfBuilt.outputSaltCommitments[i],
    }));
    if (
      !pedersenBalanceHolds(
        selfBuilt.amountCommitments,
        selfBuilt.excessFee,
        selfBuilt.pedersenTotalNonce
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
    /**
     * Inputs that arrived under a throwaway key, exactly like
     * `anonymousOutputBatches` below. A valid blind credential proves the
     * sender was admitted to this round; it deliberately does NOT say which
     * peer sent it, so these are never keyed by pubkey.
     */
    const anonymousInputs: FusionInputRef[] = [];
    /**
     * Post-abort component disclosures, keyed by the peer's ROUND identity —
     * disclosure is control plane, so `from` is attributable. First disclosure
     * per peer wins; a second is ignored rather than allowed to overwrite.
     */
    const disclosuresByPeer = new Map<string, ComponentDisclosure>();
    /**
     * Blinded challenges `e` the coordinator actually signed, keyed by slot.
     * Required to verify post-abort openings (C3): without the retained `e`,
     * `verifyCredentialOpening` has nothing honest to compare against.
     */
    const signedChallengeBySlot = new Map<number, string>();
    const componentCommitmentsByPeer = new Map<
      string,
      Map<number, { saltedComponentHash: string; amountCommitment: string }>
    >();
    /** Outpoint → salt_commitment used when the input credential was verified. */
    const saltCommitmentByOutpoint = new Map<string, string>();
    const inputPool = (): FusionInputRef[] => [
      ...[...inputsByPeer.values()].flat(),
      ...anonymousInputs,
    ];
    /**
     * Total inputs this round must collect. Credential REQUESTS stay
     * attributed (`inputQuotaByPeer`, seeded with the coordinator's own count),
     * so the coordinator knows how many each peer may submit without learning
     * which anonymous input is whose.
     */
    const expectedInputCount = (): number =>
      [...inputQuotaByPeer.values()].reduce((sum, n) => sum + n, 0);
    if (mixOrder.length < 2) {
      return Promise.reject(
        new Error('onion mix-net requires ≥2 peelers (need ≥3 participants)')
      );
    }
    // Output registry: pool fills when the last peeler reveals (anonymous
    // gift-wraps — `from` is not a round identity).
    const outputsByPeer = new Map<string, FusionOutputRef[]>();
    const anonymousOutputBatches: AuthorizedOnionOutput[][] = [];
    const outputPool = (): FusionOutputRef[] => [
      ...[...outputsByPeer.values()].flat(),
      ...anonymousOutputBatches.flat(),
    ];
    /**
     * How many output *delivery slots* are filled. Onion reveal is one final
     * anonymous batch for the whole round (not one batch per participant) —
     * comparing filled to `participants.length` falsely reported stalls as
     * `outputSlots=1/4` after a successful peel (E1).
     */
    const outputSlotsFilled = (): number => {
      const attributed = [...outputsByPeer.entries()].filter(
        ([, outs]) => outs.length > 0
      ).length;
      return attributed + anonymousOutputBatches.length;
    };
    /** Expected slots once the mix-net is on: one reveal batch (plus any attributed). */
    const expectedOutputSlots = (): number =>
      mixOrder.length >= 2
        ? Math.max(1, outputSlotsFilled() || 1)
        : params.participants.length;
    const signaturesByOutpoint = new Map<string, InputSig>();
    const signedPeers = new Set<string>();
    const seenNonces = new Set<string>();
    // Do NOT mark the coordinator ready until its own onions are injected.
    const readyPeers = new Set<string>();
    const credentialedPeers = new Set<string>([params.myPubkey]);
    const outputQuotaByPeer = new Map<string, number>([
      [params.myPubkey, params.myContribution.outputs.length],
    ]);
    const inputQuotaByPeer = new Map<string, number>([
      [params.myPubkey, params.myContribution.inputs.length],
    ]);
    let assembled: {
      inputs: FusionInputRef[];
      outputs: FusionOutputRef[];
    } | null = null;
    let assembling = false;
    let finalizing = false;
    let broadcastStarted = false;
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeProtocolError: () => void = () => undefined;
    let declareResendTimer: ReturnType<typeof setInterval> | null = null;
    let credParamsResendTimer: ReturnType<typeof setInterval> | null = null;
    let onionOutputResendTimer: ReturnType<typeof setInterval> | null = null;
    let assembledResendTimer: ReturnType<typeof setInterval> | null = null;
    let sigWaitStatusTimer: ReturnType<typeof setInterval> | null = null;
    /** Fail if ready peers never deliver outputs (log evidence: ready 3/3 outputs 0). */
    let missingOutputsTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (missingOutputsTimer) clearTimeout(missingOutputsTimer);
      if (declareResendTimer) {
        clearInterval(declareResendTimer);
        declareResendTimer = null;
      }
      if (credParamsResendTimer) {
        clearInterval(credParamsResendTimer);
        credParamsResendTimer = null;
      }
      if (onionOutputResendTimer) {
        clearInterval(onionOutputResendTimer);
        onionOutputResendTimer = null;
      }
      if (assembledResendTimer) {
        clearInterval(assembledResendTimer);
        assembledResendTimer = null;
      }
      if (sigWaitStatusTimer) {
        clearInterval(sigWaitStatusTimer);
        sigWaitStatusTimer = null;
      }
      params.signal?.removeEventListener('abort', onCancel);
      unsubscribe();
      unsubscribeProtocolError();
    };
    /**
     * Wait for peers to answer our abort with their component disclosures.
     * Resolves as soon as everyone has answered, at the ceiling, or the moment
     * the caller cancels — whichever comes first. The transport subscription is
     * still live here on purpose; `cleanup()` runs after we return.
     */
    const awaitDisclosures = () =>
      new Promise<void>((resolveWait) => {
        if (disclosuresByPeer.size >= others.length) return resolveWait();
        const deadline = Date.now() + BLAME_WINDOW_MS;
        const finish = () => {
          clearInterval(poll);
          params.signal?.removeEventListener('abort', finish);
          resolveWait();
        };
        const poll = setInterval(() => {
          if (disclosuresByPeer.size >= others.length || Date.now() >= deadline)
            finish();
        }, BLAME_POLL_MS);
        params.signal?.addEventListener('abort', finish, { once: true });
      });
    /**
     * Electron Cash blame phase for the anonymous component plane.
     *
     * Components arrived under throwaway keys, so a failed round has no accused
     * until the peers say what they contributed. Cross-referencing those
     * disclosures under the round identity restores attribution for the codes
     * `d9accdbd` cost us. Diagnosis only — the accused is an ephemeral key, so
     * this identifies a fault, it does not exclude anyone.
     */
    /**
     * Prove openings before cross-check. Drop unproven outpoints; if a peer
     * *claims* an outpoint with a bad opening, that is
     * `invalid_input_credential` (C4) — not silent ignore.
     */
    const verifiedDisclosures = (): {
      verified: Map<string, ComponentDisclosure>;
      credentialFault: DisclosureFinding | null;
      componentFault: DisclosureFinding | null;
    } => {
      const verified = new Map<string, ComponentDisclosure>();
      const poolByKey = new Map(
        anonymousInputs.map((input) => [inputKey(input), input] as const)
      );
      const outputBySerial = new Map(
        anonymousOutputBatches
          .flat()
          .map(
            (output) => [output.credentialSerial.toLowerCase(), output] as const
          )
      );
      let credentialFault: DisclosureFinding | null = null;
      let componentFault: DisclosureFinding | null = null;
      for (const peer of [...params.participants].sort()) {
        if (peer === params.myPubkey) continue;
        const raw = disclosuresByPeer.get(peer);
        if (!raw) continue;
        const base = peerCredentialSlotBase(params.participants, peer);
        const proven: string[] = [];
        const failedOpenings: NonNullable<
          Extract<
            BlameEvidence,
            { kind: 'invalid_input_credential' }
          >['failedOpenings']
        > = [];
        const failedInputs: FusionInputRef[] = [];
        for (const opening of raw.openings ?? []) {
          if (!raw.outpoints.includes(opening.outpoint)) continue;
          const input = poolByKey.get(opening.outpoint);
          const requestHex = signedChallengeBySlot.get(opening.slotIndex);
          const rPointHex = issuer.rPointsHex[opening.slotIndex];
          const slotOk =
            opening.slotIndex >= base &&
            opening.slotIndex < base + CREDENTIAL_SLOTS_PER_PEER;
          const saltCommitment = saltCommitmentByOutpoint.get(opening.outpoint);
          const ok =
            !!input &&
            !!requestHex &&
            !!rPointHex &&
            !!saltCommitment &&
            slotOk &&
            verifyCredentialOpening({
              roundPubkeyHex: issuer.pubkeyHex,
              rPointHex,
              messageHash: inputCredentialMessageHash(input, saltCommitment),
              openingHex: opening.openingHex,
              requestHex,
            });
          if (ok) {
            if (!proven.includes(opening.outpoint))
              proven.push(opening.outpoint);
            continue;
          }
          // Peer claimed this outpoint with a non-proof — accuse, don't only drop.
          if (input && requestHex && rPointHex && saltCommitment) {
            failedInputs.push(input);
            failedOpenings.push({
              outpoint: opening.outpoint,
              slotIndex: opening.slotIndex,
              openingHex: opening.openingHex,
              requestHex,
              rPointHex,
              saltCommitmentHex: saltCommitment,
            });
          } else if (input) {
            // Slot OOB or missing coordinator state: still an invalid claim.
            failedInputs.push(input);
            failedOpenings.push({
              outpoint: opening.outpoint,
              slotIndex: opening.slotIndex,
              openingHex: opening.openingHex,
              requestHex: requestHex ?? '00'.repeat(32),
              rPointHex:
                rPointHex ?? issuer.rPointsHex[0] ?? '02' + '00'.repeat(32),
              saltCommitmentHex:
                saltCommitment ??
                saltCommitmentByOutpoint.values().next().value ??
                '00'.repeat(32),
            });
          }
        }
        if (failedOpenings.length > 0 && !credentialFault) {
          credentialFault = {
            accused: peer,
            code: 'invalid_input_credential',
            evidence: {
              kind: 'invalid_input_credential',
              roundPubkey: issuer.pubkeyHex,
              inputs: failedInputs,
              credentialSigs: [],
              failedOpenings,
            },
          };
        }
        for (const opening of raw.componentOpenings ?? []) {
          if (componentFault) break;
          const requestHex = signedChallengeBySlot.get(opening.slotIndex);
          const rPointHex = issuer.rPointsHex[opening.slotIndex];
          const initial = componentCommitmentsByPeer
            .get(peer)
            ?.get(opening.slotIndex);
          const slotOk =
            opening.slotIndex >= base &&
            opening.slotIndex < base + CREDENTIAL_SLOTS_PER_PEER;
          if (!requestHex || !rPointHex || !initial || !slotOk) continue;

          let evidence: Extract<
            BlameEvidence,
            { kind: 'invalid_component_commitment' }
          > | null = null;
          if (opening.kind === 'input') {
            const input = poolByKey.get(opening.outpoint);
            const saltCommitmentHex = saltCommitmentByOutpoint.get(
              opening.outpoint
            );
            if (input && saltCommitmentHex) {
              evidence = {
                kind: 'invalid_component_commitment',
                feerate: params.feerate,
                component: { kind: 'input', input, saltCommitmentHex },
                saltHex: opening.saltHex,
                pedersenNonceHex: opening.pedersenNonceHex,
                initialCommitment: initial,
                roundPubkey: issuer.pubkeyHex,
                rPointHex,
                requestHex,
                openingHex: opening.openingHex,
              };
            }
          } else {
            const output = outputBySerial.get(
              opening.credentialSerial.toLowerCase()
            );
            if (output) {
              evidence = {
                kind: 'invalid_component_commitment',
                feerate: params.feerate,
                component: {
                  kind: 'output',
                  output: { script: output.script, value: output.value },
                  saltCommitmentHex: output.saltCommitment,
                  credentialSerial: output.credentialSerial,
                },
                saltHex: opening.saltHex,
                pedersenNonceHex: opening.pedersenNonceHex,
                initialCommitment: initial,
                roundPubkey: issuer.pubkeyHex,
                rPointHex,
                requestHex,
                openingHex: opening.openingHex,
              };
            }
          }
          if (
            evidence &&
            componentCredentialOpeningMatches(evidence) &&
            !componentCommitmentOpeningMatches(evidence)
          ) {
            componentFault = {
              accused: peer,
              code: 'invalid_component_commitment',
              evidence,
            };
          }
        }
        verified.set(peer, {
          outpoints: proven,
          serials: [...raw.serials],
          openings: raw.openings,
          componentOpenings: raw.componentOpenings,
        });
      }
      return { verified, credentialFault, componentFault };
    };
    const runBlamePhase = async () => {
      // Nothing anonymous ever arrived, so there is nothing a disclosure could
      // attribute — `findFaultInDisclosures` would return null and we would
      // have spent the whole window to learn it. A round that dies in the
      // control plane still fails immediately.
      if (anonymousInputs.length === 0 && signaturesByOutpoint.size === 0)
        return;
      await awaitDisclosures();
      const { verified, credentialFault, componentFault } =
        verifiedDisclosures();
      // Bad openings first (C4): a forged proof is itself the fault.
      const finding =
        componentFault ??
        credentialFault ??
        findFaultInDisclosures({
          participants: [...params.participants],
          disclosures: verified,
          signedOutpoints: new Set(signaturesByOutpoint.keys()),
        });
      // Mutually consistent disclosures mean the round died of something that
      // is nobody's provable fault — a timeout, a dropped relay. Never blame.
      if (!finding) return;
      const report = createBlameReport(
        session,
        finding.accused,
        finding.code,
        finding.evidence
      );
      const check = verifyBlameReport(report, {
        session,
        participants: params.participants,
        feerate: params.feerate,
      });
      // Our own report must survive the same verification every peer applies,
      // or it is worse than sending nothing.
      if (check.ok === false) return;
      params.onBlame?.(report);
      params.onStatus?.(formatBlameAbortReason(report));
      const blameMsg: RoundMessage = {
        ...messageBinding(),
        type: 'blame',
        session,
        accused: finding.accused,
        code: finding.code,
        evidence: finding.evidence,
      };
      await Promise.allSettled(
        others.map((peer) => transport.send(peer, blameMsg))
      );
    };
    const fail = async (
      error: Error,
      notifyPeers: boolean,
      forceDuringBroadcast = false
    ) => {
      if (settled || (broadcastStarted && !forceDuringBroadcast)) return;
      settled = true;
      params.onStatus?.(`Round failed: ${error.message}`);
      clearRoundNullifiers(session);
      if (notifyPeers) {
        const message: RoundMessage = {
          ...messageBinding(),
          type: 'abort',
          session,
          reason: error.message.slice(0, 240),
        };
        await Promise.allSettled(
          others.map((peer) => transport.send(peer, message))
        );
        // Only after peers have been told, and only while we can still hear
        // them. A blame phase must never outlive the promise we are about to
        // settle — see BLAME_WINDOW_MS.
        await runBlamePhase().catch(() => undefined);
      }
      cleanup();
      reject(error);
    };
    /**
     * Provable fault path: broadcast blame (verifiable evidence), then abort.
     * Never use for timeouts / missing messages / late join.
     */
    const blameAndFail = async (
      accused: string,
      code: BlameCode,
      evidence: BlameEvidence
    ) => {
      if (settled) return;
      const report = createBlameReport(session, accused, code, evidence);
      const check = verifyBlameReport(report, {
        session,
        participants: params.participants,
        feerate: params.feerate,
      });
      if (check.ok === false) {
        void fail(
          new Error(`internal blame failed verification: ${check.reason}`),
          true
        );
        return;
      }
      params.onBlame?.(report);
      const reason = formatBlameAbortReason(report);
      params.onStatus?.(reason);
      const blameMsg: RoundMessage = {
        ...messageBinding(),
        type: 'blame',
        session,
        accused,
        code,
        evidence,
      };
      // Mark settled before fan-out so re-entry is ignored.
      settled = true;
      cleanup();
      await Promise.allSettled(
        others.map((peer) => transport.send(peer, blameMsg))
      );
      // Also plain abort for older peers / clarity.
      const abortMsg: RoundMessage = {
        ...messageBinding(),
        type: 'abort',
        session,
        reason: reason.slice(0, 240),
      };
      await Promise.allSettled(
        others.map((peer) => transport.send(peer, abortMsg))
      );
      reject(new Error(reason));
    };
    const succeed = (result: RoundResult) => {
      if (settled) return;
      settled = true;
      params.onStatus?.(
        `Fused ✓ — txid ${result.txid.slice(0, 16)}… (confirming on wallet)`
      );
      cleanup();
      clearRoundNullifiers(session);
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
        message.requests.length !== message.inputCount + message.outputCount ||
        message.amountCommitments.length !== message.requests.length ||
        message.componentCommitments.length !== message.requests.length
      ) {
        throw new Error('credential component counts do not match commitments');
      }
      if (
        !pedersenBalanceHolds(
          message.amountCommitments,
          message.excessFee,
          message.pedersenTotalNonce
        )
      ) {
        await blameAndFail(from, 'pedersen_unbalanced', {
          kind: 'pedersen_unbalanced',
          amountCommitments: message.amountCommitments,
          pedersenTotalNonce: message.pedersenTotalNonce,
          excessFee: message.excessFee,
        });
        return;
      }
      // Slots must lie in this peer's reserved range.
      const base = peerCredentialSlotBase(params.participants, from);
      const slots = message.requests.map((r) => r.index);
      for (const req of message.requests) {
        if (req.index < base || req.index >= base + CREDENTIAL_SLOTS_PER_PEER) {
          await blameAndFail(from, 'credential_slot_oob', {
            kind: 'credential_slot_oob',
            slots,
            participants: [...params.participants],
          });
          return;
        }
      }
      const responses: Array<{ index: number; s: string }> = [];
      const peerCommitments = new Map<
        number,
        { saltedComponentHash: string; amountCommitment: string }
      >();
      for (const commitment of message.componentCommitments) {
        peerCommitments.set(commitment.index, {
          saltedComponentHash: commitment.saltedComponentHash.toLowerCase(),
          amountCommitment: commitment.amountCommitment.toLowerCase(),
        });
      }
      componentCommitmentsByPeer.set(from, peerCommitments);
      for (const req of message.requests) {
        // Retain `e` for opening verification on abort (C3).
        signedChallengeBySlot.set(req.index, req.e);
        responses.push({
          index: req.index,
          s: issuer.signHex(req.index, req.e),
        });
      }
      credentialedPeers.add(from);
      inputQuotaByPeer.set(from, message.inputCount);
      outputQuotaByPeer.set(from, message.outputCount);
      await transport.send(from, {
        ...messageBinding(),
        type: 'credential_response',
        session,
        responses,
      });
    };

    /** Accept inputs only when every credential verifies under the round pubkey. */
    /**
     * Accept a credentialed input WITHOUT knowing who sent it.
     *
     * Admission is proved by the blind credential, not by sender identity:
     * only a peer the coordinator issued a credential to can produce a
     * signature that verifies under the round pubkey for this exact outpoint.
     * That is the whole point of the blind-Schnorr design, and checking
     * `others.includes(from)` on top of it is what used to re-group a peer's
     * inputs.
     */
    const acceptInputs = async (
      inputs: FusionInputRef[],
      sigs: string[],
      saltCommitments: string[]
    ) => {
      if (
        inputs.length !== sigs.length ||
        inputs.length !== saltCommitments.length
      ) {
        throw new Error('input/credential/salt count mismatch');
      }
      // Global quota. Per-peer quotas still bound how many credentials each
      // peer was issued; the sum is how many valid inputs may ever arrive.
      if (inputPool().length + inputs.length > expectedInputCount()) {
        throw new Error('input credential quota exceeded');
      }
      for (let i = 0; i < inputs.length; i++) {
        const msgHex = inputCredentialMessageHashHex(
          inputs[i],
          saltCommitments[i]
        );
        if (!verifyBchSchnorrHex(issuer.pubkeyHex, sigs[i], msgHex)) {
          // No accused: an anonymous component has no participant to blame, and
          // verifyBlameReport rejects an accused outside the participant set.
          // Electron Cash has the same property for covert components.
          throw new Error('invalid input credential');
        }
      }
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i];
        const key = inputKey(inp);
        // credentialedInputs already holds every accepted outpoint, so a
        // replay is caught without scanning a per-peer map.
        if (credentialedInputs.has(key)) {
          throw new Error('duplicate outpoint in round');
        }
        credentialedInputs.add(key);
        saltCommitmentByOutpoint.set(key, saltCommitments[i].toLowerCase());
      }
      anonymousInputs.push(...inputs);
    };

    const tryFinalize = async () => {
      if (
        settled ||
        finalizing ||
        !assembled ||
        // Signature COUNT is the gate, not peer count: anonymous signatures
        // carry no identity, and every assembled input needs exactly one.
        signaturesByOutpoint.size !== assembled.inputs.length
      ) {
        if (
          assembled &&
          !finalizing &&
          !settled &&
          signedPeers.size < others.length
        ) {
          params.onStatus?.(
            `Waiting for signatures ${signedPeers.size}/${others.length} ` +
              `(inputs signed ${signaturesByOutpoint.size}/${assembled.inputs.length})…`
          );
        }
        return;
      }
      finalizing = true;
      if (assembledResendTimer) {
        clearInterval(assembledResendTimer);
        assembledResendTimer = null;
      }
      if (sigWaitStatusTimer) {
        clearInterval(sigWaitStatusTimer);
        sigWaitStatusTimer = null;
      }
      params.onPhase?.(5);
      params.onStatus?.('All signatures in — finalizing and broadcasting…');
      const tx = assembleFusionTx([assembled]);
      const finalized = finalizeFusionTx(tx, [
        ...signaturesByOutpoint.values(),
      ]);

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
      params.onPhase?.(7);
      const broadcastId = (
        await params.broadcast(finalized.txHex)
      ).toLowerCase();
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
      // Onion reveal: one multi-output batch is enough — but only if fee is
      // sane. Partial/duplicate peels used to pass `pool.length > 0` and then
      // hard-fail assemble (negative fee). Wait for a balanced pool instead.
      const pool = outputPool();
      if (pool.length === 0) return false;
      // Count inputs, not peers: an anonymous input carries no identity, so
      // "every participant submitted" is expressed as "every issued credential
      // came back".
      if (inputPool().length !== expectedInputCount()) return false;
      const inputs = inputPool();
      if (inputs.length === 0) return false;
      const totalIn = inputs.reduce((s, i) => s + i.value, 0);
      const totalOut = pool.reduce((s, o) => s + o.value, 0);
      const fee = totalIn - totalOut;
      if (fee < 0) return false;
      const roughMax =
        Math.ceil(
          ((10 + inputs.length * 150 + pool.length * 40) * params.feerate) /
            1000
        ) * 3;
      return fee <= Math.max(roughMax, 50_000);
    };

    const armMissingOutputsWatch = () => {
      if (missingOutputsTimer || settled || assembled) return;
      missingOutputsTimer = setTimeout(() => {
        if (settled || assembled) return;
        if (readyPeers.size === params.participants.length && !outputsReady()) {
          const peelers = mixOrder.length;
          void fail(
            new Error(
              `All ${params.participants.length} peers marked ready but outputs ` +
                `never arrived (outputSlots=${outputSlotsFilled()}/` +
                `${expectedOutputSlots()}, anonBatches=` +
                `${anonymousOutputBatches.length}, pool=${outputPool().length}, ` +
                `onion=on, peelers=${peelers}). ` +
                'Onion peel stalled (missing declare or hop blob over Tor). ' +
                'Hop gift-wraps failed to complete — auto will retry; manual: Start again when peers are online.'
            ),
            true
          );
        }
      }, MISSING_OUTPUTS_ONION_MS);
    };

    const tryAssemble = async () => {
      const pool = outputPool();
      if (!settled && !assembled) {
        console.info(
          '[p2p-fusion coord] session',
          session.slice(0, 10),
          'inputs',
          inputPool().length,
          '/',
          expectedInputCount(),
          'outputs',
          outputSlotsFilled(),
          '/',
          expectedOutputSlots(),
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
      // Every peer must have been issued credentials, and every issued
      // credential must have come back. Deliberately a COUNT, not a per-peer
      // tally: an anonymous input carries no pubkey, so `inputsByPeer.get(peer)`
      // is empty for every peer but the coordinator and could never match.
      if (
        inputQuotaByPeer.size !== params.participants.length ||
        inputPool().length !== expectedInputCount()
      ) {
        return;
      }
      const inputs = inputPool();
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
      params.onStatus?.('Assembling CoinJoin — signing our inputs…');
      const ownSignatures = await assembleVerifySign(
        params,
        assembled.inputs,
        assembled.outputs
      );
      params.onPhase?.(6);
      ownSignatures.forEach((signature) =>
        signaturesByOutpoint.set(inputKey(signature), signature)
      );
      const sendAssembled = () =>
        Promise.all(
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
      params.onStatus?.(
        `Published assembled tx — waiting for ${others.length} signature set(s)…`
      );
      await sendAssembled();
      // Re-offer assembled so Tor-lagged peers still sign (live: all hit phase 6
      // then round vanished — incomplete sig set + silent timeout).
      if (assembledResendTimer) clearInterval(assembledResendTimer);
      assembledResendTimer = setInterval(() => {
        if (settled || finalizing) return;
        void sendAssembled().catch(() => undefined);
      }, P2P_ASSEMBLED_RESEND_MS);
      if (sigWaitStatusTimer) clearInterval(sigWaitStatusTimer);
      sigWaitStatusTimer = setInterval(() => {
        if (settled || finalizing || !assembled) return;
        params.onStatus?.(
          `Waiting for signatures ${signedPeers.size}/${others.length} ` +
            `(inputs ${signaturesByOutpoint.size}/${assembled.inputs.length})…`
        );
      }, P2P_SIG_STATUS_MS);
      await tryFinalize();
    };

    unsubscribe = transport.onMessage((from, message) => {
      if (message.session !== session) return;
      // Handled BEFORE the settled guard on purpose: a disclosure only ever
      // arrives after the round aborted, which is exactly when `settled` is
      // already true. Dropping it here would leave the blame phase with
      // nothing to cross-reference.
      if (
        message.type === 'component_disclosure' &&
        params.participants.includes(from)
      ) {
        if (!disclosuresByPeer.has(from)) {
          disclosuresByPeer.set(from, {
            outpoints: [...message.outpoints],
            serials: [...message.serials],
            openings: message.openings
              ? message.openings.map((entry) => ({
                  outpoint: entry.outpoint,
                  slotIndex: entry.slotIndex,
                  openingHex: entry.openingHex,
                }))
              : [],
            componentOpenings: message.componentOpenings
              ? message.componentOpenings.map((entry) => ({ ...entry }))
              : [],
          });
        }
        return;
      }
      if (settled) return;
      if (seenNonces.has(message.nonce)) return;
      seenNonces.add(message.nonce);
      if (message.type === 'credential_request' && others.includes(from)) {
        void handleCredentialRequest(from, message).catch(
          (error: unknown) => void fail(asError(error), true)
        );
        return;
      }
      if (message.type === 'components_ready' && others.includes(from)) {
        readyPeers.add(from);
        if (readyPeers.size === params.participants.length) {
          armMissingOutputsWatch();
        }
        void tryAssemble().catch(
          (error: unknown) => void fail(asError(error), true)
        );
        return;
      }
      if (message.type === 'abort' && others.includes(from)) {
        void fail(abortError(message.reason), true);
        return;
      }
      if (message.type === 'blame' && params.participants.includes(from)) {
        const report: BlameReport = {
          session: message.session,
          accused: message.accused,
          code: message.code,
          evidence: message.evidence,
        };
        const check = verifyBlameReport(report, {
          session,
          participants: params.participants,
          feerate: params.feerate,
        });
        if (!check.ok) return; // ignore unverifiable frame attempts
        params.onBlame?.(report);
        void fail(new Error(formatBlameAbortReason(report)), false);
        return;
      }
      // No `others.includes(from)`: inputs arrive under a throwaway key by
      // design, so `from` is a random one-time pubkey. The blind credential
      // checked inside acceptInputs is the admission proof.
      if (message.type === 'inputs') {
        void acceptInputs(
          message.inputs,
          message.credentialSigs,
          message.saltCommitments
        )
          .then(() => {
            if (settled) return;
            return tryAssemble();
          })
          .catch((error: unknown) => void fail(asError(error), true));
        return;
      }
      if (message.type === 'outputs') {
        if (assembled) return;
        const incoming = Array.isArray(message.outputs) ? message.outputs : [];
        const expected = [...outputQuotaByPeer.values()].reduce(
          (sum, count) => sum + count,
          0
        );
        if (
          params.participants.includes(from) ||
          outputQuotaByPeer.size !== params.participants.length ||
          anonymousOutputBatches.length !== 0 ||
          incoming.length !== expected
        ) {
          void fail(
            new Error('unauthorized output batch count or sender'),
            true
          );
          return;
        }
        const authorization = verifyAuthorizedOutputBatch(
          incoming,
          expected,
          issuer.pubkeyHex,
          {
            session,
            network: params.network ?? 'chipnet',
            tier: params.tier,
          }
        );
        if (authorization.ok === false) {
          void fail(new Error(authorization.reason), true);
          return;
        }
        if (!consumeOutputNullifiers(session, authorization.serials)) {
          void fail(new Error('replayed output credential nullifier'), true);
          return;
        }
        // Last peeler reveals under a throwaway key (`from` ∉ participants).
        {
          anonymousOutputBatches.push(incoming);
          console.info(
            '[p2p-fusion coord] onion reveal batch',
            incoming.length,
            'outputs; batches',
            anonymousOutputBatches.length,
            '/',
            others.length
          );
        }
        void tryAssemble().catch(
          (error: unknown) => void fail(asError(error), true)
        );
        return;
      }
      // Signatures are anonymous too. Anonymising registration and then
      // accepting a signature SET under a round identity would re-group the
      // very inputs just separated, so each signature is validated against an
      // assembled input rather than against "this peer's expected set".
      if (message.type === 'signature' && assembled) {
        const assembledKeys = new Set(assembled.inputs.map(inputKey));
        const receivedKeys = new Set(message.sigs.map(inputKey));
        if (
          receivedKeys.size !== message.sigs.length ||
          [...receivedKeys].some((key) => !assembledKeys.has(key))
        ) {
          // Unattributable by construction — drop the frame rather than blame
          // a throwaway key that is not in the participant set.
          return;
        }
        message.sigs.forEach((signature) =>
          signaturesByOutpoint.set(inputKey(signature), signature)
        );
        void tryFinalize().catch(
          (error: unknown) => void fail(asError(error), true, true)
        );
      }
    });
    unsubscribeProtocolError =
      transport.onProtocolError?.((from, error) => {
        if (others.includes(from)) void fail(error, true);
      }) ?? (() => undefined);

    params.signal?.addEventListener('abort', onCancel, { once: true });
    const timer = setTimeout(
      () =>
        void fail(
          new Error(
            `fusion round timed out (coord: sigs ${signedPeers.size}/${others.length}, ` +
              `assembled=${Boolean(assembled)}, finalizing=${finalizing}). ` +
              'Usually missing peer signatures or final over Tor.'
          ),
          true
        ),
      params.timeoutMs ?? DEFAULT_TIMEOUT
    );
    params.onPhase?.(2);
    params.onStatus?.(
      `Coordinator: publishing credentials to ${others.length} peer(s)…`
    );

    // Publish issuer params first so peers can request credentials. Then
    // (onion mode) send our own outputs through the mix-net.
    // Tor gift-wrap often drops the first params to one peer (live: 15s
    // "waiting for coordinator credentials" while another peer already onioned).
    void (async () => {
      const paramsMsg: RoundMessage = {
        ...messageBinding(),
        type: 'credential_params',
        session,
        roundPubkey: issuer.pubkeyHex,
        blindNoncePoints: issuer.rPointsHex,
      };
      const peersStillNeedParams = () =>
        others.filter((peer) => !credentialedPeers.has(peer));
      const sendCredParams = async (targets: string[]) => {
        if (targets.length === 0) return;
        await Promise.allSettled(
          targets.map((peer) => transport.send(peer, paramsMsg))
        );
      };
      await sendCredParams(others);
      let credParamsResendsLeft = CREDENTIAL_PARAMS_RESEND_MAX;
      credParamsResendTimer = setInterval(() => {
        if (settled || credParamsResendsLeft <= 0) {
          if (credParamsResendTimer) {
            clearInterval(credParamsResendTimer);
            credParamsResendTimer = null;
          }
          return;
        }
        const pending = peersStillNeedParams();
        if (pending.length === 0) {
          if (credParamsResendTimer) {
            clearInterval(credParamsResendTimer);
            credParamsResendTimer = null;
          }
          return;
        }
        credParamsResendsLeft -= 1;
        void sendCredParams(pending).catch(() => undefined);
      }, CREDENTIAL_PARAMS_RESEND_MS);
      params.onStatus?.(
        `Coordinator: waiting for ${others.length} peer(s) to register inputs…`
      );

      // Always inject coordinator outputs through the onion mix-net.
      const jMin = params.jitterMs?.[0] ?? 200;
      const jMax = params.jitterMs?.[1] ?? 2_000;
      const myOutputs = selfAuthorizedOutputs;
      params.onStatus?.(
        `Coordinator: onion-injecting ${myOutputs.length} output(s) to first peeler…`
      );
      const sendDeclare = async () => {
        const declare: RoundMessage = {
          ...messageBinding(),
          type: 'onion_declare',
          session,
          outputCount: myOutputs.length,
        };
        // Coordinator is never a peeler — always remote.
        await Promise.allSettled(
          mixOrder.map((peeler) => transport.send(peeler, declare))
        );
      };
      await sendDeclare();
      let declareResendsLeft = ONION_DECLARE_RESEND_MAX;
      declareResendTimer = setInterval(() => {
        if (settled || assembled || declareResendsLeft <= 0) {
          if (declareResendTimer) {
            clearInterval(declareResendTimer);
            declareResendTimer = null;
          }
          return;
        }
        declareResendsLeft -= 1;
        void sendDeclare().catch(() => undefined);
      }, ONION_DECLARE_RESEND_MS);
      const firstPeeler = mixOrder[0];
      const injectPayloads: string[] = [];
      for (const output of myOutputs) {
        const payload = encodeAuthorizedOutput(output);
        const onion = await onionWrap(payload, mixOrder);
        injectPayloads.push(btoa(String.fromCharCode(...onion)));
      }
      let injectSendInFlight: Promise<void> | null = null;
      const sendInjects = (withJitter: boolean): Promise<void> => {
        if (injectSendInFlight) return injectSendInFlight;
        const run = (async () => {
          try {
            for (const onionB64 of injectPayloads) {
              await transport.send(firstPeeler, {
                ...messageBinding(),
                type: 'onion_output',
                session,
                onion: onionB64,
                mixOrder,
              });
              if (withJitter) await jitterDelay(jMin, jMax);
            }
          } finally {
            injectSendInFlight = null;
          }
        })();
        injectSendInFlight = run;
        return run;
      };
      await sendInjects(true);
      // Bounded hop re-sends only — open-ended every 2s crushed Tor (~90s rounds).
      let outputResendsLeft = ONION_OUTPUT_RESEND_MAX;
      onionOutputResendTimer = setInterval(() => {
        if (settled || assembled || outputResendsLeft <= 0) {
          if (onionOutputResendTimer) {
            clearInterval(onionOutputResendTimer);
            onionOutputResendTimer = null;
          }
          return;
        }
        if (injectSendInFlight) return;
        outputResendsLeft -= 1;
        void sendInjects(false).catch(() => undefined);
      }, ONION_OUTPUT_RESEND_MS);
      // Ready only after our onions exist so the missing-outputs watch is fair.
      readyPeers.add(params.myPubkey);
      if (readyPeers.size === params.participants.length) {
        armMissingOutputsWatch();
      }
      void tryAssemble().catch(
        (error: unknown) => void fail(asError(error), true)
      );
    })().catch((error: unknown) => void fail(asError(error), true));
  });
}

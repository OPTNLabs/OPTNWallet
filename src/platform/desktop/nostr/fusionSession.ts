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

export type RoundMessage =
  | {
      type: 'round_proposal';
      session: string;
      network: 'mainnet' | 'chipnet';
      tier: number;
      epoch: number;
      participants: string[];
    }
  | {
      type: 'round_ack';
      session: string;
      network: 'mainnet' | 'chipnet';
      tier: number;
      epoch: number;
    }
  | {
      type: 'round_start';
      session: string;
      network: 'mainnet' | 'chipnet';
      tier: number;
      epoch: number;
      participants: string[];
    }
  | { type: 'abort'; session: string; reason: string }
  | { type: 'inputs'; session: string; inputs: FusionInputRef[] }
  | { type: 'outputs'; session: string; outputs: FusionOutputRef[] }
  | {
      type: 'assembled';
      session: string;
      inputs: FusionInputRef[];
      outputs: FusionOutputRef[];
    }
  | { type: 'signature'; session: string; sigs: InputSig[] }
  | { type: 'final'; session: string; txid: string; txHex: string };

export interface RoundTransport {
  send(toPubkey: string, msg: RoundMessage): Promise<void>;
  onMessage(handler: (from: string, msg: RoundMessage) => void): () => void;
  onProtocolError?: (handler: (from: string, error: Error) => void) => () => void;
}

const MAX_ROUND_MESSAGE_CHARS = 64 * 1024;
const MAX_PARTICIPANTS = 20;
const MAX_COMPONENTS = 100;
const MAX_SCRIPT_HEX_CHARS = 20_000;
const MAX_TX_HEX_CHARS = 200_000;
const MAX_MONEY = 21_000_000 * 100_000_000;
const HEX_64 = /^[0-9a-f]{64}$/i;
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/i;

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
      case 'inputs':
        if (!validArray(message.inputs, validInput)) return null;
        break;
      case 'outputs':
        if (!validArray(message.outputs, validOutput)) return null;
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
  /** Live round-phase updates (2=register, 3=verify, 4=sign, 5=broadcast). */
  onPhase?: (phase: number) => void;
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

  return new Promise((resolve, reject) => {
    let settled = false;
    let signed = false;
    let approved: { inputs: FusionInputRef[]; outputs: FusionOutputRef[] } | null =
      null;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeProtocolError: () => void = () => undefined;

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

    unsubscribe = transport.onMessage((from, message) => {
      if (settled || from !== coordinator || message.session !== session) return;
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
          params.onPhase?.(3);
          const signatures = assembleVerifySign(
            params,
            approved.inputs,
            approved.outputs
          );
          params.onPhase?.(4);
          void transport
            .send(coordinator, {
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
          params.onPhase?.(5);
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
      await transport.send(coordinator, {
        type: 'inputs',
        session,
        inputs: params.myContribution.inputs,
      });
      await transport.send(coordinator, {
        type: 'outputs',
        session,
        outputs: params.myContribution.outputs,
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

  return new Promise((resolve, reject) => {
    const inputsByPeer = new Map<string, FusionInputRef[]>([
      [params.myPubkey, params.myContribution.inputs],
    ]);
    const outputPool: FusionOutputRef[] = [...params.myContribution.outputs];
    const outputSenders = new Set<string>();
    const signaturesByOutpoint = new Map<string, InputSig>();
    const signedPeers = new Set<string>();
    let outputMessages = 1;
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
        // Diagnostic: shows registration progress so a phase-2 stall reveals which
        // peer's inputs/outputs never arrived (e.g. "inputs 2/3 outputs 3/3").
        console.info(
          '[p2p-fusion coord] session', session.slice(0, 10),
          'inputs', inputsByPeer.size, '/', params.participants.length,
          'outputs', outputMessages, '/', params.participants.length
        );
      }
      if (
        settled ||
        assembling ||
        assembled ||
        inputsByPeer.size !== params.participants.length ||
        outputMessages !== params.participants.length
      ) {
        return;
      }
      assembling = true;
      const inputs = [...inputsByPeer.values()].flat();
      assembled = assembleFusionTx([{ inputs, outputs: outputPool }]);
      params.onPhase?.(3);
      const ownSignatures = assembleVerifySign(
        params,
        assembled.inputs,
        assembled.outputs
      );
      params.onPhase?.(4);
      ownSignatures.forEach((signature) =>
        signaturesByOutpoint.set(inputKey(signature), signature)
      );
      await Promise.all(
        others.map((peer) =>
          transport.send(peer, {
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
      if (message.type === 'abort' && others.includes(from)) {
        void fail(abortError(message.reason), true);
        return;
      }
      if (message.type === 'inputs' && others.includes(from)) {
        if (!inputsByPeer.has(from)) inputsByPeer.set(from, message.inputs);
        void tryAssemble().catch((error: unknown) =>
          void fail(asError(error), true)
        );
        return;
      }
      if (message.type === 'outputs') {
        if (
          outputMessages >= params.participants.length ||
          outputSenders.has(from)
        ) {
          return;
        }
        outputSenders.add(from);
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
  });
}

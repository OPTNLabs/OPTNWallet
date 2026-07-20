// P2P CashFusion round choreography — Phase 4b. Drives one fusion round to
// completion once the pool is formed and a coordinator elected (fusion.ts).
//
// Every peer runs runFusionRound; exactly one is the coordinator (lowest
// ephemeral pubkey — computed identically by all, no vote). The flow:
//   participant → coordinator: `inputs` (from its pool identity)
//   participant → coordinator: `outputs` (in production from a FRESH key over a
//       fresh Tor circuit, so the coordinator can't link a peer's outputs to its
//       inputs — the whole point of P2P unlinkability)
//   coordinator → all: `assembled` (the flat input+output set)
//   every peer independently rebuilds the canonical tx (assembleFusionTx) and
//       runs the safety gate (verifyFusionSafety) BEFORE signing its own inputs
//   participant → coordinator: `signature`
//   coordinator finalizes, broadcasts, → all: `final`
//
// The coordinator is untrusted: it only orders and relays. It can't forge a
// transaction that peers would sign against their interest, because each peer
// re-derives the tx and verifies its own stake locally. Transport (gift-wrapped
// Nostr) and broadcast (Tor) are injected, so this choreography is exercised by
// an in-memory 3-peer simulation in the tests, then bound to real relays in 4c.

import { assembleFusionTx, verifyFusionSafety, type FusionInputRef, type FusionOutputRef, type PeerContribution } from './fusionRound';
import { signMyInputs, finalizeFusionTx, type InputSig } from './fusionSign';
import { electCoordinator } from './fusion';

export type RoundMessage =
  | { type: 'inputs'; session: string; inputs: FusionInputRef[] }
  | { type: 'outputs'; session: string; outputs: FusionOutputRef[] }
  | { type: 'assembled'; session: string; inputs: FusionInputRef[]; outputs: FusionOutputRef[] }
  | { type: 'signature'; session: string; sigs: InputSig[] }
  | { type: 'final'; session: string; txid: string; txHex: string };

/** Injected transport: send to a peer, and receive messages addressed to me. */
export interface RoundTransport {
  send(toPubkey: string, msg: RoundMessage): Promise<void>;
  /** Register a handler for inbound messages; returns an unsubscribe fn. */
  onMessage(handler: (from: string, msg: RoundMessage) => void): () => void;
}

export interface RoundParams {
  myPubkey: string; // my pool ephemeral pubkey
  participants: string[]; // all pool pubkeys agreed for this round (frozen)
  tier: number;
  feerate: number;
  myContribution: PeerContribution; // my inputs + my fresh-HD outputs
  keysByPubkey: Map<string, Uint8Array>; // private keys for my inputs
  /** Broadcast the final raw tx, returning its txid. Coordinator only. */
  broadcast: (txHex: string) => Promise<string>;
  timeoutMs?: number;
}

export interface RoundResult {
  txid: string;
  txHex: string;
}

const DEFAULT_TIMEOUT = 120_000;

/** Round id both roles derive identically: coordinator pubkey + tier. */
function sessionId(participants: string[], tier: number): string {
  return `${electCoordinator(participants)}:${tier}`;
}

function deadline(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('fusion round timed out')), ms));
}

/** Entry point: run this peer's side of the round to a broadcast tx (or throw). */
export function runFusionRound(params: RoundParams, transport: RoundTransport): Promise<RoundResult> {
  const coordinator = electCoordinator(params.participants);
  if (coordinator === params.myPubkey) return runCoordinator(params, transport);
  return runParticipant(params, transport, coordinator!);
}

/** Assemble + verify my own stake + sign my own inputs. Shared by both roles. */
function assembleVerifySign(
  params: RoundParams,
  inputs: FusionInputRef[],
  outputs: FusionOutputRef[]
): InputSig[] {
  const tx = assembleFusionTx([{ inputs, outputs }]);
  const safety = verifyFusionSafety(tx, params.myContribution, params.feerate);
  if (!safety.ok) throw new Error(`refusing to sign: ${safety.reason}`);
  return signMyInputs(tx, params.keysByPubkey);
}

async function runParticipant(
  params: RoundParams,
  transport: RoundTransport,
  coordinator: string
): Promise<RoundResult> {
  const session = sessionId(params.participants, params.tier);
  const result = new Promise<RoundResult>((resolve, reject) => {
    const unsub = transport.onMessage(async (from, msg) => {
      try {
        if (from !== coordinator || msg.session !== session) return;
        if (msg.type === 'assembled') {
          const sigs = assembleVerifySign(params, msg.inputs, msg.outputs);
          await transport.send(coordinator, { type: 'signature', session, sigs });
        } else if (msg.type === 'final') {
          unsub();
          resolve({ txid: msg.txid, txHex: msg.txHex });
        }
      } catch (e) {
        unsub();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });

  // Register inputs (pool identity) and outputs (fresh key/circuit in prod).
  await transport.send(coordinator, { type: 'inputs', session, inputs: params.myContribution.inputs });
  await transport.send(coordinator, { type: 'outputs', session, outputs: params.myContribution.outputs });

  return Promise.race([result, deadline(params.timeoutMs ?? DEFAULT_TIMEOUT)]);
}

async function runCoordinator(params: RoundParams, transport: RoundTransport): Promise<RoundResult> {
  const session = sessionId(params.participants, params.tier);
  const others = params.participants.filter((p) => p !== params.myPubkey);

  // Seed with our own contribution; collect the rest over the transport.
  const inputsByPeer = new Map<string, FusionInputRef[]>([[params.myPubkey, params.myContribution.inputs]]);
  const outputPool: FusionOutputRef[] = [...params.myContribution.outputs];
  let outputMsgs = 1; // ours
  const sigsByOutpoint = new Map<string, InputSig>();

  const done = new Promise<RoundResult>((resolve, reject) => {
    let assembled: { inputs: FusionInputRef[]; outputs: FusionOutputRef[] } | null = null;
    const totalInputs = () => [...inputsByPeer.values()].flat();

    const tryAssemble = async () => {
      if (assembled || inputsByPeer.size < params.participants.length || outputMsgs < params.participants.length) return;
      const inputs = totalInputs();
      const outputs = outputPool;
      assembled = { inputs, outputs };
      // The coordinator must verify its OWN stake and sign its OWN inputs too.
      const mySigs = assembleVerifySign(params, inputs, outputs);
      mySigs.forEach((s) => sigsByOutpoint.set(`${s.prevTxid}:${s.prevIndex}`, s));
      await Promise.all(others.map((p) => transport.send(p, { type: 'assembled', session, inputs, outputs })));
    };

    const unsub = transport.onMessage(async (from, msg) => {
      try {
        if (msg.session !== session) return;
        if (msg.type === 'inputs' && params.participants.includes(from)) {
          if (!inputsByPeer.has(from)) inputsByPeer.set(from, msg.inputs);
          await tryAssemble();
        } else if (msg.type === 'outputs') {
          // Outputs arrive from fresh keys (unlinkable) — pool them, don't attribute.
          outputPool.push(...msg.outputs);
          outputMsgs += 1;
          await tryAssemble();
        } else if (msg.type === 'signature') {
          msg.sigs.forEach((s) => sigsByOutpoint.set(`${s.prevTxid}:${s.prevIndex}`, s));
          if (assembled && sigsByOutpoint.size >= assembled.inputs.length) {
            const tx = assembleFusionTx([assembled]);
            const { txHex } = finalizeFusionTx(tx, [...sigsByOutpoint.values()]);
            const broadcastId = await params.broadcast(txHex);
            await Promise.all(others.map((p) => transport.send(p, { type: 'final', session, txid: broadcastId, txHex })));
            unsub();
            resolve({ txid: broadcastId, txHex });
          }
        }
      } catch (e) {
        unsub();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });

  return Promise.race([done, deadline(params.timeoutMs ?? DEFAULT_TIMEOUT)]);
}

// P2P CashFusion round core — Phase 4b (deterministic assembly + safety gate).
//
// Once peers have found each other and elected a coordinator (fusion.ts), the
// round runs like this:
//   1. coordinator sends round_start (tier, feerate, participant list),
//   2. each peer registers its inputs and its fresh-HD outputs,
//   3. EVERY peer assembles the CoinJoin the SAME way (assembleFusionTx) — the
//      coordinator has no say over the ordering, so it can't slip in a tx that
//      differs from what peers verify,
//   4. each peer runs verifyFusionSafety on the assembled tx and, only if it
//      passes, signs its OWN inputs (SIGHASH_ALL|FORKID) and returns the sigs,
//   5. coordinator collects sigs, finalizes, broadcasts over Tor.
//
// This module is steps 3 + 4's verification — the pure, deterministic heart.
// Because a peer signs only its own inputs, a hostile coordinator's only theft
// vector is to drop or shrink that peer's outputs; verifyFusionSafety refuses to
// sign unless every own output is present at its exact value and the transaction
// isn't overpaying fees. Signing, Nostr transport, and broadcast are injected /
// added on top — none of them can weaken this check.

/** Kinds/labels for the gift-wrapped round messages (transport in fusion.ts).
 *  v4: blind credentials cover sha256(EC Component) — Electron Cash binding. */
export const ROUND_MSG_VERSION = 4;

/** An input a peer contributes: the outpoint, its value, and the pubkey. */
export interface FusionInputRef {
  prevTxid: string; // hex (display / big-endian form) — used only as a stable key here
  prevIndex: number;
  value: number; // sats
  pubkey: string; // hex — sizing + later signing
}

/** An output a peer contributes: a fresh scriptpubkey and its value. */
export interface FusionOutputRef {
  script: string; // hex scriptpubkey
  value: number; // sats
}

/** What one peer brings to the round. */
export interface PeerContribution {
  inputs: FusionInputRef[];
  outputs: FusionOutputRef[];
}

/** The canonical CoinJoin every peer reproduces identically. */
export interface AssembledFusionTx {
  inputs: FusionInputRef[]; // BIP69 order
  outputs: FusionOutputRef[]; // BIP69 order
}

// Electron-Cash fusion size formulas (kept identical to the server path in
// FusionService.ts so both transports fee the same way).
const sizeOfInput = (pubkeyHexLen: number) => 108 + pubkeyHexLen / 2;
const sizeOfOutput = (scriptHexLen: number) => 9 + scriptHexLen / 2;
const TX_OVERHEAD = 10; // version(4)+locktime(4)+~2 varints
/** A fusion tx must not overpay: fee may be at most this multiple of the minimum. */
export const MAX_FEE_FACTOR = 3;

const inputKey = (i: FusionInputRef) => `${i.prevTxid}:${i.prevIndex}`;
const outputKey = (o: FusionOutputRef) => `${o.value}:${o.script}`;

/**
 * Deterministically order all peers' components into one CoinJoin. Uses BIP69
 * (inputs by outpoint, outputs by value then script): a well-known canonical
 * order that leaks no ownership signal AND lets every peer independently rebuild
 * the identical transaction — so nobody has to trust the coordinator's copy.
 * Throws on a duplicate outpoint (a peer trying to register another's coin).
 */
export function assembleFusionTx(
  contributions: PeerContribution[]
): AssembledFusionTx {
  const inputs: FusionInputRef[] = [];
  const outputs: FusionOutputRef[] = [];
  const seen = new Set<string>();
  for (const c of contributions) {
    for (const i of c.inputs) {
      const k = inputKey(i);
      if (seen.has(k)) throw new Error(`duplicate input ${k}`);
      seen.add(k);
      inputs.push(i);
    }
    outputs.push(...c.outputs);
  }
  inputs.sort((a, b) =>
    inputKey(a) < inputKey(b) ? -1 : inputKey(a) > inputKey(b) ? 1 : 0
  );
  outputs.sort((a, b) =>
    a.value !== b.value
      ? a.value - b.value
      : a.script < b.script
        ? -1
        : a.script > b.script
          ? 1
          : 0
  );
  return { inputs, outputs };
}

/** Estimated serialized size (bytes) of the assembled tx, EC-fusion formulas. */
export function estimateTxSize(tx: AssembledFusionTx): number {
  const inBytes = tx.inputs.reduce(
    (s, i) => s + sizeOfInput(i.pubkey.length),
    0
  );
  const outBytes = tx.outputs.reduce(
    (s, o) => s + sizeOfOutput(o.script.length),
    0
  );
  return TX_OVERHEAD + inBytes + outBytes;
}

/** Minimum fee (sats) this tx must pay at `feerate` (sats per 1000 bytes). */
export function minimumFee(tx: AssembledFusionTx, feerate: number): number {
  return Math.ceil((estimateTxSize(tx) * feerate) / 1000);
}

export interface SafetyResult {
  ok: boolean;
  reason?: string;
  totalIn: number;
  totalOut: number;
  fee: number;
  requiredFee: number;
}

/**
 * The signing gate: return ok only if it is safe for `mine` to sign its inputs.
 * Refuses if any of the peer's own outputs is missing/short, if any of its
 * inputs is absent, if the tx inflates (out > in), if the fee underpays (would
 * never confirm), or if the fee is absurdly high (a coordinator trying to burn
 * peers' money to miners). Multiset matching by (value,script): fusion outputs
 * are fresh unique addresses, so a peer's scripts can't be satisfied by another
 * peer's identical-value output.
 */
export function verifyFusionSafety(
  tx: AssembledFusionTx,
  mine: PeerContribution,
  feerate: number
): SafetyResult {
  const totalIn = tx.inputs.reduce((s, i) => s + i.value, 0);
  const totalOut = tx.outputs.reduce((s, o) => s + o.value, 0);
  const fee = totalIn - totalOut;
  const requiredFee = minimumFee(tx, feerate);
  const base = { totalIn, totalOut, fee, requiredFee };

  // Every one of my inputs must be in the tx (else I'd sign a tx I don't fund).
  const inputKeys = new Set(tx.inputs.map(inputKey));
  for (const i of mine.inputs) {
    if (!inputKeys.has(inputKey(i)))
      return { ok: false, reason: `my input ${inputKey(i)} missing`, ...base };
  }

  // Every one of my outputs must be present at its exact value (multiset).
  const available = new Map<string, number>();
  for (const o of tx.outputs)
    available.set(outputKey(o), (available.get(outputKey(o)) ?? 0) + 1);
  for (const o of mine.outputs) {
    const k = outputKey(o);
    const n = available.get(k) ?? 0;
    if (n < 1)
      return {
        ok: false,
        reason: `my output ${o.value} sats to ${o.script.slice(0, 12)}… missing`,
        ...base,
      };
    available.set(k, n - 1);
  }

  if (totalOut > totalIn)
    return { ok: false, reason: 'inflation: outputs exceed inputs', ...base };
  if (fee < requiredFee)
    return {
      ok: false,
      reason: `fee ${fee} underpays (need ${requiredFee})`,
      ...base,
    };
  if (fee > requiredFee * MAX_FEE_FACTOR)
    return {
      ok: false,
      reason: `fee ${fee} too high (max ${requiredFee * MAX_FEE_FACTOR})`,
      ...base,
    };

  return { ok: true, ...base };
}

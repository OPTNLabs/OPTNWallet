// Regenerates test-vectors/p2p-fusion.json: what the TypeScript P2P CashFusion
// peers compute, for the Rust implementation (crates/optn-fusion/src/p2p) to
// reproduce.
//   npx tsx scripts/generate-p2p-fusion-vectors.mts
//
// Every value here comes from the desktop's own TypeScript, never from Rust: a
// vector the code under test wrote would only prove it agrees with itself. The
// cases cover what a mixed round depends on — who coordinates, which group
// forms, the canonical transaction and its fee gate, the onion, the strict
// message parser, blame verdicts, announcements, output planning and a signed
// final transaction.
import { writeFileSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools';
import { binToHex, secp256k1 } from '@bitauth/libauth';

import {
  buildPoolAnnouncement,
  electCoordinator,
  selectFusionGroup,
  type FusionGroupPeer,
} from '../src/platform/desktop/nostr/fusion';
import {
  assembleFusionTx,
  estimateTxSize,
  minimumFee,
  verifyFusionSafety,
  type FusionInputRef,
  type FusionOutputRef,
} from '../src/platform/desktop/nostr/fusionRound';
import {
  encodeAuthorizedOutput,
  onionWrap,
} from '../src/platform/desktop/nostr/onionCrypto';
import {
  messageBinding,
  parseRoundMessage,
} from '../src/platform/desktop/nostr/fusionSession';
import {
  finalizeFusionTx,
  signMyInputs,
} from '../src/platform/desktop/nostr/fusionSign';
import { verifyBlameReport } from '../src/platform/desktop/nostr/fusionBlame';
import {
  inputCredentialMessageHashHex,
  outputCredentialMessageHashHex,
} from '../src/platform/desktop/nostr/fusionBlindSchnorr';
import { pedersenCommitWithNonce } from '../src/platform/desktop/nostr/fusionPedersen';
import {
  planP2pOutputValues,
  quantizationGrid,
} from '../src/platform/desktop/nostr/fusionP2pAllocation';

/** Deterministic 32-byte values: a fixed pattern per seed. */
function bytes32(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  let state = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 32; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  out[0] = (out[0] % 0x7f) + 1; // keep secrets below the group order
  return out;
}
const hex32 = (seed: number) => binToHex(bytes32(seed));
const xOnly = (seed: number) => getPublicKey(bytes32(seed));
const compressed = (seed: number) => {
  const pub = secp256k1.derivePublicKeyCompressed(bytes32(seed));
  if (typeof pub === 'string') throw new Error(pub);
  return binToHex(pub);
};
const p2pkh = (seed: number) => `76a914${hex32(seed).slice(0, 40)}88ac`;

// ── Election ───────────────────────────────────────────────────────────────
const election = [2, 3, 4, 6, 10].map((size, at) => {
  const keys = Array.from({ length: size }, (_, i) => xOnly(100 + at * 20 + i));
  return { keys, coordinator: electCoordinator(keys) };
});

// ── Group selection ────────────────────────────────────────────────────────
const peer = (
  seed: number,
  tiers: number[],
  numInputs: number
): FusionGroupPeer => ({ pubkey: xOnly(seed), tiers, numInputs });
const groups = [
  {
    peers: [
      peer(1, [100_000, 1_000_000], 2),
      peer(2, [100_000, 1_000_000], 3),
      peer(3, [100_000], 1),
      peer(4, [100_000, 1_000_000], 2),
      peer(5, [1_000_000], 20),
    ],
    min: 3,
    max: 10,
  },
  {
    peers: Array.from({ length: 12 }, (_, i) => peer(30 + i, [100_000], 20)),
    min: 2,
    max: 10,
  },
  {
    peers: [peer(60, [10_000], 1), peer(61, [10_000, 5], 1)],
    min: 3,
    max: 10,
  },
].map((g) => ({ ...g, group: selectFusionGroup(g.peers, g.min, g.max) }));

// ── Canonical assembly and the signing gate ────────────────────────────────
const inputs: FusionInputRef[] = [
  { prevTxid: hex32(1), prevIndex: 9, value: 120_000, pubkey: compressed(11) },
  { prevTxid: hex32(1), prevIndex: 10, value: 80_000, pubkey: compressed(12) },
  { prevTxid: hex32(2), prevIndex: 0, value: 50_000, pubkey: compressed(13) },
];
const outputs: FusionOutputRef[] = [
  { script: p2pkh(21), value: 60_000 },
  { script: p2pkh(22), value: 60_000 },
  { script: p2pkh(23), value: 129_000 },
];
const tx = assembleFusionTx([{ inputs, outputs }]);
const safetyCases = [
  { feerate: 1_000, mine: { inputs: [inputs[0]], outputs: [outputs[0]] } },
  { feerate: 3_000, mine: { inputs: [inputs[0]], outputs: [outputs[0]] } },
  {
    feerate: 1_000,
    mine: {
      inputs: [inputs[0]],
      outputs: [{ script: p2pkh(99), value: 60_000 }],
    },
  },
  { feerate: 6_000, mine: { inputs: [inputs[2]], outputs: [outputs[2]] } },
].map((c) => ({ ...c, verdict: verifyFusionSafety(tx, c.mine, c.feerate) }));
const assembly = {
  contributions: [{ inputs, outputs }],
  assembled: tx,
  estimatedSize: estimateTxSize(tx),
  minimumFeeAt1000: minimumFee(tx, 1_000),
  safety: safetyCases,
};

// ── Final transaction signed by the TypeScript signer ──────────────────────
const keys = new Map(
  [11, 12, 13].map((seed) => [compressed(seed), bytes32(seed)] as const)
);
const sigs = signMyInputs(tx, keys);
const finalized = finalizeFusionTx(tx, sigs);
const finalTx = {
  assembled: tx,
  sigs,
  txHex: finalized.txHex,
  txid: finalized.txid,
};

// ── Onion ──────────────────────────────────────────────────────────────────
const peelerSeeds = [201, 202, 203];
const authorized = {
  script: p2pkh(31),
  value: 123_456,
  credentialSerial: hex32(32),
  credentialSig: hex32(33) + hex32(34),
  saltCommitment: hex32(35),
};
const payload = encodeAuthorizedOutput(authorized);
const onion = {
  peelerSecrets: peelerSeeds.map(hex32),
  peelers: peelerSeeds.map(xOnly),
  output: authorized,
  payload,
  blob: Buffer.from(await onionWrap(payload, peelerSeeds.map(xOnly))).toString(
    'base64'
  ),
};

// ── Credential messages ────────────────────────────────────────────────────
const credentials = {
  input: inputs[0],
  inputSaltCommitment: hex32(41),
  inputHash: inputCredentialMessageHashHex(inputs[0], hex32(41)),
  output: outputs[0],
  outputSaltCommitment: hex32(42),
  outputHash: outputCredentialMessageHashHex(
    { session: 's', network: 'chipnet', tier: 100_000 },
    outputs[0],
    hex32(43),
    hex32(42)
  ),
};

// ── The strict parser ──────────────────────────────────────────────────────
const nowUnix = Math.floor(Date.now() / 1000);
const session = hex32(50);
const participants = [xOnly(51), xOnly(52), xOnly(53), xOnly(54)].sort();
const point = `04${hex32(55)}${hex32(56)}`;
const valid: Record<string, unknown>[] = [
  {
    type: 'round_proposal',
    network: 'chipnet',
    tier: 100_000,
    epoch: 3,
    participants,
  },
  { type: 'round_ack', network: 'chipnet', tier: 100_000, epoch: 3 },
  {
    type: 'round_shrink',
    network: 'mainnet',
    tier: 10_000,
    epoch: 0,
    remaining: participants,
  },
  {
    type: 'round_start',
    network: 'chipnet',
    tier: 100_000,
    epoch: 3,
    participants,
  },
  { type: 'abort', reason: 'cancelled' },
  {
    type: 'credential_params',
    roundPubkey: compressed(57),
    blindNoncePoints: [compressed(58), compressed(59)],
  },
  {
    type: 'credential_request',
    requests: [
      { index: 24, e: hex32(60) },
      { index: 25, e: hex32(61) },
    ],
    amountCommitments: [point, point],
    componentCommitments: [
      { index: 24, saltedComponentHash: hex32(62), amountCommitment: point },
      { index: 25, saltedComponentHash: hex32(63), amountCommitment: point },
    ],
    pedersenTotalNonce: hex32(64),
    excessFee: 1_234,
    inputCount: 1,
    outputCount: 1,
  },
  { type: 'credential_response', responses: [{ index: 24, s: hex32(65) }] },
  {
    type: 'inputs',
    inputs: [inputs[0]],
    credentialSigs: [hex32(66) + hex32(67)],
    saltCommitments: [hex32(68)],
  },
  { type: 'outputs', outputs: [authorized] },
  { type: 'onion_output', onion: onion.blob, mixOrder: participants.slice(1) },
  { type: 'onion_declare', outputCount: 3 },
  { type: 'components_ready' },
  { type: 'assembled', inputs: tx.inputs, outputs: tx.outputs },
  { type: 'signature', sigs },
  { type: 'final', txid: finalized.txid, txHex: finalized.txHex },
];
const bind = (body: Record<string, unknown>) => ({
  ...messageBinding(),
  session,
  ...body,
});
const messages: Array<{ json: string; accepted: boolean; why: string }> = [];
for (const body of valid) {
  const json = JSON.stringify(bind(body));
  messages.push({
    json,
    accepted: parseRoundMessage(json) !== null,
    why: `valid ${body.type}`,
  });
}
const mutate = (
  why: string,
  body: Record<string, unknown>,
  change: (m: Record<string, unknown>) => void
) => {
  const message = bind(body);
  change(message);
  const json = JSON.stringify(message);
  messages.push({ json, accepted: parseRoundMessage(json) !== null, why });
};
mutate('version 3', valid[1], (m) => (m.version = 3));
mutate('stale timestamp', valid[1], (m) => (m.timestamp = nowUnix - 600));
mutate('future timestamp', valid[1], (m) => (m.timestamp = nowUnix + 120));
mutate('short nonce', valid[1], (m) => (m.nonce = 'abcd'));
mutate('tier below floor', valid[1], (m) => (m.tier = 9_999));
mutate(
  'duplicate participants',
  valid[0],
  (m) => (m.participants = [participants[0], participants[0]])
);
mutate(
  'compressed participant',
  valid[0],
  (m) => (m.participants = [participants[0], compressed(70)])
);
mutate('unknown type', valid[12], (m) => (m.type = 'outputs_v2'));
mutate('empty abort reason', valid[4], (m) => (m.reason = ''));
mutate('abort reason too long', valid[4], (m) => (m.reason = 'x'.repeat(241)));
mutate('request count mismatch', valid[6], (m) => (m.outputCount = 2));
mutate('commitment index mismatch', valid[6], (m) => {
  (m.componentCommitments as Array<{ index: number }>)[1].index = 26;
});
mutate(
  'response index out of range',
  valid[7],
  (m) => (m.responses = [{ index: 1024, s: hex32(65) }])
);
mutate('credential sig count', valid[8], (m) => (m.credentialSigs = []));
mutate('dust output', valid[13], (m) => {
  m.outputs = [{ script: p2pkh(21), value: 545 }];
});
mutate('declare too many', valid[11], (m) => (m.outputCount = 7));
mutate('odd final hex', valid[15], (m) => (m.txHex = 'abc'));
mutate('session with newline', valid[12], (m) => (m.session = 'a\nb'));
mutate(
  'single nonce point',
  valid[5],
  (m) => (m.blindNoncePoints = [compressed(58)])
);

// ── Blame verdicts ─────────────────────────────────────────────────────────
const nonce = hex32(80);
const commitment = pedersenCommitWithNonce(1_000, nonce).commitmentHex;
const blameCtx = { session, participants, feerate: 1_000 };
const blameCases = [
  {
    accused: participants[1],
    code: 'credential_slot_oob',
    evidence: { kind: 'credential_slot_oob', slots: [24, 47], participants },
  },
  {
    accused: participants[1],
    code: 'credential_slot_oob',
    evidence: { kind: 'credential_slot_oob', slots: [24, 48], participants },
  },
  {
    accused: participants[2],
    code: 'pedersen_unbalanced',
    evidence: {
      kind: 'pedersen_unbalanced',
      amountCommitments: [commitment],
      pedersenTotalNonce: nonce,
      excessFee: 1_000,
    },
  },
  {
    accused: participants[2],
    code: 'pedersen_unbalanced',
    evidence: {
      kind: 'pedersen_unbalanced',
      amountCommitments: [commitment],
      pedersenTotalNonce: nonce,
      excessFee: 999,
    },
  },
  {
    accused: participants[0],
    code: 'duplicate_outpoint',
    evidence: {
      kind: 'duplicate_outpoint',
      prevTxid: hex32(81),
      prevIndex: 0,
      claimants: [participants[0], participants[3]],
    },
  },
  {
    accused: xOnly(99),
    code: 'duplicate_outpoint',
    evidence: {
      kind: 'duplicate_outpoint',
      prevTxid: hex32(81),
      prevIndex: 0,
      claimants: [participants[0], participants[3]],
    },
  },
  {
    accused: participants[3],
    code: 'invalid_input_credential',
    evidence: {
      kind: 'invalid_input_credential',
      roundPubkey: compressed(57),
      inputs: [inputs[0]],
      credentialSigs: [hex32(82) + hex32(83)],
    },
  },
  {
    accused: participants[3],
    code: 'invalid_signature_set',
    evidence: {
      kind: 'invalid_signature_set',
      expectedOutpoints: [],
      receivedOutpoints: [],
    },
  },
].map((report) => {
  const verdict = verifyBlameReport(
    { session, ...report } as Parameters<typeof verifyBlameReport>[0],
    blameCtx
  );
  return { report: { session, ...report }, ok: verdict.ok };
});

// ── Announcements ──────────────────────────────────────────────────────────
const announceNow = 1_800_000_015;
const announcement = buildPoolAnnouncement(
  { secretKey: bytes32(90), pubkey: xOnly(90) },
  {
    network: 'chipnet',
    tiers: [100_000, 5, 1_000_000, 100_000],
    numInputs: 3,
    nowSeconds: announceNow,
  }
);

// ── Output planning ────────────────────────────────────────────────────────
const units = Array.from({ length: 12 }, (_, i) => ((i * 7919) % 1000) / 1000);
const planCases = [
  {
    inputs: [{ value: 250_000, pubkey: compressed(11) }],
    participantCount: 6,
    tier: 100_000,
  },
  {
    inputs: [
      { value: 90_000, pubkey: compressed(11) },
      { value: 40_000, pubkey: compressed(12) },
    ],
    participantCount: 4,
    tier: 10_000,
  },
  {
    inputs: [{ value: 3_000_000, pubkey: compressed(11) }],
    participantCount: 10,
    tier: 1_000_000,
  },
].map((c) => {
  let at = 0;
  const plan = planP2pOutputValues({
    ...c,
    feerate: 1_000,
    randomUnit: () => units[at++ % units.length],
  });
  return { ...c, units, plan };
});
const grids = [1, 10_000, 99_999, 100_000, 1_000_000, 123_456_789].map(
  (tier) => ({
    tier,
    grid: quantizationGrid(tier),
  })
);

const document = {
  $comment:
    'Generated by scripts/generate-p2p-fusion-vectors.mts from the desktop TypeScript P2P CashFusion code. ' +
    'crates/optn-fusion/src/p2p/vectors.rs checks that Rust reproduces every value. Regenerate only on purpose.',
  nowUnix,
  election,
  groups,
  assembly,
  finalTx,
  onion,
  credentials,
  messages,
  blame: blameCases,
  announcement: { nowUnix: announceNow, event: announcement },
  planning: { cases: planCases, grids },
};

const path = 'test-vectors/p2p-fusion.json';
writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(
  `wrote ${path}: ${messages.length} messages (${messages.filter((m) => m.accepted).length} accepted), ` +
    `${blameCases.length} blame verdicts`
);

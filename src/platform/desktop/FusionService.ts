// Desktop "Fuse Now" glue — drives the Rust fusion_run engine (Phase 1.7).
//
// Gathers the wallet's selected UTXOs and their signing keys, allocates
// tier-sized fresh HD outputs, and invokes the fusion_run command which runs the
// whole CashFusion round. This is the ONLY new place private keys are handled:
// they are fetched from the wallet's existing KeyService, hex-encoded, and passed
// to the Rust command over IPC (which signs and drops them) — never logged, never
// sent over the network. Nothing here weakens the wallet's key storage.
//
// Output allocation here is the simple, valid one: k outputs each equal to the
// tier size, with the remainder becoming the excess fee (kept within the server's
// [min,max] bounds). It completes a real fusion; the privacy-optimal randomized
// allocation (Electron Cash random_outputs_for_tier) is a later refinement — the
// note is deliberate, see Protocol.

import { invoke } from '@tauri-apps/api/core';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import KeyService from '../../services/KeyService';
import { deriveBchAddressFromHdPublicKey } from '../../services/HdWalletService';
import { Network } from '../../state/slices/networkSlice';
import { binToHex } from '../../utils/hex';
import type { UTXO } from '../../types/types';
import { CURRENT_FUSION_EXECUTION_READINESS } from './FusionExecutionSafety';

/** protocol.py MIN_OUTPUT — the smallest a fusion output may be. */
const MIN_OUTPUT = 10_000;

/** Server parameters read from a status handshake before allocating. */
export interface FusionServerParams {
  tiers: number[];
  numComponents: number;
  componentFeerate: number;
  minExcessFee: number;
  maxExcessFee: number;
}

interface FusionRunInput {
  prev_txid: string;
  prev_index: number;
  pubkey: string; // hex
  value: number;
  privkey: string; // hex
}

export interface FusionOutcome {
  ok: boolean;
  broadcast_verified: boolean;
  txid: string | null;
  tx_hex: string | null;
  message: string;
}

// Match the Rust/Electron-Cash fee formulas exactly.
const componentFee = (size: number, feerate: number) => Math.ceil((size * feerate) / 1000);
const sizeOfInput = (pubkeyLen: number) => 108 + pubkeyLen;
const feePerOutput = (feerate: number) => componentFee(9 + 25, feerate); // P2PKH output = 34

/**
 * Build the signed-input list from selected UTXOs. Looks up each UTXO's pubkey
 * (retrieveKeys) and private key (fetchAddressPrivateKey) by address.
 */
export async function gatherInputs(walletId: number, utxos: UTXO[]): Promise<FusionRunInput[]> {
  const keys = await KeyService.retrieveKeys(walletId);
  const byAddress = new Map(keys.map((k) => [k.address, k.publicKey]));

  const inputs: FusionRunInput[] = [];
  for (const u of utxos) {
    const pub = byAddress.get(u.address);
    if (!pub) throw new Error(`No key for UTXO address ${u.address}`);
    const priv = await KeyService.fetchAddressPrivateKey(u.address);
    if (!priv) throw new Error(`No private key for ${u.address}`);
    inputs.push({
      prev_txid: u.tx_hash,
      prev_index: u.tx_pos,
      pubkey: binToHex(pub),
      value: u.value ?? Number(u.amount ?? 0),
      privkey: binToHex(priv),
    });
  }
  return inputs;
}

/** scriptpubkey (hex) for a CashAddr. */
function scriptForAddress(address: string): string {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(`bad address ${address}`);
  return binToHex(decoded.bytecode);
}

/**
 * Allocate the fusion outputs: `k` fresh HD addresses each holding exactly the
 * tier amount, `k` chosen so the leftover (the excess fee) stays within the
 * server's [min,max] bounds. Returns the output scriptpubkeys (hex) + values, or
 * throws if the selected inputs are too small to make even one tier output.
 */
export async function allocateOutputs(
  walletId: number,
  network: Network,
  tier: number,
  inputs: FusionRunInput[],
  params: FusionServerParams
): Promise<{ scripts: string[]; values: number[] }> {
  const sumIn = inputs.reduce((s, i) => s + i.value, 0);
  const inputFees = inputs.reduce((s, i) => s + componentFee(sizeOfInput(i.pubkey.length / 2), params.componentFeerate), 0);
  const outFee = feePerOutput(params.componentFeerate);

  const maxOutputs = Math.max(1, params.numComponents - inputs.length);
  // Each tier output costs (tier + its component fee); how many fit while
  // leaving at least min_excess_fee behind?
  let k = Math.floor((sumIn - inputFees - params.minExcessFee) / (tier + outFee));
  k = Math.min(k, maxOutputs);
  if (k < 1) {
    throw new Error(
      `Selected inputs (${sumIn} sats) are too small for tier ${tier}. Need ~${tier + outFee + params.minExcessFee}+ sats.`
    );
  }

  const excessFee = sumIn - k * tier - inputFees - k * outFee;
  if (excessFee < params.minExcessFee || excessFee > params.maxExcessFee) {
    throw new Error(
      `Can't hit a valid fee with these inputs (excess ${excessFee} not in [${params.minExcessFee}, ${params.maxExcessFee}]). Try an input amount closer to a multiple of the tier.`
    );
  }

  // Derive k fresh HD receive addresses (branch 0) past the current gap.
  const xpubs = await KeyService.getWalletXpubs(walletId, 0);
  const receiveXpub = xpubs.receive;
  if (!receiveXpub) throw new Error('no receive xpub');

  const existing = (await KeyService.retrieveKeys(walletId)).filter((x) => x.changeIndex === 0);
  const startIndex = existing.reduce((m, x) => Math.max(m, Number(x.addressIndex) + 1), 0);

  const scripts: string[] = [];
  for (let n = 0; n < k; n++) {
    const derived = deriveBchAddressFromHdPublicKey(network, receiveXpub, BigInt(startIndex + n));
    if (!derived) throw new Error('failed to derive fusion output address');
    scripts.push(scriptForAddress(derived.address));
  }
  return { scripts, values: new Array(k).fill(tier) };
}

/** Pick the smallest tier the inputs can afford; null if none fit. */
export function chooseTier(sumIn: number, params: FusionServerParams): number | null {
  const outFee = feePerOutput(params.componentFeerate);
  const affordable = params.tiers
    .filter((t) => t >= MIN_OUTPUT && sumIn - params.minExcessFee - outFee >= t)
    .sort((a, b) => a - b);
  return affordable[0] ?? null;
}

/**
 * Run a full fusion round for `utxos`. `torPort` (127.0.0.1) is required for a
 * remote server. Returns the outcome (assembled tx on success).
 */
export async function runFusion(opts: {
  walletId: number;
  network: Network;
  host: string;
  port: number;
  useSsl: boolean;
  utxos: UTXO[];
  params: FusionServerParams;
  torHost?: string | null;
  torPort?: number | null;
}): Promise<FusionOutcome> {
  if (!CURRENT_FUSION_EXECUTION_READINESS.ready) {
    throw new Error(
      `Fusion execution is paused until wallet safety hardening is complete: ${CURRENT_FUSION_EXECUTION_READINESS.blockers.join(', ')}.`
    );
  }

  const inputs = await gatherInputs(opts.walletId, opts.utxos);
  const sumIn = inputs.reduce((s, i) => s + i.value, 0);
  const tier = chooseTier(sumIn, opts.params);
  if (tier == null) throw new Error('inputs too small for any fusion tier');

  const { scripts, values } = await allocateOutputs(opts.walletId, opts.network, tier, inputs, opts.params);

  return invoke<FusionOutcome>('fusion_run', {
    host: opts.host,
    port: opts.port,
    useSsl: opts.useSsl,
    tier,
    inputs,
    outputScripts: scripts,
    outputValues: values,
    torHost: opts.torPort ? opts.torHost ?? '127.0.0.1' : null,
    torPort: opts.torPort ?? null,
  });
}

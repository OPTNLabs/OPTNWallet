// Token sends for the watch-only (SeedCash) send flow.
//
// Which coins a token send spends, where every token goes, the fee, the PSBT
// and the check that nothing is burned are all decided in Rust
// (crates/optn-core/src/spend/tokens.rs, airgap_spend.rs). This file only
// carries the wallet's coins and the holder's choice across the WASM boundary,
// and the signed return back for Rust to verify and assemble.
import { binToHex, hexToBin } from '@bitauth/libauth';

import type { UTXO } from '../../types/types';
import {
  ensureOptnCore,
  planTokenSpend,
  psbtFinalizeCashTokensP2pkh,
  tokenSpendPsbt,
} from '../../wasm/optn-core';

/** What the recipient receives. */
export type TokenPayment =
  | {
      kind: 'fungible';
      category: string;
      /** As typed, in the token's own units, e.g. "12.5". */
      amount: string;
      decimals: number;
    }
  | { kind: 'all_fungible'; category: string }
  | { kind: 'nft'; outpoint: string };

/** A wallet coin as the planner takes it, with the key that controls it. */
export interface TokenSendCoin {
  /** `txid:vout`, display-order txid. */
  outpoint: string;
  utxo: UTXO;
  satoshis: bigint;
  /** Compressed public key, hex. Empty when the wallet does not know it. */
  publicKeyHex: string;
  branchIndex: number;
  addressIndex: number;
}

/** Mirrors the token view `optn_core::spend::tokens` serializes. */
export interface PlannedToken {
  category: string;
  amount: string;
  nft: { capability: string; commitment: string } | null;
}

/** Mirrors `optn_core::spend::TokenSpendPlan`. */
export interface TokenSpendPlan {
  inputs: {
    outpoint: string;
    sats: number;
    address: string;
    token: PlannedToken | null;
  }[];
  outputs: {
    role: 'recipient' | 'token_change' | 'change';
    address: string;
    sats: number;
    token: PlannedToken | null;
  }[];
  fee_sats: number;
  fee_rate_sats_per_kb: number;
  size_bytes: number;
}

/** Rust's review of the exact PSBT bytes (`psbt::review_p2pkh`). */
export interface TokenSpendReview {
  fee_satoshis: number;
  categories: {
    category: string;
    input_fungible: string;
    output_fungible: string;
    burned_fungible: string;
  }[];
  [field: string]: unknown;
}

export interface TokenSendRequest {
  network: string;
  coins: readonly TokenSendCoin[];
  payment: TokenPayment;
  /** Coin control: exactly these outpoints. Omitted lets Rust choose. */
  chosen?: readonly string[];
  destination: string;
  change: string;
  feeSatsPerKb: bigint;
}

function rustError(error: unknown): Error {
  // wasm-bindgen throws the Rust error as a bare string.
  return new Error(error instanceof Error ? error.message : String(error));
}

/** The flat arguments both WASM calls share, in their order. */
function planArguments(request: TokenSendRequest) {
  const { coins, payment } = request;
  const field = (pick: (utxo: UTXO) => string | undefined) =>
    coins.map((coin) => pick(coin.utxo) ?? '');
  return [
    request.network,
    coins.map((coin) => coin.outpoint),
    BigUint64Array.from(coins.map((coin) => coin.satoshis)),
    coins.map((coin) => coin.utxo.address),
    field((utxo) => utxo.token?.category),
    // Decimal strings: amounts reach 2^63 - 1, past a JS number.
    field((utxo) => (utxo.token ? String(utxo.token.amount ?? 0) : undefined)),
    field((utxo) =>
      utxo.token?.nft ? String(utxo.token.nft.capability ?? '') : undefined
    ),
    field((utxo) => utxo.token?.nft?.commitment ?? undefined),
    payment.kind,
    payment.kind === 'nft' ? payment.outpoint : payment.category,
    payment.kind === 'fungible' ? payment.amount.trim() : undefined,
    payment.kind === 'fungible' ? payment.decimals : 0,
    request.chosen ? [...request.chosen] : undefined,
    request.destination.trim(),
    request.change,
    request.feeSatsPerKb,
  ] as const;
}

/** Plan the send without building the PSBT, to show what it will do. */
export function planTokenSend(request: TokenSendRequest): TokenSpendPlan {
  ensureOptnCore();
  try {
    return JSON.parse(planTokenSpend(...planArguments(request)));
  } catch (error) {
    throw rustError(error);
  }
}

export interface BuiltTokenSend {
  psbtBytes: Uint8Array;
  plan: TokenSpendPlan;
  review: TokenSpendReview;
}

/**
 * The unsigned PSBT SeedCash signs, with Rust's review of those exact bytes.
 * `parents` maps each spent coin's txid to its complete parent transaction
 * (hex); Rust binds every input to it and refuses one that disagrees.
 */
export function buildTokenSend(
  request: TokenSendRequest,
  accountPath: string,
  fingerprintHex: string | null,
  parents: ReadonlyMap<string, string>
): BuiltTokenSend {
  ensureOptnCore();
  const { coins } = request;
  let json: string;
  try {
    json = tokenSpendPsbt(
      ...planArguments(request),
      coins.map((coin) => coin.publicKeyHex),
      Uint32Array.from(coins.map((coin) => coin.branchIndex)),
      Uint32Array.from(coins.map((coin) => coin.addressIndex)),
      accountPath,
      fingerprintHex || undefined,
      [...new Set(parents.values())]
    );
  } catch (error) {
    throw rustError(error);
  }
  const built = JSON.parse(json) as {
    psbt: string;
    plan: TokenSpendPlan;
    review: TokenSpendReview;
  };
  return {
    psbtBytes: hexToBin(built.psbt),
    plan: built.plan,
    review: built.review,
  };
}

/**
 * The broadcastable transaction from SeedCash's signed return, verified by
 * Rust against the exact bytes the holder approved. Throws when the return is
 * not those bytes, or a signature does not hold.
 */
export function finalizeTokenSend(
  original: Uint8Array,
  signed: Uint8Array,
  network: string
): string {
  ensureOptnCore();
  try {
    return binToHex(psbtFinalizeCashTokensP2pkh(original, signed, network));
  } catch (error) {
    throw rustError(error);
  }
}

/** The txids whose parent transactions a plan's inputs need. */
export function planParentTxids(plan: TokenSpendPlan): string[] {
  return [...new Set(plan.inputs.map((input) => input.outpoint.split(':')[0]))];
}

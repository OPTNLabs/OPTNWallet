// src/services/CoinSelectionService.ts

import { UTXO } from '../types/types';

export type CoinSelectionOptions = {
  /**
   * Prefer confirmed UTXOs only (height > 0). Default: true
   */
  preferConfirmed?: boolean;
  /**
   * Hard cap to avoid overly-large transactions. Default: 20
   */
  maxInputs?: number;
  /**
   * Skip UTXOs that carry CashTokens (BCH-only simple send safety). Default: true
   */
  skipTokenUtxos?: boolean;
};

export type CoinSelectionResult = {
  selected: UTXO[];
  /**
   * Sum of selected satoshis (BCH only; token satoshis are still BCH in UTXOs)
   */
  totalSelectedSats: bigint;
};

function isSpendableP2PKH(utxo: UTXO, skipTokenUtxos: boolean): boolean {
  const anyU = utxo as any;
  const isContract = !!anyU.abi || !!anyU.contractName;
  const isPaper = !!anyU.isPaperWallet;
  const hasToken = !!utxo.token;

  if (skipTokenUtxos && hasToken) return false;
  return !isContract && !isPaper;
}

function isConfirmed(utxo: UTXO): boolean {
  return typeof utxo.height === 'number' && utxo.height > 0;
}

/**
 * Very light fee guesser for selection pre-checks only.
 * Final fee is computed by TransactionManager.buildTransaction().
 */
function roughFeeForInputs(inputCount: number): bigint {
  const bytes = 120 + inputCount * 148 + 2 * 34; // base + p2pkh inputs + 2 outputs
  return BigInt(bytes); // 1 sat/byte
}

/**
 * Largest-first greedy selector for BCH.
 */
export function selectForBch(
  targetSats: bigint,
  utxos: UTXO[],
  opts: CoinSelectionOptions = {}
): CoinSelectionResult {
  const preferConfirmed = opts.preferConfirmed ?? true;
  const maxInputs = opts.maxInputs ?? 20;
  const skipTokenUtxos = opts.skipTokenUtxos ?? true;

  const pool = utxos
    .filter((u) => isSpendableP2PKH(u, skipTokenUtxos))
    .filter((u) => (preferConfirmed ? isConfirmed(u) : true))
    .sort((a, b) =>
      Number(BigInt(b.amount ?? b.value) - BigInt(a.amount ?? a.value))
    );

  const selected: UTXO[] = [];
  let running = BigInt(0);

  for (let i = 0; i < pool.length && selected.length < maxInputs; i++) {
    const u = pool[i];
    const v = BigInt(u.amount ?? u.value);
    selected.push(u);
    running += v;

    const roughFee = roughFeeForInputs(selected.length);
    if (running >= targetSats + roughFee) break;
  }

  return {
    selected,
    totalSelectedSats: running,
  };
}

/** -------- CashToken helpers (single-category only) -------- **/

/**
 * Select fungible token UTXOs (single category) until >= tokenAmount.
 * Returns { tokenInputs, totalTokenAmount }.
 * Excludes NFT-carrying UTXOs.
 */
export function selectTokenFtInputs(
  category: string,
  tokenUtxos: UTXO[],
  tokenAmount: bigint,
  opts: { preferConfirmed?: boolean; maxInputs?: number } = {}
): { tokenInputs: UTXO[]; totalTokenAmount: bigint } {
  const preferConfirmed = opts.preferConfirmed ?? true;
  const maxInputs = opts.maxInputs ?? 50;

  const pool = tokenUtxos
    .filter((u) => u.token?.category === category)
    .filter((u) => !u.token?.nft) // FT only
    .filter((u) => (preferConfirmed ? isConfirmed(u) : true))
    .sort((a, b) =>
      Number(BigInt(b.token?.amount ?? 0) - BigInt(a.token?.amount ?? 0))
    );

  const tokenInputs: UTXO[] = [];
  let running = BigInt(0);

  for (let i = 0; i < pool.length && tokenInputs.length < maxInputs; i++) {
    const u = pool[i];
    const amt = BigInt(u.token?.amount ?? 0);
    tokenInputs.push(u);
    running += amt;
    if (running >= tokenAmount) break;
  }

  return { tokenInputs, totalTokenAmount: running };
}

/**
 * Pick exactly one NFT UTXO for a category. Optionally filter by commitment.
 */
export function selectNftInput(
  category: string,
  tokenUtxos: UTXO[],
  opts: { preferConfirmed?: boolean; commitmentHex?: string } = {}
): UTXO | null {
  const preferConfirmed = opts.preferConfirmed ?? true;
  const commitmentHex = opts.commitmentHex?.toLowerCase();

  const pool = tokenUtxos
    .filter((u) => u.token?.category === category)
    .filter((u) => !!u.token?.nft)
    .filter((u) => (preferConfirmed ? isConfirmed(u) : true));

  if (commitmentHex) {
    const found = pool.find(
      (u) => (u.token!.nft!.commitment || '').toLowerCase() === commitmentHex
    );
    return found ?? null;
  }
  // default: first available
  return pool[0] ?? null;
}

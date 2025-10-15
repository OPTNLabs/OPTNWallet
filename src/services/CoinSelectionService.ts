// src/services/CoinSelectionService.ts
import { UTXO } from '../types/types';

export type CoinSelectionOptions = {
  preferConfirmed?: boolean;
  maxInputs?: number;
  skipTokenUtxos?: boolean; // applies to BCH-only selection
};

export type CoinSelectionResult = {
  selected: UTXO[];
  totalSelectedSats: bigint;
};

function isP2pkhSpendableBase(utxo: UTXO): boolean {
  const anyU = utxo as any;
  const isContract = !!anyU.abi || !!anyU.contractName;
  const isPaper = !!anyU.isPaperWallet;
  return !isContract && !isPaper;
}

function isConfirmed(utxo: UTXO): boolean {
  return typeof utxo.height === 'number' && utxo.height > 0;
}

function roughFeeForInputs(inputCount: number): bigint {
  const bytes = 120 + inputCount * 148 + 2 * 34;
  return BigInt(bytes);
}

// ========== BCH for fees (unchanged behavior) ==========
export function selectForBch(
  targetSats: bigint,
  utxos: UTXO[],
  opts: CoinSelectionOptions = {}
): CoinSelectionResult {
  const preferConfirmed = opts.preferConfirmed ?? true;
  const maxInputs = opts.maxInputs ?? 20;
  const skipTokenUtxos = opts.skipTokenUtxos ?? true;

  const pool = utxos
    .filter((u) => isP2pkhSpendableBase(u))
    .filter((u) => (skipTokenUtxos ? !u.token : true))
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

  return { selected, totalSelectedSats: running };
}

// ========== CashToken: FT by category ==========
export function selectTokenFtByCategory(
  category: string,
  tokenAmountNeeded: bigint,
  utxos: UTXO[],
  opts: { preferConfirmed?: boolean; maxInputs?: number } = {}
): { selectedTokenUtxos: UTXO[]; totalTokenAmount: bigint } {
  const preferConfirmed = opts.preferConfirmed ?? true;
  const maxInputs = opts.maxInputs ?? 50;

  const pool = utxos
    .filter(isP2pkhSpendableBase)
    .filter((u) => !!u.token && u.token.category === category && !u.token.nft)
    .filter((u) => (preferConfirmed ? isConfirmed(u) : true))
    // largest-first by token amount
    .sort((a, b) =>
      Number(BigInt(b.token!.amount ?? 0) - BigInt(a.token!.amount ?? 0))
    );

  const selectedTokenUtxos: UTXO[] = [];
  let running = BigInt(0);

  for (
    let i = 0;
    i < pool.length && selectedTokenUtxos.length < maxInputs;
    i++
  ) {
    const u = pool[i];
    const amt = BigInt(u.token!.amount ?? 0);
    selectedTokenUtxos.push(u);
    running += amt;
    if (running >= tokenAmountNeeded) break;
  }

  return { selectedTokenUtxos, totalTokenAmount: running };
}

// ========== CashToken: NFT by category (choose exact NFT) ==========
export function selectNftByCategory(
  category: string,
  utxos: UTXO[],
  opts: { preferConfirmed?: boolean; commitment?: string } = {}
): { nftUtxo: UTXO | null } {
  const preferConfirmed = opts.preferConfirmed ?? true;
  const commitment = opts.commitment;

  const pool = utxos
    .filter(isP2pkhSpendableBase)
    .filter((u) => !!u.token && u.token.category === category && !!u.token.nft)
    .filter((u) => (preferConfirmed ? isConfirmed(u) : true));

  const nftUtxo = commitment
    ? pool.find((u) => u.token!.nft!.commitment === commitment) || null
    : pool[0] || null;

  return { nftUtxo };
}

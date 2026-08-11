import type { FusionInputRef } from './fusionRound';

const DEFAULT_MIN_OUTPUT = 10_000;
const MAX_OUTPUTS_PER_PEER = 6;
const MAX_PARTICIPANTS = 20;
const MAX_INPUTS_PER_PEER = 20;
const TX_OVERHEAD_BYTES = 10;
const P2PKH_OUTPUT_BYTES = 34;

export interface P2pOutputPlanOptions {
  inputs: Array<Pick<FusionInputRef, 'value' | 'pubkey'>>;
  participantCount: number;
  feerate: number;
  minOutput?: number;
  /** Tier in sats — used for output value quantization. */
  tier?: number;
  /** Test seam. Production always uses Web Crypto. Must return [0, 1). */
  randomUnit?: () => number;
}

/**
 * Quantization grid for a given tier. Output values are rounded to the nearest
 * grid point, making different tiers look similar on-chain. The grid uses a
 * log-scale: small tiers get fine grids, large tiers get coarser grids.
 * This prevents tier fingerprinting while keeping output values meaningful.
 */
export function quantizationGrid(tier: number): number {
  if (tier <= 0) return 1;
  // Log-scale grid: tier=10K → 100, tier=100K → 500, tier=1M → 5000
  const magnitude = Math.pow(10, Math.floor(Math.log10(tier)));
  return Math.max(100, Math.round(magnitude / 20));
}

/** Maximum fee fuzz as a fraction of the fee — caps noise at 0.5%. */
const MAX_FEE_FUSS_FRACTION = 0.005;
const MAX_FEE_FUSS_SATS = 500;

export interface P2pOutputPlan {
  values: number[];
  feeShare: number;
}

function secureRandomUnit(): number {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('secure randomness is unavailable');
  }
  const words = new Uint32Array(2);
  globalThis.crypto.getRandomValues(words);
  const high21 = words[0] & 0x1fffff;
  return (high21 * 0x1_0000_0000 + words[1]) / 0x20_0000_0000_0000;
}

function checkedRandom(randomUnit: () => number): number {
  const value = randomUnit();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error('invalid secure random sample');
  }
  return value;
}

function inputSize(pubkeyHex: string): number {
  return 108 + pubkeyHex.length / 2;
}

function localFeeShare(
  inputs: Array<Pick<FusionInputRef, 'pubkey'>>,
  outputCount: number,
  participantCount: number,
  feerate: number
): number {
  const bytes =
    inputs.reduce((sum, input) => sum + inputSize(input.pubkey), 0) +
    outputCount * P2PKH_OUTPUT_BYTES +
    TX_OVERHEAD_BYTES / participantCount;
  return Math.ceil((bytes * feerate) / 1_000);
}

/**
 * Plan 2-4 random-valued outputs while assigning only this peer's measured
 * transaction-byte share to fees. Unlike the old tier allocator, every other
 * satoshi remains in wallet-controlled outputs.
 */
export function planP2pOutputValues(
  options: P2pOutputPlanOptions
): P2pOutputPlan {
  if (
    !Number.isSafeInteger(options.participantCount) ||
    options.participantCount < 2 ||
    options.participantCount > MAX_PARTICIPANTS
  ) {
    throw new Error('invalid P2P Fusion participant count');
  }
  if (
    !Number.isSafeInteger(options.feerate) ||
    options.feerate < 1 ||
    options.feerate > 100_000
  ) {
    throw new Error('invalid P2P Fusion fee rate');
  }
  if (
    options.inputs.length < 1 ||
    options.inputs.length > MAX_INPUTS_PER_PEER ||
    options.inputs.some(
      (input) =>
        !Number.isSafeInteger(input.value) ||
        input.value <= 0 ||
        !/^(02|03)[0-9a-f]{64}$/i.test(input.pubkey)
    )
  ) {
    throw new Error('invalid P2P Fusion input set');
  }

  const minimum = options.minOutput ?? DEFAULT_MIN_OUTPUT;
  if (!Number.isSafeInteger(minimum) || minimum < 546) {
    throw new Error('invalid P2P Fusion minimum output');
  }
  const sumIn = options.inputs.reduce((sum, input) => sum + input.value, 0);
  if (!Number.isSafeInteger(sumIn)) {
    throw new Error('P2P Fusion input value overflow');
  }

  let maxOutputs = 0;
  for (let count = MAX_OUTPUTS_PER_PEER; count >= 2; count -= 1) {
    const fee = localFeeShare(
      options.inputs,
      count,
      options.participantCount,
      options.feerate
    );
    if (sumIn - fee >= minimum * count) {
      maxOutputs = count;
      break;
    }
  }
  if (maxOutputs < 2) {
    throw new Error('Selected inputs cannot fund two Fusion outputs plus fee.');
  }

  const randomUnit = options.randomUnit ?? secureRandomUnit;
  const outputCount =
    2 + Math.floor(checkedRandom(randomUnit) * (maxOutputs - 1));
  const feeShare = localFeeShare(
    options.inputs,
    outputCount,
    options.participantCount,
    options.feerate
  );

  // Fee fuzz: add small random noise to prevent a chain analyst from inferring
  // the exact tier structure from the fee. Capped at 0.5% of the fee or 500
  // sats, whichever is smaller — and never more than leftover headroom after
  // funding minimum * outputCount (otherwise distributable goes negative and
  // values can drop below dust).
  const tier = options.tier ?? Math.max(...options.inputs.map((i) => i.value));
  const grid = quantizationGrid(tier);
  const maxFuzz = Math.min(
    Math.floor(feeShare * MAX_FEE_FUSS_FRACTION),
    MAX_FEE_FUSS_SATS,
    grid
  );
  const headroom = sumIn - feeShare - minimum * outputCount;
  const fuzzBudget = Math.max(0, Math.min(maxFuzz, headroom));
  const feeFuzz =
    fuzzBudget > 0
      ? Math.floor(checkedRandom(randomUnit) * fuzzBudget)
      : 0;
  const fuzzedFee = feeShare + feeFuzz;

  const outputTotal = sumIn - fuzzedFee;
  const distributable = Math.max(0, outputTotal - minimum * outputCount);
  const weights = Array.from(
    { length: outputCount },
    () => checkedRandom(randomUnit) + 0.1
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

  // Quantize each output value to the grid so different tiers produce
  // similar-looking outputs on-chain, defeating post-hoc tier fingerprinting.
  const values = weights.map(
    (weight) =>
      minimum +
      Math.floor(((weight / weightTotal) * distributable) / grid) * grid
  );
  const used = values.reduce((sum, value) => sum + value, 0);
  const remainderTarget = Math.floor(checkedRandom(randomUnit) * outputCount);
  values[remainderTarget] += outputTotal - used;

  return { values, feeShare: fuzzedFee };
}

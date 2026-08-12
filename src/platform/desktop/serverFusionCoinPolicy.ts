/**
 * Pure server-CashFusion coin policy, ported from Electron Cash
 * `electroncash_plugins/fusion/plugin.py` (`select_coins`,
 * `select_random_coins`, and `FUSE_DEPTH_THRESHOLD`).
 *
 * Adopted behavior:
 * - address is the indivisible linkage bucket;
 * - one bad coin rejects the entire address;
 * - only 1–3 confirmed, non-token, non-frozen coins per address are eligible;
 * - random selection is per bucket, capped at 20 coins, with EC's first-bucket
 *   fallback when sampling selects nothing;
 * - depth completion is by eligible value and stops at 99.9%; EC considers an
 *   address fused when any live coin at that address meets the requested depth.
 *
 * Coinbase maturity and historical-transaction semi-linkage are deliberately
 * outside this module because the wallet UTXO shape does not currently expose
 * the required authoritative metadata. Callers must prefilter coinbase inputs.
 */

import type { UTXO } from '../../types/types';

export const EC_SERVER_FUSION_MAX_COINS_PER_ADDRESS = 3;
export const EC_SERVER_FUSION_MAX_SELECTED_COINS = 20;
export const EC_SERVER_FUSION_DEPTH_VALUE_THRESHOLD = 0.999;

export type ServerFusionCoin = UTXO & {
  is_frozen_coin?: boolean;
  isFrozenCoin?: boolean;
  isFrozenAddress?: boolean;
  is_frozen_address?: boolean;
  frozen?: boolean;
  frozenFlags?: string;
};

export type ServerFusionSkipReason =
  | 'unconfirmed'
  | 'token'
  | 'frozen'
  | 'too-many-coins'
  | 'bad-value'
  | 'empty-address';

export type ServerFusionAddressBucket = Readonly<{
  address: string;
  coins: ServerFusionCoin[];
  value: number;
  skipReason?: ServerFusionSkipReason;
}>;

export type ServerFusionClassification = Readonly<{
  eligibleBuckets: ServerFusionAddressBucket[];
  ineligibleBuckets: ServerFusionAddressBucket[];
  totalValue: number;
  hasUnconfirmed: boolean;
  skipCounts: Partial<Record<ServerFusionSkipReason, number>>;
}>;

function coinValue(coin: ServerFusionCoin): number {
  return Number(coin.value ?? coin.satoshis ?? 0);
}

function hasFrozenFlag(coin: ServerFusionCoin): boolean {
  return Boolean(
    coin.is_frozen_coin ||
      coin.isFrozenCoin ||
      coin.isFrozenAddress ||
      coin.is_frozen_address ||
      coin.frozen ||
      (typeof coin.frozenFlags === 'string' && /[ac]/i.test(coin.frozenFlags))
  );
}

function bucketOf(
  address: string,
  coins: ServerFusionCoin[],
  skipReason?: ServerFusionSkipReason
): ServerFusionAddressBucket {
  return {
    address,
    coins: [...coins],
    value: coins.reduce((sum, coin) => sum + coinValue(coin), 0),
    ...(skipReason ? { skipReason } : {}),
  };
}

function coinLooksConfirmed(coin: ServerFusionCoin): boolean {
  if (Number(coin.height) > 0) return true;
  const confs = Number((coin as { confirmations?: number }).confirmations);
  return Number.isFinite(confs) && confs > 0;
}

function skipReasonForBucket(
  address: string,
  addressCoins: ServerFusionCoin[],
  requireConfirmed: boolean
): ServerFusionSkipReason | undefined {
  if (!address) return 'empty-address';
  if (addressCoins.length > EC_SERVER_FUSION_MAX_COINS_PER_ADDRESS) {
    return 'too-many-coins';
  }
  if (addressCoins.some((c) => c.token != null || c.token_data != null)) {
    return 'token';
  }
  if (addressCoins.some(hasFrozenFlag)) return 'frozen';
  if (
    addressCoins.some((c) => {
      const value = coinValue(c);
      return !Number.isSafeInteger(value) || value < 0;
    })
  ) {
    return 'bad-value';
  }
  if (requireConfirmed && addressCoins.some((c) => !coinLooksConfirmed(c))) {
    return 'unconfirmed';
  }
  return undefined;
}

export function classifyServerFusionCoins(
  coins: readonly ServerFusionCoin[],
  options?: { requireConfirmed?: boolean }
): ServerFusionClassification {
  const requireConfirmed = options?.requireConfirmed === true;
  const byAddress = new Map<string, ServerFusionCoin[]>();
  let totalValue = 0;
  let hasUnconfirmed = false;

  for (const coin of coins) {
    totalValue += coinValue(coin);
    if (!coinLooksConfirmed(coin)) hasUnconfirmed = true;
    const address = String(coin.address ?? '');
    const bucket = byAddress.get(address) ?? [];
    bucket.push(coin);
    byAddress.set(address, bucket);
  }

  const eligibleBuckets: ServerFusionAddressBucket[] = [];
  const ineligibleBuckets: ServerFusionAddressBucket[] = [];
  const skipCounts: Partial<Record<ServerFusionSkipReason, number>> = {};
  for (const [address, addressCoins] of byAddress) {
    const skipReason = skipReasonForBucket(
      address,
      addressCoins,
      requireConfirmed
    );
    if (skipReason) {
      skipCounts[skipReason] = (skipCounts[skipReason] ?? 0) + 1;
      ineligibleBuckets.push(bucketOf(address, addressCoins, skipReason));
    } else {
      eligibleBuckets.push(bucketOf(address, addressCoins));
    }
  }

  return {
    eligibleBuckets,
    ineligibleBuckets,
    totalValue,
    hasUnconfirmed,
    skipCounts,
  };
}

/** Why server Fusion has zero eligible address buckets. */
export function formatServerFusionEmptyReason(
  classified: ServerFusionClassification,
  options?: { auto?: boolean }
): string {
  const prefix = options?.auto ? 'Auto: ' : '';
  const bits = Object.entries(classified.skipCounts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([reason, n]) => `${reason}=${n}`);
  const why =
    bits.length > 0
      ? ` Skips: ${bits.join(', ')}.`
      : classified.ineligibleBuckets.length > 0
        ? ` ${classified.ineligibleBuckets.length} address bucket(s) skipped.`
        : '';
  return (
    `${prefix}no eligible server CashFusion address buckets.${why} ` +
    `Need 1–3 plain BCH coins per address (no tokens, not frozen` +
    `${classified.hasUnconfirmed && (classified.skipCounts.unconfirmed ?? 0) > 0 ? ', confirmed height' : ''}). ` +
    `Auto still stops at the rounds-per-coin box; Manual Start may re-fuse.`
  );
}

export type ServerFusionRandomSelectionOptions = Readonly<{
  fraction: number;
  random: () => number;
  maxCoins?: number;
  /** Disable only for deterministic order-sensitive tests. EC always shuffles. */
  shuffle?: boolean;
}>;

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error('server Fusion random source must return [0, 1)');
    }
    const j = Math.floor(sample * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function selectServerFusionBuckets(
  eligibleBuckets: readonly ServerFusionAddressBucket[],
  options: ServerFusionRandomSelectionOptions
): ServerFusionAddressBucket[] {
  if (!Number.isFinite(options.fraction)) {
    throw new Error('server Fusion selection fraction must be finite');
  }
  const fraction = Math.min(1, Math.max(0, options.fraction));
  const maxCoins = Math.max(
    0,
    Math.trunc(options.maxCoins ?? EC_SERVER_FUSION_MAX_SELECTED_COINS)
  );
  const candidates =
    options.shuffle === false
      ? [...eligibleBuckets]
      : shuffled(eligibleBuckets, options.random);
  const selected: ServerFusionAddressBucket[] = [];
  let selectedCoins = 0;

  for (const bucket of candidates) {
    if (selectedCoins >= maxCoins) break;
    if (selectedCoins + bucket.coins.length > maxCoins) continue;
    const sample = options.random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error('server Fusion random source must return [0, 1)');
    }
    if (sample > fraction) continue;
    selected.push(bucket);
    selectedCoins += bucket.coins.length;
  }

  if (selected.length === 0) {
    const fallback = candidates.find(
      (bucket) => bucket.coins.length > 0 && bucket.coins.length <= maxCoins
    );
    if (fallback) selected.push(fallback);
  }
  return selected;
}

export type ServerFusionDepthResult = Readonly<{
  satisfied: boolean;
  ratio: number;
  eligibleValue: number;
  depthSatisfiedValue: number;
}>;

const outpointOf = (coin: ServerFusionCoin): string =>
  `${String(coin.tx_hash).toLowerCase()}:${coin.tx_pos}`;

export function isServerFusionDepthSatisfied(
  eligibleBuckets: readonly ServerFusionAddressBucket[],
  options: Readonly<{
    fuseDepth: number;
    depthOf: (outpoint: string) => number;
  }>
): ServerFusionDepthResult {
  const fuseDepth = Math.max(0, Math.trunc(options.fuseDepth));
  const eligibleValue = eligibleBuckets.reduce(
    (sum, bucket) => sum + bucket.value,
    0
  );
  const depthSatisfiedValue = eligibleBuckets.reduce((sum, bucket) => {
    const addressIsFused =
      fuseDepth > 0 &&
      bucket.coins.some(
        (coin) => options.depthOf(outpointOf(coin)) >= fuseDepth
      );
    return sum + (addressIsFused ? bucket.value : 0);
  }, 0);
  const ratio = eligibleValue > 0 ? depthSatisfiedValue / eligibleValue : 0;
  return {
    satisfied:
      fuseDepth > 0 &&
      eligibleValue > 0 &&
      ratio >= EC_SERVER_FUSION_DEPTH_VALUE_THRESHOLD,
    ratio,
    eligibleValue,
    depthSatisfiedValue,
  };
}

import type {
  CauldronPool,
  CauldronPoolPair,
  CauldronPoolTrade,
  CauldronTokenId,
  CauldronTrade,
  CauldronTradeSummary,
} from './types';
import { CAULDRON_NATIVE_BCH } from './types';

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function calcCauldronTradeFee(amount: bigint): bigint {
  return (amount * 3n) / 1000n;
}

export function getMinCauldronReserve(tokenId: CauldronTokenId): bigint {
  return tokenId === CAULDRON_NATIVE_BCH ? 693n : 1n;
}

export function createCauldronPoolPair(
  pool: CauldronPool,
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId
): CauldronPoolPair {
  if (supplyTokenId === CAULDRON_NATIVE_BCH) {
    if (demandTokenId === CAULDRON_NATIVE_BCH) {
      throw new Error('A Cauldron trade must have exactly one BCH side');
    }
    if (pool.output.tokenCategory !== demandTokenId) {
      throw new Error('Pool token category does not match demand token');
    }
    return {
      reserveA: pool.output.amountSatoshis,
      reserveB: pool.output.tokenAmount,
      minReserveA: getMinCauldronReserve(supplyTokenId),
      minReserveB: getMinCauldronReserve(demandTokenId),
      feePaidInA: true,
    };
  }

  if (demandTokenId !== CAULDRON_NATIVE_BCH) {
    throw new Error('A Cauldron trade must have exactly one BCH side');
  }
  if (pool.output.tokenCategory !== supplyTokenId) {
    throw new Error('Pool token category does not match supply token');
  }

  return {
    reserveA: pool.output.tokenAmount,
    reserveB: pool.output.amountSatoshis,
    minReserveA: getMinCauldronReserve(supplyTokenId),
    minReserveB: getMinCauldronReserve(demandTokenId),
    feePaidInA: false,
  };
}

export function calcCauldronPairRate(
  pair: Pick<CauldronPoolPair, 'reserveA' | 'reserveB'>,
  rateDenominator: bigint
): bigint {
  const k = pair.reserveA * pair.reserveB;
  return (k * rateDenominator) / (pair.reserveB * pair.reserveB);
}

function includeFeeForTarget(target: bigint, initial: bigint): bigint {
  let previous = target;
  let current = target + calcCauldronTradeFee(target - initial);
  let oneStepAttempts = 0;

  while (current - calcCauldronTradeFee(current - initial) < target) {
    const extra = maxBigInt(1n, calcCauldronTradeFee(current - previous));
    previous = current;
    current += extra;
    if (extra === 1n && oneStepAttempts++ > 5) {
      throw new Error('Unable to converge on Cauldron fee-adjusted target');
    }
  }

  return current;
}

function leaveFeeInPoolForTarget(
  target: bigint,
  initial: bigint
): { value: bigint; tradeFee: bigint } {
  const x1 = ((target * 1000n + initial * 3n) / 1003n);
  for (const [threshold, candidate] of [
    [0n, x1 + 1n],
    [1n, x1],
  ] as const) {
    const reservedTradeFee = candidate - target;
    const tradeFee = calcCauldronTradeFee(initial - candidate);
    const diff = tradeFee - reservedTradeFee;
    if (diff >= 0n && diff <= threshold) {
      return { value: candidate + diff, tradeFee };
    }
  }

  throw new Error('Unable to leave the Cauldron fee in-pool for target');
}

function leaveFeeInPoolForMinTarget(
  target: bigint,
  initial: bigint
): { value: bigint; tradeFee: bigint } {
  const x1 = ((target * 1003n - initial * 3n) / 1000n);
  for (const [threshold, candidate] of [
    [0n, x1 + 1n],
    [1n, x1],
  ] as const) {
    const reservedTradeFee = target - candidate;
    const tradeFee = calcCauldronTradeFee(initial - target);
    const diff = reservedTradeFee - tradeFee;
    if (diff >= 0n && diff <= threshold) {
      return { value: candidate - diff, tradeFee };
    }
  }

  throw new Error('Unable to leave the Cauldron fee in-pool for min target');
}

function assertTradeSanity(args: {
  pair: CauldronPoolPair;
  nextA: bigint;
  nextB: bigint;
  tradeFee: bigint;
  k: bigint;
}): void {
  const { pair, nextA, nextB, tradeFee, k } = args;

  if (nextB > pair.reserveB) {
    throw new Error('Invalid Cauldron trade: next reserve exceeds source reserve');
  }
  if (nextA * nextB < k) {
    throw new Error('Invalid Cauldron trade: invariant violated');
  }

  if (pair.feePaidInA) {
    if ((nextA - tradeFee) * nextB < k) {
      throw new Error('Invalid Cauldron trade: fee-adjusted invariant violated');
    }
    if ((nextA - tradeFee - 1n) * nextB >= k) {
      throw new Error('Invalid Cauldron trade: surplus left in pool');
    }
    if ((nextA - tradeFee) * (nextB - 1n) >= k) {
      throw new Error('Invalid Cauldron trade: surplus left in token reserve');
    }
  } else {
    if (nextA * (nextB - tradeFee) < k) {
      throw new Error('Invalid Cauldron trade: fee-adjusted invariant violated');
    }
    if ((nextA - 1n) * (nextB - tradeFee) >= k) {
      throw new Error('Invalid Cauldron trade: surplus left in pool');
    }
    if (nextA * (nextB - tradeFee - 1n) >= k) {
      throw new Error('Invalid Cauldron trade: surplus left in BCH reserve');
    }
  }

  if (nextA < pair.minReserveA || nextB < pair.minReserveB) {
    throw new Error('Invalid Cauldron trade: reserve floor violated');
  }
}

export function calcCauldronTradeWithTargetDemand(
  pair: CauldronPoolPair,
  demandAmount: bigint
): CauldronTrade | null {
  const k = pair.reserveA * pair.reserveB;
  const preB1 = maxBigInt(pair.minReserveB, pair.reserveB - demandAmount);
  const a1 = ceilDiv(k, preB1);
  const b1 = ceilDiv(k, a1);

  if (b1 > preB1) {
    throw new Error('Derived post-trade reserve exceeds target reserve');
  }

  let nextA: bigint;
  let nextB: bigint;
  let tradeFee: bigint;

  if (pair.feePaidInA) {
    nextA = includeFeeForTarget(a1, pair.reserveA);
    nextB = b1;
    tradeFee = calcCauldronTradeFee(nextA - pair.reserveA);
  } else {
    nextA = a1;
    const adjusted = leaveFeeInPoolForTarget(b1, pair.reserveB);
    nextB = adjusted.value;
    tradeFee = adjusted.tradeFee;
  }

  assertTradeSanity({ pair, nextA, nextB, tradeFee, k });

  const supply = nextA - pair.reserveA;
  const demand = pair.reserveB - nextB;
  if (supply <= 0n || demand <= 0n) return null;

  return {
    supplyTokenId: CAULDRON_NATIVE_BCH,
    demandTokenId: CAULDRON_NATIVE_BCH,
    supply,
    demand,
    tradeFee,
  };
}

export function calcCauldronTradeWithTargetSupply(
  pair: CauldronPoolPair,
  supplyAmount: bigint
): CauldronTrade | null {
  if (supplyAmount <= 0n) return null;
  const k = pair.reserveA * pair.reserveB;
  let nextA: bigint;
  let nextB: bigint;
  let tradeFee: bigint;

  if (pair.feePaidInA) {
    const preA1 = pair.reserveA + supplyAmount - calcCauldronTradeFee(supplyAmount);
    const b1 = ceilDiv(k, preA1);
    const a1 = ceilDiv(k, b1);
    if (a1 <= pair.reserveA || b1 >= pair.reserveB || b1 < pair.minReserveB) {
      return null;
    }

    nextA = includeFeeForTarget(a1, pair.reserveA);
    nextB = b1;
    tradeFee = calcCauldronTradeFee(nextA - pair.reserveA);

    assertTradeSanity({ pair, nextA, nextB, tradeFee, k });

    const demand = pair.reserveB - nextB;
    if (demand <= 0n) return null;

    return {
      supplyTokenId: CAULDRON_NATIVE_BCH,
      demandTokenId: CAULDRON_NATIVE_BCH,
      supply: supplyAmount,
      demand,
      tradeFee,
    };
  } else {
    const minimumDemand = 1n;
    const maximumDemand = pair.reserveB - pair.minReserveB;
    let left = minimumDemand;
    let right = maximumDemand;
    let best: CauldronTrade | null = null;

    while (left <= right) {
      const demand = (left + right) / 2n;
      const candidate = calcCauldronTradeWithTargetDemand(pair, demand);
      if (!candidate) {
        right = demand - 1n;
        continue;
      }

      if (candidate.supply === supplyAmount) {
        return candidate;
      }

      if (candidate.supply < supplyAmount) {
        best = candidate;
        left = demand + 1n;
      } else {
        right = demand - 1n;
      }
    }

    if (best) {
      return best;
    }

    const postBWithoutFee = ceilDiv(k, pair.reserveA + supplyAmount);
    const adjusted = leaveFeeInPoolForMinTarget(postBWithoutFee, pair.reserveB);
    nextB = adjusted.value;
    tradeFee = adjusted.tradeFee;
  }

  nextA = pair.reserveA + supplyAmount;
  if (nextA <= pair.reserveA) return null;

  assertTradeSanity({ pair, nextA, nextB, tradeFee, k });

  const demand = pair.reserveB - nextB;
  if (demand <= 0n) return null;

  return {
    supplyTokenId: CAULDRON_NATIVE_BCH,
    demandTokenId: CAULDRON_NATIVE_BCH,
    supply: supplyAmount,
    demand,
    tradeFee,
  };
}

export function toCauldronPoolTrade(
  pool: CauldronPool,
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  trade: Pick<CauldronTrade, 'demand' | 'supply' | 'tradeFee'>
): CauldronPoolTrade {
  return {
    pool,
    supplyTokenId,
    demandTokenId,
    supply: trade.supply,
    demand: trade.demand,
    tradeFee: trade.tradeFee,
  };
}

export function summarizeCauldronTrade(
  trades: Array<Pick<CauldronTrade, 'demand' | 'supply' | 'tradeFee'>>,
  rateDenominator = 10_000_000_000_000n
): CauldronTradeSummary | null {
  const demand = trades.reduce((sum, trade) => sum + trade.demand, 0n);
  const supply = trades.reduce((sum, trade) => sum + trade.supply, 0n);
  if (demand <= 0n || supply <= 0n) return null;

  return {
    demand,
    supply,
    tradeFee: trades.reduce((sum, trade) => sum + trade.tradeFee, 0n),
    rateNumerator: (supply * rateDenominator) / demand,
    rateDenominator,
  };
}

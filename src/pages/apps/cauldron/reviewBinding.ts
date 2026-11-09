import {
  binToHex,
  encodeTransaction,
  type Transaction,
} from '@bitauth/libauth';

type ReviewedBuild = {
  estimatedFeeSatoshis: bigint;
  signRequest: { transaction: { transaction: Transaction } };
};

/** A rebuilt pool transaction needs another review whenever the signed plan changes. */
export function matchesReviewedPoolTransaction(
  reviewed: ReviewedBuild,
  rebuilt: ReviewedBuild
): boolean {
  try {
    return (
      reviewed.estimatedFeeSatoshis === rebuilt.estimatedFeeSatoshis &&
      binToHex(
        encodeTransaction(reviewed.signRequest.transaction.transaction)
      ) ===
        binToHex(encodeTransaction(rebuilt.signRequest.transaction.transaction))
    );
  } catch {
    return false;
  }
}

/** A swap must retain both its signed bytes and the amounts shown in review. */
export function matchesReviewedTradeQuote(
  reviewed: ReviewedBuild & { totalSupply: bigint; totalDemand: bigint },
  rebuilt: ReviewedBuild & { totalSupply: bigint; totalDemand: bigint }
): boolean {
  return (
    reviewed.totalSupply === rebuilt.totalSupply &&
    reviewed.totalDemand === rebuilt.totalDemand &&
    matchesReviewedPoolTransaction(reviewed, rebuilt)
  );
}

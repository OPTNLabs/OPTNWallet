import type { TransactionHistoryItem } from '../types/types';

export type TransactionDetailRefreshPlan = {
  txidsToRefresh: string[];
  reorgDetected: boolean;
};

export function planTransactionDetailRefresh(args: {
  previous: TransactionHistoryItem[];
  next: TransactionHistoryItem[];
}): TransactionDetailRefreshPlan {
  const previousByHash = new Map(
    args.previous.map((tx) => [tx.tx_hash, tx] as const)
  );
  const txids = new Set<string>();
  let reorgDetected = false;

  for (const nextTx of args.next) {
    const prevTx = previousByHash.get(nextTx.tx_hash);
    if (!prevTx) {
      txids.add(nextTx.tx_hash);
      continue;
    }

    if (prevTx.height === nextTx.height) {
      continue;
    }

    txids.add(nextTx.tx_hash);

    const prevHeight = Number(prevTx.height ?? 0);
    const nextHeight = Number(nextTx.height ?? 0);
    if (prevHeight > 0 && nextHeight > 0 && nextHeight < prevHeight) {
      reorgDetected = true;
      continue;
    }

    if (prevHeight > 0 && nextHeight <= 0) {
      reorgDetected = true;
      continue;
    }

    if (prevHeight > 0 && nextHeight > 0 && nextHeight !== prevHeight) {
      reorgDetected = true;
    }
  }

  return {
    txidsToRefresh: Array.from(txids),
    reorgDetected,
  };
}

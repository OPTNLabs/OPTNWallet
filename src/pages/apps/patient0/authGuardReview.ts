import type { TransactionOutput, UTXO } from '../../../types/types';
import { summarizeBuilderReview } from '../../../features/transaction/builderReview';

export type AuthGuardBroadcastReview = {
  hex: string;
  bytes: number;
  inputs: UTXO[];
  outputs: TransactionOutput[];
  feeSats: number;
};

export type AuthGuardReviewContext = {
  walletId: number;
  network: string;
};

export type ContextualAuthGuardBroadcastReview = AuthGuardBroadcastReview &
  AuthGuardReviewContext;

export function assertAuthGuardReviewContext(
  prepared: AuthGuardReviewContext,
  current: AuthGuardReviewContext
): void {
  if (
    prepared.walletId !== current.walletId ||
    prepared.network !== current.network
  ) {
    throw new Error(
      'Wallet or network changed. Prepare the transaction again; nothing was broadcast.'
    );
  }
}

export async function authorizeAuthGuardBroadcast<T>(
  transaction: ContextualAuthGuardBroadcastReview,
  currentContext: () => AuthGuardReviewContext,
  requestApproval: () => Promise<boolean>,
  broadcast: (hex: string) => Promise<T>
): Promise<T | null> {
  assertAuthGuardReviewContext(transaction, currentContext());
  if (!(await requestApproval())) return null;
  assertAuthGuardReviewContext(transaction, currentContext());
  return await broadcast(transaction.hex);
}

export function prepareAuthGuardBroadcastReview(
  inputs: UTXO[],
  result: {
    hex: string;
    bytes: number;
    finalOutputs: TransactionOutput[] | null;
    errorMsg: string;
  }
): AuthGuardBroadcastReview {
  if (result.errorMsg) throw new Error(result.errorMsg);
  if (!/^(?:[0-9a-f]{2})+$/i.test(result.hex)) {
    throw new Error(
      'The built transaction is missing or invalid. Nothing was broadcast.'
    );
  }
  if (!Array.isArray(result.finalOutputs) || !result.finalOutputs.length) {
    throw new Error(
      'The final transaction outputs are unavailable. Nothing was broadcast.'
    );
  }
  const { feeSats, unaccountedTokens } = summarizeBuilderReview(
    inputs,
    result.finalOutputs
  );
  if (unaccountedTokens.length) {
    throw new Error(
      'The final transaction does not account for every input token. Nothing was broadcast.'
    );
  }
  return {
    hex: result.hex,
    bytes: result.bytes,
    inputs,
    outputs: result.finalOutputs,
    feeSats,
  };
}

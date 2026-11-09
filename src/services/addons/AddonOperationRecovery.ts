import type { AddonExecutionOperation } from '../AddonsSDK';
import type { AddonOperationStore } from '../AddonsSDK';

export type AddonOperationRecoveryResult =
  | { status: 'mempool' | 'confirmed' | 'rejected'; updatedAt?: string }
  | { status: 'submission_unknown'; updatedAt?: string };

/** Host-only chain/provider lookup used after a restart or timeout. */
export type AddonOperationRecoveryResolver = (operation: AddonExecutionOperation) =>
  Promise<AddonOperationRecoveryResult>;

/**
 * Reconciles persisted unknown submissions without exposing provider access to
 * an add-on. The resolver must be idempotent and use the operation's immutable
 * proposal commitment when querying wallet-owned state.
 */
export async function recoverAddonOperation(
  operation: AddonExecutionOperation,
  resolve: AddonOperationRecoveryResolver,
  now = new Date().toISOString()
): Promise<AddonExecutionOperation> {
  if (operation.status !== 'submission_unknown') return structuredClone(operation);
  if (!Number.isFinite(Date.parse(now)) || now.length > 64) {
    throw new Error('Addon operation recovery received an invalid timestamp');
  }
  const result = await resolve(structuredClone(operation));
  if (
    !result ||
    !['submission_unknown', 'mempool', 'confirmed', 'rejected'].includes(
      result.status
    )
  ) {
    throw new Error('Addon operation recovery returned an invalid status');
  }
  if (
    result.updatedAt !== undefined &&
    (!Number.isFinite(Date.parse(result.updatedAt)) ||
      result.updatedAt.length > 64)
  ) {
    throw new Error('Addon operation recovery returned an invalid timestamp');
  }
  if (
    result.updatedAt !== undefined &&
    Date.parse(result.updatedAt) < Date.parse(operation.updatedAt)
  ) {
    throw new Error('Addon operation recovery timestamp moved backwards');
  }
  return {
    ...structuredClone(operation),
    status: result.status,
    updatedAt: result.updatedAt ?? now,
  };
}

export async function recoverAndPersistAddonOperation(
  store: AddonOperationStore,
  operationId: string,
  resolve: AddonOperationRecoveryResolver,
  now = new Date().toISOString()
): Promise<AddonExecutionOperation | undefined> {
  const operation = await store.get(operationId);
  if (!operation) return undefined;
  const recovered = await recoverAddonOperation(operation, resolve, now);
  if (
    recovered.status !== operation.status ||
    recovered.updatedAt !== operation.updatedAt
  ) {
    await store.put(recovered);
  }
  return recovered;
}

import type {
  AddonExecutionOperation,
  AddonOperationStore,
} from '../AddonsSDK';
import {
  recoverAddonOperation,
  type AddonOperationRecoveryResolver,
} from './AddonOperationRecovery';

/**
 * Host lifecycle helper for restart recovery. The add-on never receives the
 * store or resolver; callers should run this from the wallet reconciliation
 * worker before making recovered operation state visible to an add-on.
 */
export async function recoverPersistedAddonOperations(
  store: AddonOperationStore,
  resolve: AddonOperationRecoveryResolver,
  now = new Date().toISOString(),
  onError?: (operation: AddonExecutionOperation, error: unknown) => void
): Promise<AddonExecutionOperation[]> {
  if (!store.list) return [];
  const operations = await store.list();
  const recovered: AddonExecutionOperation[] = [];
  for (const operation of operations) {
    if (operation.status !== 'submission_unknown') continue;
    let next: AddonExecutionOperation;
    try {
      next = await recoverAddonOperation(operation, resolve, now);
    } catch (error) {
      // A provider failure must not prevent other operations from being
      // reconciled. Keep this record unknown for a later retry.
      try {
        onError?.(operation, error);
      } catch {
        // Telemetry is advisory and must not change recovery semantics.
      }
      recovered.push(operation);
      continue;
    }
    if (
      next.status !== operation.status ||
      next.updatedAt !== operation.updatedAt
    ) {
      await store.put(next);
    }
    recovered.push(next);
  }
  return recovered;
}

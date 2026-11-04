import type { AddonOperationRecoveryResolver } from './AddonOperationRecovery';

export type AddonTransactionVisibility = {
  seen: boolean;
  confirmed: boolean;
};

/**
 * Creates the host-only resolver used after an ambiguous submission. Missing
 * or ambiguous provider visibility stays unknown; absence is not proof of
 * rejection because providers can lag or temporarily fail.
 */
export function createAddonTransactionVisibilityRecoveryResolver(
  getVisibility: (txid: string) => Promise<AddonTransactionVisibility>
): AddonOperationRecoveryResolver {
  return async (operation) => {
    if (!operation.txid) return { status: 'submission_unknown' };
    if (!/^[0-9a-f]{64}$/.test(operation.txid)) {
      throw new Error('Addon operation contains an invalid transaction id');
    }
    const visibility = await getVisibility(operation.txid);
    if (
      !visibility ||
      typeof visibility.seen !== 'boolean' ||
      typeof visibility.confirmed !== 'boolean'
    ) {
      throw new Error('Transaction visibility response is invalid');
    }
    if (!visibility.seen) return { status: 'submission_unknown' };
    return visibility.confirmed
      ? { status: 'confirmed' }
      : { status: 'mempool' };
  };
}

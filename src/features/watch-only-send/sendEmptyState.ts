export function noSpendableBchCoinsHint(isMultisig: boolean): string {
  return isMultisig
    ? 'No spendable BCH coins found. Refresh the multisig address inventory and make sure it holds BCH (not only tokens).'
    : 'No spendable BCH coins found. Refresh this wallet’s coin list and make sure it holds BCH (not only tokens).';
}

export function unsignedBuildAvailability({
  busy,
  networkRefreshing,
  networkRefreshFailed,
  selectedInputCount,
  availableInputCount,
}: {
  busy: boolean;
  networkRefreshing: boolean;
  networkRefreshFailed: boolean;
  selectedInputCount: number;
  availableInputCount: number;
}): { disabled: boolean; reason: string | null } {
  if (busy || networkRefreshing || networkRefreshFailed) {
    return { disabled: true, reason: null };
  }
  if (selectedInputCount === 0) {
    return {
      disabled: true,
      reason:
        availableInputCount === 0
          ? 'A spendable BCH coin is required to build an unsigned transaction.'
          : 'Select at least one coin to build an unsigned transaction.',
    };
  }
  return { disabled: false, reason: null };
}

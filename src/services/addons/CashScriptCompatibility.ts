import { Contract } from 'cashscript';

export type CashScriptContractType = 'p2sh20' | 'p2sh32' | 'p2s';

/**
 * The wallet owns this compatibility seam. CashScript 0.13 and the planned
 * 0.14 release differ in constructor option names and builder conveniences;
 * callers must not spread those version checks through wallet policy code.
 */
export function createWalletCashScriptContract(args: {
  artifact: unknown;
  constructorArgs: unknown[];
  provider: unknown;
  contractType: CashScriptContractType;
}): unknown {
  const ContractConstructor = Contract as unknown as new (
    artifact: unknown,
    constructorArgs: unknown[],
    options: unknown,
  ) => unknown;
  const options = {
    provider: args.provider,
    contractType: args.contractType,
    // 0.14 uses contractType; older releases use addressType. Supplying both
    // keeps the migration boundary data-compatible without version parsing.
    addressType: args.contractType,
  };
  try {
    return new ContractConstructor(args.artifact, args.constructorArgs, options);
  } catch (error) {
    // Older CashScript builds used addressType. Keep this fallback isolated so
    // migrating to 0.14 only requires changing this adapter.
    if (args.contractType === 'p2s') throw error;
    return new ContractConstructor(args.artifact, args.constructorArgs, {
      provider: args.provider,
      addressType: args.contractType,
    } as never);
  }
}

export function hasCashScriptChangeHelpers(builder: object): boolean {
  const candidate = builder as {
    addBchChangeOutputIfNeeded?: unknown;
    addTokenChangeOutputIfNeeded?: unknown;
  };
  return typeof candidate.addBchChangeOutputIfNeeded === 'function' &&
    typeof candidate.addTokenChangeOutputIfNeeded === 'function';
}

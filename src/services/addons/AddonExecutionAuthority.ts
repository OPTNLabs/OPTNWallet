import type {
  AddonSDKContext,
  AddonExecutionResult,
  AddonTransactionProposal,
} from '../AddonsSDK';

export type AddonExecutionScheme = 'p2pkh-bch' | 'cashtoken' | 'contract';

/**
 * Internal wallet-owned execution contract. Implementations must keep key
 * material, unlockers, providers and raw transaction builders private.
 */
export type AddonExecutionAuthority = {
  supportedSchemes: ReadonlySet<AddonExecutionScheme>;
  validate(proposal: AddonTransactionProposal): Promise<void>;
  approve(args: {
    proposal: AddonTransactionProposal;
    mode: 'wallet-submit' | 'signed-export';
  }): Promise<boolean>;
  execute(args: {
    proposal: AddonTransactionProposal;
    mode: 'wallet-submit' | 'signed-export';
    idempotencyKey?: string;
  }): Promise<AddonExecutionResult>;
};

export function bindAddonExecutionAuthority(
  authority: AddonExecutionAuthority
): Pick<
  AddonSDKContext,
  'approveExecution' | 'executeProposal' | 'validateProposalAuthority'
> {
  return {
    validateProposalAuthority: (proposal) =>
      authority.validate(proposal).then(() => true),
    approveExecution: authority.approve,
    executeProposal: authority.execute,
  };
}

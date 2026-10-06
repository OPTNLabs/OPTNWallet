import type {
  AddonTransactionProposal,
  AddonExecutionResult,
} from '../AddonsSDK';
import type {
  AddonExecutionAuthority,
  AddonExecutionScheme,
} from './AddonExecutionAuthority';

export type AddonExecutionRoute = {
  name: string;
  matches(proposal: AddonTransactionProposal): boolean;
  authority: AddonExecutionAuthority;
};

function selectRoute(
  routes: readonly AddonExecutionRoute[],
  proposal: AddonTransactionProposal
): AddonExecutionRoute {
  const matches = routes.filter((route) => route.matches(proposal));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'No wallet execution authority supports this proposal'
        : `Multiple wallet execution authorities match this proposal: ${matches
            .map((route) => route.name)
            .join(', ')}`
    );
  }
  return matches[0];
}

/**
 * Routes proposals to exactly one host-owned authority. A route match is
 * evaluated again for validate, approve, and execute, so a caller cannot
 * validate one scheme and execute another through a shared callback.
 */
export function createAddonExecutionRouter(
  routes: readonly AddonExecutionRoute[]
): AddonExecutionAuthority {
  if (routes.length === 0) throw new Error('Execution router requires a route');
  const supportedSchemes = new Set<AddonExecutionScheme>();
  for (const route of routes) {
    for (const scheme of route.authority.supportedSchemes) {
      supportedSchemes.add(scheme);
    }
  }

  return {
    supportedSchemes,
    async validate(proposal) {
      await selectRoute(routes, proposal).authority.validate(proposal);
    },
    async approve(args) {
      return await selectRoute(routes, args.proposal).authority.approve(args);
    },
    async execute(args): Promise<AddonExecutionResult> {
      return await selectRoute(routes, args.proposal).authority.execute(args);
    },
  };
}

export function hasCashTokenProposalState(
  proposal: AddonTransactionProposal
): boolean {
  return Boolean(
    proposal.tokenIntent ||
      proposal.inputs.some(
        (input) =>
          input.tokenCategory ||
          input.tokenAmount !== undefined ||
          input.tokenNft
      ) ||
      proposal.outputs.some(
        (output) => !('opReturn' in output) && Boolean(output.token)
      )
  );
}

export function hasContractProposalState(
  proposal: AddonTransactionProposal
): boolean {
  return Boolean(proposal.contract);
}

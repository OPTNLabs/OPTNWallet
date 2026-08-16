type ProposalLike = {
  template?: {
    name?: string;
    actions?: Record<
      string,
      { instructions?: Array<{ type?: string }> } | undefined
    >;
  };
};

export function listCashConnectActionNames(proposal: ProposalLike): string[] {
  return Object.keys(proposal.template?.actions ?? {});
}

export function cashConnectProposalHasTransactions(
  proposal: ProposalLike
): boolean {
  return Object.values(proposal.template?.actions ?? {}).some((action) =>
    action?.instructions?.some((instruction) => instruction.type === 'transaction')
  );
}
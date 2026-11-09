import type { TransactionOutput, UTXO, Token } from '../../types/types';
import type { AddonTransactionProposal } from '../AddonsSDK';
import { assertAddonProposalExecutable } from './AddonExecutionPreflight';

/**
 * Side-effect-free preparation for CashToken proposals. This intentionally
 * stops before signing or broadcasting: the host must supply a reviewed
 * token-aware builder and signer before this becomes an execution authority.
 */
export type CashTokenExecutionPreparation = {
  inputs: UTXO[];
  outputs: TransactionOutput[];
};

function tokenFrom(
  category?: string,
  amount?: string,
  nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: string }
): Token | undefined {
  if (!category && amount === undefined) return undefined;
  if (!category || amount === undefined) {
    throw new Error('CashToken input must include category and amount');
  }
  return { category, amount: BigInt(amount), ...(nft ? { nft } : {}) };
}

export function prepareCashTokenExecution(
  proposal: AddonTransactionProposal
): CashTokenExecutionPreparation {
  assertAddonProposalExecutable(proposal);
  const inputs: UTXO[] = proposal.inputs.map((input) => ({
    address: input.address,
    tx_hash: input.txid,
    tx_pos: input.vout,
    value: Number(BigInt(input.valueSats)),
    height: 0,
    token: tokenFrom(input.tokenCategory, input.tokenAmount, input.tokenNft),
  }));
  const outputs = proposal.outputs.map((output) => {
    if ('opReturn' in output) return { opReturn: [...(output.opReturn ?? [])] };
    return {
      recipientAddress: output.recipientAddress,
      amount: output.amount,
      ...(output.token
        ? {
            token: {
              category: output.token.category,
              amount: BigInt(output.token.amount),
              ...(output.token.nft ? { nft: { ...output.token.nft } } : {}),
            },
          }
        : {}),
    } as TransactionOutput;
  });
  return { inputs, outputs };
}

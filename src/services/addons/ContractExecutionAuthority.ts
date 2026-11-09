import type { AddonTransactionProposal, AddonExecutionResult } from '../AddonsSDK';
import type { AddonExecutionAuthority } from './AddonExecutionAuthority';
import { assertAddonProposalExecutable } from './AddonExecutionPreflight';
import { validateCashTokenProposal } from './CashTokenProposalValidator';

/**
 * Wallet-owned CashScript execution boundary. The runtime implementation is
 * the only place allowed to instantiate CashScript Contract objects, create
 * unlockers, resolve signer bindings, and invoke the transaction builder.
 */
export type ContractExecutionRuntime = {
  verifyInputs(args: { proposal: AddonTransactionProposal; inputs: unknown[] }): Promise<void>;
  buildAndSend(args: {
    proposal: AddonTransactionProposal;
    mode: 'wallet-submit';
  }): Promise<{
    txid: string | null;
    errorMessage: string | null;
    broadcastState?: 'broadcasted' | 'submitted';
  }>;
};

function assertContractProposal(proposal: AddonTransactionProposal) {
  assertAddonProposalExecutable(proposal);
  const contract = proposal.contract;
  if (!contract || typeof contract !== 'object') {
    throw new Error('Contract authority requires contract proposal metadata');
  }
  if (typeof contract.contractId !== 'string' || !/^[0-9a-f]{64}$/.test(contract.contractId)) {
    throw new Error('Contract proposal contains an invalid contract id');
  }
  if (!contract.artifact || typeof contract.artifact !== 'object') {
    throw new Error('Contract proposal contains an invalid artifact');
  }
  if (!contract.functionName || typeof contract.functionName !== 'string') {
    throw new Error('Contract proposal contains an invalid function name');
  }
  if (contract.contractAddress !== undefined && typeof contract.contractAddress !== 'string') {
    throw new Error('Contract proposal contains an invalid contract address');
  }
  if (!Array.isArray(contract.functionArgs)) {
    throw new Error('Contract proposal contains invalid function arguments');
  }
  const indexes = contract.contractInputIndexes;
  if (!Array.isArray(indexes) || indexes.length === 0) {
    throw new Error('Contract proposal must identify contract input indexes');
  }
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= proposal.inputs.length) ||
      new Set(indexes).size !== indexes.length) {
    throw new Error('Contract proposal contains invalid contract input indexes');
  }
  for (const binding of contract.signerBindings ?? []) {
    if (
      !binding ||
      typeof binding.address !== 'string' ||
      binding.purpose !== 'wallet-spend'
    ) {
      throw new Error('Contract proposal contains an invalid signer binding');
    }
  }
  for (const argument of contract.functionArgs as Array<{
    type?: string;
    signer?: { purpose?: string };
  }>) {
    if (argument?.type === 'datasig' && argument.signer?.purpose === 'wallet-spend') {
      throw new Error('Wallet-owned datasig signing is not enabled; provide an external datasig value');
    }
  }
  return contract;
}

export function createContractExecutionAuthority(
  runtime: ContractExecutionRuntime
): AddonExecutionAuthority {
  return {
    supportedSchemes: new Set(['contract']),
    async validate(proposal) {
      const contract = assertContractProposal(proposal);
      const tokenCheck = validateCashTokenProposal(proposal);
      if (!tokenCheck.ok) throw new Error(tokenCheck.errors.join('; '));
      await runtime.verifyInputs({ proposal, inputs: proposal.inputs });
      // Keep the artifact and function data in the proposal commitment; the
      // runtime must independently revalidate them before constructing the
      // CashScript unlocker.
      if (contract.functionName.length > 128) {
        throw new Error('Contract function name exceeds the limit');
      }
    },
    async approve() {
      return true;
    },
    async execute({ proposal, mode }): Promise<AddonExecutionResult> {
      assertContractProposal(proposal);
      const tokenCheck = validateCashTokenProposal(proposal);
      if (!tokenCheck.ok) throw new Error(tokenCheck.errors.join('; '));
      if (mode !== 'wallet-submit') {
        throw new Error('Contract authority does not support signed export');
      }
      const submitted = await runtime.buildAndSend({ proposal, mode });
      if (submitted.errorMessage) throw new Error(submitted.errorMessage);
      if (
        submitted.broadcastState !== undefined &&
        submitted.broadcastState !== 'broadcasted' &&
        submitted.broadcastState !== 'submitted'
      ) {
        throw new Error('Wallet returned an invalid contract broadcast state');
      }
      if (submitted.txid && !/^[0-9a-f]{64}$/.test(submitted.txid)) {
        throw new Error('Wallet returned an invalid contract transaction id');
      }
      return {
        operationId: `optn-operation-v1:${proposal.commitmentHex}`,
        ...(submitted.txid ? { txid: submitted.txid } : {}),
        status:
          submitted.broadcastState === 'broadcasted'
            ? 'mempool'
            : 'submission_unknown',
      };
    },
  };
}

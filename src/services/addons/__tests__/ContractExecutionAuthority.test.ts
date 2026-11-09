import { describe, expect, it, vi } from 'vitest';
import { createContractExecutionAuthority } from '../ContractExecutionAuthority';

const proposal = {
  proposalId: 'p', commitmentHex: 'aa'.repeat(32), walletId: 1,
  network: 'chipnet', sessionId: null, grantRevision: null, authorityEpoch: null,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  inputs: [{ txid: '11'.repeat(32), vout: 0, address: 'bitcoincash:qqinput', valueSats: '1000' }],
  outputs: [{ recipientAddress: 'bitcoincash:qqoutput', amount: 546 }],
  contract: {
    contractId: 'cc'.repeat(32), contractAddress: 'bitcoincash:qqinput', artifact: { contractName: 'Demo' },
    functionName: 'spend', functionArgs: [],
    contractInputIndexes: [0],
    signerBindings: [{ address: 'bitcoincash:qqsigner', purpose: 'wallet-spend' as const }],
  },
  status: 'proposed' as const,
};

describe('contract execution authority', () => {
  it('keeps CashScript building behind the wallet runtime', async () => {
    const runtime = {
      verifyInputs: vi.fn(async () => undefined),
      buildAndSend: vi.fn(async () => ({ txid: 'ab'.repeat(32), errorMessage: null, broadcastState: 'submitted' as const })),
    };
    const authority = createContractExecutionAuthority(runtime);
    await authority.validate(proposal);
    const result = await authority.execute({ proposal, mode: 'wallet-submit' });
    expect(runtime.verifyInputs).toHaveBeenCalled();
    expect(runtime.buildAndSend).toHaveBeenCalledWith({ proposal, mode: 'wallet-submit' });
    expect(result.status).toBe('submission_unknown');
  });

  it('rejects malformed contract metadata and signed export', async () => {
    const authority = createContractExecutionAuthority({
      verifyInputs: async () => undefined,
      buildAndSend: async () => ({ txid: null, errorMessage: null }),
    });
    await expect(authority.validate({ ...proposal, contract: undefined })).rejects.toThrow(/contract proposal/i);
    await expect(authority.execute({ proposal, mode: 'signed-export' })).rejects.toThrow(/signed export/i);
  });

  it('applies CashToken validation to contract proposals', async () => {
    const authority = createContractExecutionAuthority({
      verifyInputs: async () => undefined,
      buildAndSend: async () => ({ txid: null, errorMessage: null }),
    });
    const tokenProposal = {
      ...proposal,
      inputs: [{ ...proposal.inputs[0], tokenCategory: 'bad-category', tokenAmount: '1' }],
    };
    await expect(authority.validate(tokenProposal)).rejects.toThrow(/category/i);
  });

  it('rejects wallet-owned datasig bindings until a dedicated policy exists', async () => {
    const authority = createContractExecutionAuthority({
      verifyInputs: async () => undefined,
      buildAndSend: async () => ({ txid: null, errorMessage: null }),
    });
    const datasigProposal = {
      ...proposal,
      contract: {
        ...proposal.contract,
        functionArgs: [{ type: 'datasig', value: 'aa', signer: { address: 'bitcoincash:qsigner', purpose: 'wallet-spend' as const } }],
      },
    };
    await expect(authority.validate(datasigProposal)).rejects.toThrow(/datasig/i);
  });
});

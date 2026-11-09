import { describe, expect, it } from 'vitest';
import {
  validateCashScriptArtifact,
  validateCashScriptValues,
} from '../src/cashscript';
import { createAddonWalletClient } from '../src/client';

const artifact = {
  contractName: 'Demo',
  constructorInputs: [{ name: 'threshold', type: 'int' }],
  abi: [{ name: 'spend', inputs: [{ name: 'signature', type: 'sig' }] }],
  bytecode: 'OP_TRUE',
  compiler: { name: 'cashc', version: '0.14.0-next' },
};

describe('CashScript artifact boundary', () => {
  it('accepts the CashScript artifact ABI shape without resolving compiler versions', () => {
    expect(validateCashScriptArtifact(artifact)).toMatchObject({
      contractName: 'Demo',
      compiler: { name: 'cashc', version: '0.14.0-next' },
    });
  });

  it('rejects duplicate ABI functions and unsupported types', () => {
    expect(() => validateCashScriptArtifact({ ...artifact, abi: [
      { name: 'spend', inputs: [] },
      { name: 'spend', inputs: [] },
    ] })).toThrow(/duplicate/i);
    expect(() => validateCashScriptArtifact({ ...artifact, constructorInputs: [{ name: 'x', type: 'address' }] })).toThrow(/unsupported/i);
  });

  it('rejects constructor and function calls that do not match the ABI', async () => {
    const sdk = createAddonWalletClient({ request: async () => ({}) });
    expect(() => sdk.contracts.instantiate({ artifact, constructorArgs: [] }))
      .toThrow(/constructor expects/);
  });

  it('keeps integer values as decimal strings and validates typed values', () => {
    expect(validateCashScriptValues([
      { type: 'int', value: '100000000000000000000' },
      { type: 'bool', value: true },
      { type: 'bytes32', value: 'aa'.repeat(32) },
    ], 'args')).toHaveLength(3);
    expect(() => validateCashScriptValues([{ type: 'int', value: true }], 'args')).toThrow(/string/i);
  });

  it('sends contract instantiation through the closed public transport method', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const sdk = createAddonWalletClient({
      async request(method, params) {
        requests.push({ method, params });
        return {
          contractId: 'c'.repeat(64),
          contractName: 'Demo',
          contractType: 'p2sh32',
          address: 'bitcoincash:qqcontract',
          tokenAddress: 'bitcoincash:zcontract',
          lockingBytecode: '51',
          bytecode: '51',
          bytesize: 1,
          opcount: 0,
          compiler: { name: 'cashc', version: '0.14.0-next' },
        };
      },
    });
    const result = await sdk.contracts.instantiate({
      artifact,
      constructorArgs: [{ type: 'int', value: '100' }],
    });
    expect(result.contractName).toBe('Demo');
    expect(requests[0]).toMatchObject({ method: 'contracts.instantiate' });
  });

  it('allows explicit wallet signer references without accepting templates or unlockers', async () => {
    const sdk = createAddonWalletClient({
      async request(_method, params) {
        expect(params).toMatchObject({
          function: {
            args: [{ type: 'sig', signer: { address: 'bitcoincash:qqsigner', purpose: 'wallet-spend' } }],
          },
        });
        return {
          proposalId: 'proposal-1', commitmentHex: 'aa'.repeat(32), walletId: 1,
          network: 'chipnet', sessionId: null, grantRevision: null,
          authorityEpoch: null, createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1000).toISOString(), inputs: [],
          outputs: [{ recipientAddress: 'bitcoincash:qqrecipient', amount: 546 }],
          status: 'proposed',
        };
      },
    });
    await sdk.contracts.propose({
      contract: {
        contractId: 'c'.repeat(64), contractName: 'Demo', contractType: 'p2sh32',
        lockingBytecode: '51', bytecode: '51', bytesize: 1, opcount: 0,
        compiler: { name: 'cashc', version: '0.14.0-next' },
      },
      artifact,
      constructorArgs: [{ type: 'int', value: '100' }],
      function: { name: 'spend', args: [{ type: 'sig', signer: { address: 'bitcoincash:qqsigner', purpose: 'wallet-spend' } }] },
      inputs: [],
      contractInputIndexes: [],
      outputs: [{ recipientAddress: 'bitcoincash:qqrecipient', amount: 546 }],
      idempotencyKey: 'contract-1',
    });
  });
});

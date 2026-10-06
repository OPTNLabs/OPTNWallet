import { describe, expect, it } from 'vitest';
import type { AddonTransactionProposal } from '../../AddonsSDK';
import { assertAddonProposalExecutable } from '../AddonExecutionPreflight';

function proposal(
  overrides: Partial<AddonTransactionProposal> = {}
): AddonTransactionProposal {
  return {
    proposalId: 'preflight',
    commitmentHex: 'a'.repeat(64),
    walletId: 1,
    network: 'chipnet',
    sessionId: 'session',
    grantRevision: 1,
    authorityEpoch: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    inputs: [
      {
        txid: 'b'.repeat(64),
        vout: 0,
        address: 'bitcoincash:qqinput',
        valueSats: '2000',
      },
    ],
    outputs: [
      { recipientAddress: 'bitcoincash:qqoutput', amount: 1000n },
    ],
    status: 'proposed',
    ...overrides,
  };
}

describe('addon execution preflight', () => {
  it('rejects malformed numeric fields with a controlled validation error', () => {
    expect(() =>
      assertAddonProposalExecutable(
        proposal({ inputs: [{ ...proposal().inputs[0], valueSats: 'not-a-number' }] })
      )
    ).toThrow('invalid input value');

    expect(() =>
      assertAddonProposalExecutable(
        proposal({
          outputs: [
            { recipientAddress: 'bitcoincash:qqoutput', amount: 'not-a-number' as never },
          ],
        })
      )
    ).toThrow('invalid output value');
  });

  it('rejects malformed outpoints before wallet execution', () => {
    expect(() =>
      assertAddonProposalExecutable(
        proposal({ inputs: [{ ...proposal().inputs[0], txid: 'not-a-txid' }] })
      )
    ).toThrow('invalid input transaction ID');

    expect(() =>
      assertAddonProposalExecutable(
        proposal({ inputs: [{ ...proposal().inputs[0], vout: -1 }] })
      )
    ).toThrow('invalid input output index');
  });

  it('rejects invalid expiry timestamps instead of treating them as unbounded', () => {
    expect(() =>
      assertAddonProposalExecutable(proposal({ expiresAt: 'not-a-timestamp' }))
    ).toThrow('invalid expiry timestamp');
  });

  it('rejects empty persisted proposals before selecting an authority', () => {
    expect(() =>
      assertAddonProposalExecutable(proposal({ inputs: [] }))
    ).toThrow('at least one input');
    expect(() =>
      assertAddonProposalExecutable(proposal({ outputs: [] }))
    ).toThrow('at least one output');
  });

  it('rejects invalid wallet and network scope before execution', () => {
    expect(() =>
      assertAddonProposalExecutable({ ...proposal(), walletId: 0 })
    ).toThrow(/invalid wallet id/i);
    expect(() =>
      assertAddonProposalExecutable({
        ...proposal(),
        network: 'regtest' as never,
      })
    ).toThrow(/unsupported network/i);
  });
});

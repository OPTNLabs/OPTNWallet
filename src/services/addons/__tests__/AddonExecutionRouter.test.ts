import { describe, expect, it, vi } from 'vitest';
import type { AddonTransactionProposal } from '../../AddonsSDK';
import {
  createAddonExecutionRouter,
  hasCashTokenProposalState,
} from '../AddonExecutionRouter';

function proposal(token = false): AddonTransactionProposal {
  return {
    proposalId: token ? 'token' : 'bch',
    commitmentHex: 'a'.repeat(64),
    walletId: 1,
    network: 'chipnet',
    sessionId: 'session',
    grantRevision: 1,
    authorityEpoch: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    inputs: token
      ? [
          {
            txid: 'b'.repeat(64),
            vout: 0,
            address: 'bitcoincash:qqinput',
            valueSats: '2000',
            tokenCategory: 'c'.repeat(64),
            tokenAmount: '1',
          },
        ]
      : [
          {
            txid: 'b'.repeat(64),
            vout: 0,
            address: 'bitcoincash:qqinput',
            valueSats: '2000',
          },
        ],
    outputs: [
      token
        ? {
            recipientAddress: 'bitcoincash:qqoutput',
            amount: 1000n,
            token: { category: 'c'.repeat(64), amount: 1n },
          }
        : { recipientAddress: 'bitcoincash:qqoutput', amount: 1000n },
    ],
    status: 'proposed',
  };
}

function authority(
  label: string,
  scheme: 'p2pkh-bch' | 'cashtoken' = 'p2pkh-bch'
) {
  return {
    supportedSchemes: new Set([scheme]),
    validate: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue({
      operationId: `${label}-operation`,
      status: 'mempool' as const,
    }),
  };
}

describe('addon execution router', () => {
  it('selects exactly one authority for validation, approval, and execution', async () => {
    const bch = authority('bch', 'p2pkh-bch');
    const token = authority('token', 'cashtoken');
    const router = createAddonExecutionRouter([
      {
        name: 'bch',
        matches: (value) => !hasCashTokenProposalState(value),
        authority: bch,
      },
      {
        name: 'token',
        matches: hasCashTokenProposalState,
        authority: token,
      },
    ]);

    await router.validate(proposal(false));
    await router.approve({ proposal: proposal(false), mode: 'wallet-submit' });
    await router.execute({ proposal: proposal(false), mode: 'wallet-submit' });
    await router.validate(proposal(true));
    await router.execute({ proposal: proposal(true), mode: 'wallet-submit' });

    expect(bch.validate).toHaveBeenCalledOnce();
    expect(bch.approve).toHaveBeenCalledOnce();
    expect(bch.execute).toHaveBeenCalledOnce();
    expect(token.validate).toHaveBeenCalledOnce();
    expect(token.execute).toHaveBeenCalledOnce();
  });

  it('fails closed when routes overlap or no route matches', async () => {
    const first = authority('p2pkh-bch');
    const second = authority('cashtoken');
    const overlapping = createAddonExecutionRouter([
      { name: 'first', matches: () => true, authority: first },
      { name: 'second', matches: () => true, authority: second },
    ]);
    await expect(overlapping.validate(proposal())).rejects.toThrow(/multiple/i);

    const empty = createAddonExecutionRouter([
      { name: 'never', matches: () => false, authority: first },
    ]);
    await expect(empty.validate(proposal())).rejects.toThrow(
      /no wallet execution/i
    );
  });
});

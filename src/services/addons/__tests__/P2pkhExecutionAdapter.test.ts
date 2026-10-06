import { describe, expect, it, vi } from 'vitest';
import type { AddonTransactionProposal } from '../../AddonsSDK';
import { createP2pkhExecutionAuthority } from '../P2pkhExecutionAdapter';

const address = 'bitcoincash:qqp2pkhinput';

function proposal(): AddonTransactionProposal {
  return {
    proposalId: 'p2pkh-proposal',
    commitmentHex: 'a'.repeat(64),
    walletId: 1,
    network: 'chipnet',
    sessionId: 'session-1',
    grantRevision: 1,
    authorityEpoch: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    inputs: [
      {
        txid: 'b'.repeat(64),
        vout: 0,
        address,
        valueSats: '2000',
      },
    ],
    outputs: [{ recipientAddress: 'bitcoincash:qqp2pkhoutput', amount: 1000n }],
    status: 'proposed',
  };
}

function runtime(submission: Record<string, unknown>) {
  return {
    isP2pkhAddress: vi.fn(() => true),
    verifyInputs: vi.fn().mockResolvedValue(undefined),
    resolveChangeAddress: vi.fn().mockResolvedValue(address),
    buildTransaction: vi
      .fn()
      .mockResolvedValue({ finalTransaction: 'raw-p2pkh-tx', errorMsg: '' }),
    sendTransaction: vi.fn().mockResolvedValue(submission),
  };
}

describe('P2PKH execution authority', () => {
  it('rejects a runtime error even when a transaction id is returned', async () => {
    const authority = createP2pkhExecutionAuthority(
      runtime({
        txid: 'c'.repeat(64),
        errorMessage: 'provider rejected submission',
        broadcastState: 'submitted',
      })
    );

    await expect(
      authority.execute({ proposal: proposal(), mode: 'wallet-submit' })
    ).rejects.toThrow('provider rejected submission');
  });

  it('rejects an unknown runtime broadcast state', async () => {
    const authority = createP2pkhExecutionAuthority(
      runtime({
        txid: null,
        errorMessage: null,
        broadcastState: 'unknown' as never,
      })
    );

    await expect(
      authority.execute({ proposal: proposal(), mode: 'wallet-submit' })
    ).rejects.toThrow('invalid broadcast state');
  });
});

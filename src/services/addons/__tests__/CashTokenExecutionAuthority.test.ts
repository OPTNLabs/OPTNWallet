import { describe, expect, it, vi } from 'vitest';
import type { AddonTransactionProposal } from '../../AddonsSDK';
import { createCashTokenExecutionAuthority } from '../CashTokenExecutionAuthority';

const category = 'a'.repeat(64);
const inputAddress = 'bitcoincash:qqtokeninput';
const outputAddress = 'bitcoincash:qqtokenoutput';

function proposal(
  overrides: Partial<AddonTransactionProposal> = {}
): AddonTransactionProposal {
  return {
    proposalId: 'proposal-authority',
    commitmentHex: 'b'.repeat(64),
    walletId: 1,
    network: 'chipnet',
    sessionId: 'session-1',
    grantRevision: 1,
    authorityEpoch: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    inputs: [
      {
        txid: 'c'.repeat(64),
        vout: 0,
        address: inputAddress,
        valueSats: '3000',
        tokenCategory: category,
        tokenAmount: '10',
      },
    ],
    outputs: [
      {
        recipientAddress: outputAddress,
        amount: 1000n,
        token: { category, amount: 10n },
      },
    ],
    status: 'proposed',
    ...overrides,
  };
}

describe('CashToken execution authority', () => {
  it('validates token state and supported addresses without exposing keys', async () => {
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction: vi.fn(),
      sendTransaction: vi.fn(),
    };
    const authority = createCashTokenExecutionAuthority(runtime);

    await expect(authority.validate(proposal())).resolves.toBeUndefined();
    expect(authority.supportedSchemes).toEqual(new Set(['cashtoken']));
    expect(runtime.buildTransaction).not.toHaveBeenCalled();
    expect(runtime.sendTransaction).not.toHaveBeenCalled();
    expect(runtime.verifyInputs).toHaveBeenCalledOnce();
  });

  it('rejects token outputs below the protocol dust floor before building', async () => {
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction: vi.fn(),
      sendTransaction: vi.fn(),
    };
    const authority = createCashTokenExecutionAuthority(runtime);
    const invalid = proposal({
      outputs: [
        {
          recipientAddress: outputAddress,
          amount: 999n,
          token: { category, amount: 10n },
        },
      ],
    });

    await expect(authority.validate(invalid)).rejects.toThrow(
      /at least 1000 sats/i
    );
    expect(runtime.buildTransaction).not.toHaveBeenCalled();
  });

  it('builds and submits only through the injected wallet runtime', async () => {
    const buildTransaction = vi
      .fn()
      .mockResolvedValue({ finalTransaction: 'raw-token-tx', errorMsg: '' });
    const sendTransaction = vi.fn().mockResolvedValue({
      txid: 'd'.repeat(64),
      errorMessage: null,
      broadcastState: 'broadcasted',
    });
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction,
      sendTransaction,
    };
    const authority = createCashTokenExecutionAuthority(runtime);

    const result = await authority.execute({
      proposal: proposal(),
      mode: 'wallet-submit',
    });

    expect(result).toEqual({
      operationId: `optn-operation-v1:${'b'.repeat(64)}`,
      txid: 'd'.repeat(64),
      status: 'mempool',
    });
    expect(buildTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        changeAddress: inputAddress,
        allowImplicitFungibleTokenBurn: false,
        inputs: [expect.objectContaining({ token: { category, amount: 10n } })],
        outputs: [
          expect.objectContaining({ token: { category, amount: 10n } }),
        ],
      })
    );
    expect(sendTransaction).toHaveBeenCalledWith(
      'raw-token-tx',
      expect.any(Array)
    );
    expect(runtime.verifyInputs).toHaveBeenCalledOnce();
  });

  it('only enables the builder burn escape hatch for an explicit burn intent', async () => {
    const buildTransaction = vi
      .fn()
      .mockResolvedValue({ finalTransaction: 'raw-burn-tx', errorMsg: '' });
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction,
      sendTransaction: vi.fn().mockResolvedValue({
        txid: 'e'.repeat(64),
        errorMessage: null,
        broadcastState: 'submitted',
      }),
    };
    const authority = createCashTokenExecutionAuthority(runtime);

    await expect(
      authority.execute({
        proposal: proposal({
          outputs: [
            {
              recipientAddress: outputAddress,
              amount: 1000n,
              token: { category, amount: 7n },
            },
          ],
          tokenIntent: { kind: 'burn', category, amount: '3' },
        }),
        mode: 'wallet-submit',
      })
    ).resolves.toMatchObject({ status: 'submission_unknown' });

    expect(buildTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ allowImplicitFungibleTokenBurn: true })
    );
  });

  it('does not offer signed export or silently continue after a build failure', async () => {
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction: vi.fn().mockResolvedValue({
        finalTransaction: '',
        errorMsg: 'invalid token state',
      }),
      sendTransaction: vi.fn(),
    };
    const authority = createCashTokenExecutionAuthority(runtime);

    await expect(
      authority.execute({ proposal: proposal(), mode: 'signed-export' })
    ).rejects.toThrow(/signed export/i);
    await expect(
      authority.execute({ proposal: proposal(), mode: 'wallet-submit' })
    ).rejects.toThrow(/invalid token state/i);
    expect(runtime.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects malformed transaction ids from the wallet runtime', async () => {
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction: vi
        .fn()
        .mockResolvedValue({ finalTransaction: 'raw-token-tx', errorMsg: '' }),
      sendTransaction: vi.fn().mockResolvedValue({
        txid: 'not-a-txid',
        errorMessage: null,
        broadcastState: 'broadcasted',
      }),
    };
    const authority = createCashTokenExecutionAuthority(runtime);
    await expect(
      authority.execute({ proposal: proposal(), mode: 'wallet-submit' })
    ).rejects.toThrow(/invalid CashToken transaction id/i);
  });

  it('fails closed when the runtime reports an error alongside a transaction id', async () => {
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction: vi
        .fn()
        .mockResolvedValue({ finalTransaction: 'raw-token-tx', errorMsg: '' }),
      sendTransaction: vi.fn().mockResolvedValue({
        txid: 'f'.repeat(64),
        errorMessage: 'provider rejected submission',
        broadcastState: 'submitted',
      }),
    };
    const authority = createCashTokenExecutionAuthority(runtime);

    await expect(
      authority.execute({ proposal: proposal(), mode: 'wallet-submit' })
    ).rejects.toThrow('provider rejected submission');
  });

  it('rejects unknown broadcast states from the wallet runtime', async () => {
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction: vi
        .fn()
        .mockResolvedValue({ finalTransaction: 'raw-token-tx', errorMsg: '' }),
      sendTransaction: vi.fn().mockResolvedValue({
        txid: null,
        errorMessage: null,
        broadcastState: 'maybe' as never,
      }),
    };
    const authority = createCashTokenExecutionAuthority(runtime);

    await expect(
      authority.execute({ proposal: proposal(), mode: 'wallet-submit' })
    ).rejects.toThrow('invalid CashToken broadcast state');
  });

  it('rejects an unbounded builder result before broadcast', async () => {
    const runtime = {
      isSupportedAddress: vi.fn(() => true),
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue(inputAddress),
      buildTransaction: vi.fn().mockResolvedValue({
        finalTransaction: 'x'.repeat(2_000_001),
        errorMsg: '',
      }),
      sendTransaction: vi.fn(),
    };
    const authority = createCashTokenExecutionAuthority(runtime);
    await expect(
      authority.execute({ proposal: proposal(), mode: 'wallet-submit' })
    ).rejects.toThrow(/transaction build failed/i);
    expect(runtime.sendTransaction).not.toHaveBeenCalled();
  });
});

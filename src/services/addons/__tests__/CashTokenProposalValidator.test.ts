import { describe, expect, it } from 'vitest';
import type { AddonTransactionProposal } from '../../AddonsSDK';
import { validateCashTokenProposal } from '../CashTokenProposalValidator';

const category = 'a'.repeat(64);
const address = 'bitcoincash:qqtoken';

function makeProposal(
  overrides: Partial<AddonTransactionProposal>
): AddonTransactionProposal {
  return {
    proposalId: 'proposal-token-test',
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
        address,
        valueSats: '1000',
        tokenCategory: category,
        tokenAmount: '10',
      },
    ],
    outputs: [
      {
        recipientAddress: address,
        amount: 900n,
        token: { category, amount: 10n },
      },
    ],
    status: 'proposed',
    ...overrides,
  };
}

describe('CashToken proposal validation', () => {
  it('requires exact fungible and NFT conservation for ordinary transfers', () => {
    const nft = { capability: 'none' as const, commitment: '01' };
    const proposal = makeProposal({
      inputs: [
        {
          txid: 'c'.repeat(64),
          vout: 0,
          address,
          valueSats: '1000',
          tokenCategory: category,
          tokenAmount: '10',
          tokenNft: nft,
        },
      ],
      outputs: [
        {
          recipientAddress: address,
          amount: 900n,
          token: { category, amount: 10n, nft },
        },
      ],
    });
    expect(validateCashTokenProposal(proposal)).toEqual({ ok: true });

    const implicitBurn = makeProposal({
      outputs: [
        {
          recipientAddress: address,
          amount: 900n,
          token: { category, amount: 9n },
        },
      ],
    });
    expect(validateCashTokenProposal(implicitBurn)).toMatchObject({
      ok: false,
    });
  });

  it('validates an explicit fungible mint delta', () => {
    const result = validateCashTokenProposal(
      makeProposal({
        inputs: [
          {
            txid: category,
            vout: 0,
            address,
            valueSats: '1000',
          },
        ],
        outputs: [
          {
            recipientAddress: address,
            amount: 900n,
            token: { category, amount: 25n },
          },
        ],
        tokenIntent: { kind: 'mint-fungible', category, amount: '25' },
      })
    );
    expect(result).toEqual({ ok: true });
  });

  it('requires a minting authority and preserves it when minting an NFT', () => {
    const authority = { capability: 'minting' as const, commitment: '' };
    const minted = { capability: 'none' as const, commitment: 'abcd' };
    const result = validateCashTokenProposal(
      makeProposal({
        inputs: [
          {
            txid: 'c'.repeat(64),
            vout: 0,
            address,
            valueSats: '1000',
            tokenCategory: category,
            tokenAmount: '0',
            tokenNft: authority,
          },
        ],
        outputs: [
          {
            recipientAddress: address,
            amount: 400n,
            token: { category, amount: 0n, nft: authority },
          },
          {
            recipientAddress: address,
            amount: 400n,
            token: { category, amount: 0n, nft: minted },
          },
        ],
        tokenIntent: { kind: 'mint-nft', category, ...minted },
      })
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts genesis NFT minting without an authority input', () => {
    const minted = { capability: 'minting' as const, commitment: '' };
    const result = validateCashTokenProposal(
      makeProposal({
        inputs: [
          {
            txid: category,
            vout: 0,
            address,
            valueSats: '2000',
          },
        ],
        outputs: [
          {
            recipientAddress: address,
            amount: 1000n,
            token: { category, amount: 0n, nft: minted },
          },
        ],
        tokenIntent: { kind: 'mint-nft', category, ...minted },
      })
    );
    expect(result).toEqual({ ok: true });
  });

  it('supports explicit mutable NFT mutation and NFT burn', () => {
    const source = { capability: 'mutable' as const, commitment: '01' };
    const target = { capability: 'none' as const, commitment: '02' };
    const mutation = validateCashTokenProposal(
      makeProposal({
        inputs: [
          {
            txid: 'c'.repeat(64),
            vout: 0,
            address,
            valueSats: '1000',
            tokenCategory: category,
            tokenAmount: '0',
            tokenNft: source,
          },
        ],
        outputs: [
          {
            recipientAddress: address,
            amount: 900n,
            token: { category, amount: 0n, nft: target },
          },
        ],
        tokenIntent: { kind: 'mutate-nft', category, source, target },
      })
    );
    expect(mutation).toEqual({ ok: true });

    const burn = validateCashTokenProposal(
      makeProposal({
        inputs: [
          {
            txid: 'c'.repeat(64),
            vout: 0,
            address,
            valueSats: '1000',
            tokenCategory: category,
            tokenAmount: '10',
            tokenNft: source,
          },
        ],
        outputs: [
          {
            recipientAddress: address,
            amount: 900n,
            token: { category, amount: 7n },
          },
        ],
        tokenIntent: { kind: 'burn', category, amount: '3', nft: source },
      })
    );
    expect(burn).toMatchObject({ ok: false });
  });

  it('rejects protocol-invalid fungible amounts and commitments', () => {
    const zeroFungible = validateCashTokenProposal(
      makeProposal({
        outputs: [
          {
            recipientAddress: address,
            amount: 900n,
            token: { category, amount: 0n },
          },
        ],
      })
    );
    expect(zeroFungible).toMatchObject({ ok: false });

    const excessiveAmount = '9223372036854775808';
    const invalidAmount = validateCashTokenProposal(
      makeProposal({
        inputs: [
          {
            txid: 'c'.repeat(64),
            vout: 0,
            address,
            valueSats: '1000',
            tokenCategory: category,
            tokenAmount: excessiveAmount,
          },
        ],
        outputs: [
          {
            recipientAddress: address,
            amount: 900n,
            token: { category, amount: BigInt(excessiveAmount) },
          },
        ],
      })
    );
    expect(invalidAmount).toMatchObject({ ok: false });

    const oversizedCommitment = '00'.repeat(41);
    const invalidCommitment = validateCashTokenProposal(
      makeProposal({
        inputs: [
          {
            txid: 'c'.repeat(64),
            vout: 0,
            address,
            valueSats: '1000',
            tokenCategory: category,
            tokenAmount: '10',
            tokenNft: { capability: 'none', commitment: oversizedCommitment },
          },
        ],
        outputs: [
          {
            recipientAddress: address,
            amount: 900n,
            token: {
              category,
              amount: 10n,
              nft: { capability: 'none', commitment: oversizedCommitment },
            },
          },
        ],
      })
    );
    expect(invalidCommitment).toMatchObject({ ok: false });
  });

  it('returns validation errors for malformed runtime amounts instead of throwing', () => {
    const malformed = validateCashTokenProposal(
      makeProposal({
        inputs: [
          {
            txid: 'c'.repeat(64),
            vout: 0,
            address,
            valueSats: '1000',
            tokenCategory: category,
            tokenAmount: 'not-an-integer' as unknown as string,
          },
        ],
        outputs: [
          {
            recipientAddress: address,
            amount: 1000n,
            token: { category, amount: 10n },
          },
        ],
      })
    );
    expect(malformed).toMatchObject({ ok: false });
  });

  it('rejects zero or negative mint and burn intent amounts', () => {
    for (const amount of ['0', '-1']) {
      expect(
        validateCashTokenProposal(
          makeProposal({
            tokenIntent: { kind: 'mint-fungible', category, amount },
          })
        )
      ).toMatchObject({ ok: false });
      expect(
        validateCashTokenProposal(
          makeProposal({
            tokenIntent: { kind: 'burn', category, amount },
          })
        )
      ).toMatchObject({ ok: false });
    }
  });
});

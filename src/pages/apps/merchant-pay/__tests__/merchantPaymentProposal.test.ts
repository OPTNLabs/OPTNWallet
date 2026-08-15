import { describe, expect, it } from 'vitest';

import { Network } from '../../../../state/slices/networkSlice';
import { toTokenAwareCashAddress } from '../../../../utils/cashAddress';
import { CAULDRON_NATIVE_BCH } from '../../../../services/cauldron';
import {
  createMerchantPaymentProposalPayload,
  deserializeMerchantPaymentProposal,
  type MerchantPaymentProposal,
} from '../merchantPaymentProposal';

const tokenId =
  '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const merchantAddress = toTokenAwareCashAddress(
  'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
);

function createProposal(): MerchantPaymentProposal {
  const trade = {
    supplyTokenId: CAULDRON_NATIVE_BCH,
    demandTokenId: tokenId,
    supply: 850_000n,
    demand: 1_000n,
    tradeFee: 5n,
    pool: {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: new Uint8Array(20) },
      txHash: 'aa'.repeat(32),
      outputIndex: 1,
      ownerPublicKeyHash: null,
      ownerAddress: null,
      poolId: null,
      output: {
        amountSatoshis: 10_000_000n,
        tokenCategory: tokenId,
        tokenAmount: 10_000n,
        lockingBytecode: new Uint8Array([0x51]),
      },
    },
  };

  return {
    version: 1,
    kind: 'cauldron-merchant-payment-proposal',
    network: Network.MAINNET,
    requestId: 'merchant-proposal-1',
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_120_000,
    merchantAddress,
    tokenId,
    tokenDecimals: 2,
    tokenSymbol: 'PUSD',
    tokenAmountAtomic: 1_000n,
    maxBchSats: 850_000n,
    quoteProtectionBps: 100n,
    route: {
      supplyTokenId: CAULDRON_NATIVE_BCH,
      demandTokenId: tokenId,
      trades: [trade],
      summary: {
        supply: 850_000n,
        demand: 1_000n,
        tradeFee: 5n,
        rateNumerator: 1n,
        rateDenominator: 1n,
      },
    },
  };
}

describe('merchantPaymentProposal', () => {
  it('round-trips an LP route through the partial-signing QR transport', () => {
    const proposal = createProposal();
    const { payload } = createMerchantPaymentProposalPayload(proposal);

    expect(
      deserializeMerchantPaymentProposal(
        payload,
        Network.MAINNET,
        1_700_000_000_000
      )
    ).toEqual(proposal);
  });

  it('rejects a proposal with mismatched token demand', () => {
    const proposal = createProposal();
    proposal.route.summary.demand = 999n;

    expect(() => createMerchantPaymentProposalPayload(proposal)).toThrow(
      'route summary does not match'
    );
  });
});

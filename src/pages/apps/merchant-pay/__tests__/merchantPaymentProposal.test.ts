import { describe, expect, it } from 'vitest';

import { Network } from '../../../../state/slices/networkSlice';
import { toTokenAwareCashAddress } from '../../../../utils/cashAddress';
import { CAULDRON_NATIVE_BCH } from '../../../../services/cauldron';
import {
  createMerchantPaymentProposalPayload,
  deserializeMerchantPaymentProposal,
  buildMerchantPaymentTransactionTemplate,
  splitMerchantPaymentAmount,
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

function createReverseProposal(): MerchantPaymentProposal {
  const proposal = createProposal();
  const trade = proposal.route.trades[0]!;
  const reverseTrade = {
    ...trade,
    supplyTokenId: tokenId,
    demandTokenId: CAULDRON_NATIVE_BCH,
    supply: 1_000n,
    demand: 850_000n,
  };
  return {
    ...proposal,
    version: 2,
    tokenAmountAtomic: 0n,
    maxBchSats: 0n,
    incomingAsset: 'token',
    customerPaysAtomic: 1_000n,
    conversionBps: 10_000n,
    directIncomingAmountAtomic: 0n,
    merchantBchAmountSatoshis: 850_000n,
    merchantTokenAmountAtomic: 0n,
    route: {
      supplyTokenId: tokenId,
      demandTokenId: CAULDRON_NATIVE_BCH,
      trades: [reverseTrade],
      summary: {
        supply: 1_000n,
        demand: 850_000n,
        tradeFee: 5n,
        rateNumerator: 1n,
        rateDenominator: 1n,
      },
    },
  };
}

function createDirectTokenProposal(): MerchantPaymentProposal {
  const proposal = createProposal();
  return {
    ...proposal,
    version: 2,
    tokenAmountAtomic: 1_000n,
    maxBchSats: 0n,
    incomingAsset: 'token',
    customerPaysAtomic: 1_000n,
    conversionBps: 0n,
    directIncomingAmountAtomic: 1_000n,
    merchantBchAmountSatoshis: 0n,
    merchantTokenAmountAtomic: 1_000n,
    route: {
      supplyTokenId: tokenId,
      demandTokenId: CAULDRON_NATIVE_BCH,
      trades: [],
      summary: {
        supply: 0n,
        demand: 0n,
        tradeFee: 0n,
        rateNumerator: 0n,
        rateDenominator: 1n,
      },
    },
  };
}

describe('merchantPaymentProposal', () => {
  it('rounds conversion splits half-up at the asset atomic precision', () => {
    expect(splitMerchantPaymentAmount(500n, 3_333n)).toEqual({
      converted: 167n,
      direct: 333n,
    });
  });

  it('round-trips an LP route through the partial-signing QR transport', () => {
    const proposal = createProposal();
    const { payload } = createMerchantPaymentProposalPayload(proposal);
    const template = buildMerchantPaymentTransactionTemplate(proposal);

    expect(
      deserializeMerchantPaymentProposal(
        payload,
        Network.MAINNET,
        1_700_000_000_000
      )
    ).toEqual(proposal);
    expect(template.kind).toBe('cauldron-merchant-payment-template');
    expect(template.inputs).toEqual([
      {
        outpointTransactionHash: 'aa'.repeat(32),
        outpointIndex: 1,
        sequenceNumber: 0,
      },
    ]);
    expect(template.outputs).toHaveLength(2);
    expect(template.outputs[1]).toMatchObject({
      role: 'merchant-token',
      valueSatoshis: 1_000n,
      token: { category: tokenId, amount: 1_000n },
    });
    expect(template.funding).toMatchObject({
      signerRole: 'buyer',
      buyerInputs: 'variable-bch-only',
      buyerChange: 'variable-bch-after-merchant-output',
      merchantOutputIndex: 1,
    });
  });

  it('rejects a proposal with mismatched token demand', () => {
    const proposal = createProposal();
    proposal.route.summary.demand = 999n;

    expect(() => createMerchantPaymentProposalPayload(proposal)).toThrow(
      'route summary does not match'
    );
  });

  it('keeps a three-pool proposal within one normal QR payload', () => {
    const proposal = createProposal();
    const baseTrade = proposal.route.trades[0];
    if (!baseTrade) throw new Error('Expected a fixture trade.');

    const trades = [
      { txHash: 'aa'.repeat(32), supply: 400n, demand: 500n, fee: 2n },
      { txHash: 'bb'.repeat(32), supply: 300n, demand: 300n, fee: 2n },
      { txHash: 'cc'.repeat(32), supply: 200n, demand: 200n, fee: 1n },
    ].map(({ txHash, supply, demand, fee }, index) => ({
      ...baseTrade,
      supply,
      demand,
      tradeFee: fee,
      pool: {
        ...baseTrade.pool,
        txHash,
        outputIndex: index,
        output: {
          ...baseTrade.pool.output,
          amountSatoshis: 10_000_000n + BigInt(index),
          tokenAmount: 10_000n + BigInt(index),
          lockingBytecode: new Uint8Array([0x51, index]),
        },
      },
    }));
    proposal.route.trades = trades;
    proposal.tokenAmountAtomic = 1_000n;
    proposal.maxBchSats = 900n;
    proposal.route.summary = {
      demand: 1_000n,
      supply: 900n,
      tradeFee: 5n,
      rateNumerator: 1n,
      rateDenominator: 1n,
    };

    const { payload } = createMerchantPaymentProposalPayload(proposal);
    expect(payload.length).toBeLessThan(2953);
    expect(
      deserializeMerchantPaymentProposal(
        payload,
        Network.MAINNET,
        1_700_000_000_000
      )
    ).toEqual(proposal);
  });

  it('round-trips a reverse PUSD-to-BCH route through the compact transport', () => {
    const proposal = createReverseProposal();
    const { payload } = createMerchantPaymentProposalPayload(proposal);
    const template = buildMerchantPaymentTransactionTemplate(proposal);

    expect(template.outputs[1]).toMatchObject({
      role: 'merchant-bch',
      valueSatoshis: 850_000n,
    });
    expect(
      deserializeMerchantPaymentProposal(
        payload,
        Network.MAINNET,
        1_700_000_000_000
      )
    ).toEqual(proposal);
  });

  it('round-trips a zero-conversion token payment without an LP route', () => {
    const proposal = createDirectTokenProposal();
    const { payload } = createMerchantPaymentProposalPayload(proposal);
    const template = buildMerchantPaymentTransactionTemplate(proposal);

    expect(template.inputs).toEqual([]);
    expect(template.outputs[0]).toMatchObject({
      role: 'merchant-token',
      valueSatoshis: 1_000n,
      token: { category: tokenId, amount: 1_000n },
    });
    expect(template.funding).toMatchObject({
      buyerInputs: 'variable-token-only',
      additionalBchUtxoRequired: false,
    });
    expect(
      deserializeMerchantPaymentProposal(
        payload,
        Network.MAINNET,
        1_700_000_000_000
      )
    ).toEqual(proposal);
  });
});

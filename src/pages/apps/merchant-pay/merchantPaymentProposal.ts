import { parseBip21Uri } from '../../../utils/bip21';
import type { Network } from '../../../state/slices/networkSlice';
import {
  createTransactionFingerprint,
  deserializePartiallySignedTransaction,
  serializePartiallySignedTransaction,
  type PartiallySignedTransaction,
} from '../../../services/partiallySignedTransaction';
import type {
  CauldronPoolTrade,
  CauldronTradeSummary,
} from '../../../services/cauldron';
import { CAULDRON_NATIVE_BCH } from '../../../services/cauldron';

export const MERCHANT_PAYMENT_PROPOSAL_VERSION = 1 as const;
export const MERCHANT_PAYMENT_PROPOSAL_APPLICATION_ID =
  'optn.builtin.merchant-pay.transaction-proposal';

export type MerchantPaymentProposal = {
  version: typeof MERCHANT_PAYMENT_PROPOSAL_VERSION;
  kind: 'cauldron-merchant-payment-proposal';
  network: Network;
  requestId: string;
  createdAt: number;
  expiresAt: number;
  merchantAddress: string;
  tokenId: string;
  tokenDecimals: number;
  tokenSymbol: string;
  tokenAmountAtomic: bigint;
  maxBchSats: bigint;
  quoteProtectionBps: bigint;
  route: {
    supplyTokenId: typeof CAULDRON_NATIVE_BCH;
    demandTokenId: string;
    trades: CauldronPoolTrade[];
    summary: CauldronTradeSummary;
  };
};

export type MerchantPaymentProposalPayload = {
  proposal: MerchantPaymentProposal;
  payload: Uint8Array;
};

function isHexCategory(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function outpointKey(trade: CauldronPoolTrade): string {
  return `${trade.pool.txHash.toLowerCase()}:${trade.pool.outputIndex}`;
}

function assertProposalNetwork(network: Network): void {
  if (network !== 'mainnet' && network !== 'chipnet') {
    throw new Error('Merchant proposal has an invalid network.');
  }
}

export function validateMerchantPaymentProposal(
  proposal: MerchantPaymentProposal,
  expectedNetwork?: Network,
  now = Date.now()
): MerchantPaymentProposal {
  if (proposal.version !== MERCHANT_PAYMENT_PROPOSAL_VERSION) {
    throw new Error('Merchant proposal version is unsupported.');
  }
  if (proposal.kind !== 'cauldron-merchant-payment-proposal') {
    throw new Error('Merchant proposal kind is unsupported.');
  }
  assertProposalNetwork(proposal.network);
  if (expectedNetwork && proposal.network !== expectedNetwork) {
    throw new Error('Merchant proposal is for a different network.');
  }
  if (!proposal.requestId.trim()) {
    throw new Error('Merchant proposal is missing its request ID.');
  }
  if (!isFiniteInteger(proposal.createdAt) || proposal.createdAt <= 0) {
    throw new Error('Merchant proposal has an invalid creation time.');
  }
  if (
    !isFiniteInteger(proposal.expiresAt) ||
    proposal.expiresAt <= proposal.createdAt ||
    proposal.expiresAt <= now
  ) {
    throw new Error('Merchant proposal has expired or an invalid expiry.');
  }

  const recipient = parseBip21Uri(proposal.merchantAddress, proposal.network);
  if (!recipient.isValidAddress || !recipient.isTokenAddress) {
    throw new Error('Merchant proposal recipient is not token-aware.');
  }
  if (!isHexCategory(proposal.tokenId)) {
    throw new Error('Merchant proposal token category is invalid.');
  }
  if (
    !isFiniteInteger(proposal.tokenDecimals) ||
    proposal.tokenDecimals < 0 ||
    proposal.tokenDecimals > 18
  ) {
    throw new Error('Merchant proposal token decimals are invalid.');
  }
  if (!proposal.tokenSymbol.trim()) {
    throw new Error('Merchant proposal token symbol is missing.');
  }
  if (proposal.tokenAmountAtomic <= 0n || proposal.maxBchSats <= 0n) {
    throw new Error('Merchant proposal amounts must be greater than zero.');
  }
  if (proposal.quoteProtectionBps < 0n) {
    throw new Error('Merchant proposal quote protection is invalid.');
  }

  const route = proposal.route;
  if (
    route.supplyTokenId !== CAULDRON_NATIVE_BCH ||
    route.demandTokenId !== proposal.tokenId ||
    route.trades.length === 0
  ) {
    throw new Error('Merchant proposal route direction is invalid.');
  }

  const seenOutpoints = new Set<string>();
  let totalSupply = 0n;
  let totalDemand = 0n;
  let totalTradeFee = 0n;
  for (const trade of route.trades) {
    const pool = trade.pool;
    if (!isHexCategory(pool.txHash) || !isFiniteInteger(pool.outputIndex)) {
      throw new Error('Merchant proposal contains an invalid pool outpoint.');
    }
    if (pool.outputIndex < 0) {
      throw new Error(
        'Merchant proposal contains a negative pool output index.'
      );
    }
    const poolKey = outpointKey(trade);
    if (seenOutpoints.has(poolKey)) {
      throw new Error('Merchant proposal contains a duplicate pool outpoint.');
    }
    seenOutpoints.add(poolKey);

    if (
      pool.output.tokenCategory !== proposal.tokenId ||
      pool.output.amountSatoshis <= 0n ||
      pool.output.tokenAmount <= 0n ||
      !(pool.output.lockingBytecode instanceof Uint8Array) ||
      pool.output.lockingBytecode.length === 0 ||
      !(pool.parameters.withdrawPublicKeyHash instanceof Uint8Array) ||
      pool.parameters.withdrawPublicKeyHash.length !== 20
    ) {
      throw new Error('Merchant proposal contains invalid pool state.');
    }
    if (
      trade.supplyTokenId !== CAULDRON_NATIVE_BCH ||
      trade.demandTokenId !== proposal.tokenId ||
      trade.supply <= 0n ||
      trade.demand <= 0n ||
      trade.tradeFee < 0n
    ) {
      throw new Error('Merchant proposal contains an invalid pool trade.');
    }

    totalSupply += trade.supply;
    totalDemand += trade.demand;
    totalTradeFee += trade.tradeFee;
  }

  if (
    totalSupply !== route.summary.supply ||
    totalDemand !== route.summary.demand
  ) {
    throw new Error(
      'Merchant proposal route summary does not match its trades.'
    );
  }
  if (totalTradeFee !== route.summary.tradeFee) {
    throw new Error('Merchant proposal fee summary does not match its trades.');
  }
  if (
    totalDemand !== proposal.tokenAmountAtomic ||
    totalSupply > proposal.maxBchSats
  ) {
    throw new Error(
      'Merchant proposal route does not match the requested amount.'
    );
  }

  return proposal;
}

function buildTransportEnvelope(
  proposal: MerchantPaymentProposal
): Omit<PartiallySignedTransaction, 'metadata'> {
  return {
    version: 1,
    network: proposal.network,
    unsignedTransaction: {
      kind: 'cauldron-merchant-payment-route',
      poolOutpoints: proposal.route.trades.map((trade) => ({
        txHash: trade.pool.txHash,
        outputIndex: trade.pool.outputIndex,
      })),
    },
    sourceOutputs: proposal.route.trades.map((trade) => ({
      outpointTransactionHash: trade.pool.txHash,
      outpointIndex: trade.pool.outputIndex,
      valueSatoshis: trade.pool.output.amountSatoshis,
      lockingBytecode: trade.pool.output.lockingBytecode,
      token: {
        category: proposal.tokenId,
        amount: trade.pool.output.tokenAmount,
      },
    })),
    inputs: proposal.route.trades.map((_trade, index) => ({
      index,
      signerRole: 'contract' as const,
      status: 'finalized' as const,
      partialSignatures: [],
    })),
    application: {
      applicationId: MERCHANT_PAYMENT_PROPOSAL_APPLICATION_ID,
      contractName: 'CauldronPoolV0',
      functionName: 'trade',
      metadata: { proposal },
    },
  };
}

export function createMerchantPaymentProposalPayload(
  proposal: MerchantPaymentProposal
): MerchantPaymentProposalPayload {
  validateMerchantPaymentProposal(
    proposal,
    proposal.network,
    proposal.createdAt - 1
  );
  const base = buildTransportEnvelope(proposal);
  const request: PartiallySignedTransaction = {
    ...base,
    metadata: {
      requestId: proposal.requestId,
      purpose: 'Review a Cauldron merchant transaction proposal',
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      transactionFingerprint: createTransactionFingerprint(base),
    },
  };
  return {
    proposal,
    payload: serializePartiallySignedTransaction(request),
  };
}

export function deserializeMerchantPaymentProposal(
  payload: Uint8Array,
  expectedNetwork: Network,
  now = Date.now()
): MerchantPaymentProposal {
  const request = deserializePartiallySignedTransaction(payload);
  if (
    request.application?.applicationId !==
    MERCHANT_PAYMENT_PROPOSAL_APPLICATION_ID
  ) {
    throw new Error('QR payload is not a merchant transaction proposal.');
  }

  const { metadata: _metadata, ...base } = request;
  if (
    createTransactionFingerprint(base) !==
    request.metadata.transactionFingerprint
  ) {
    throw new Error('Merchant proposal fingerprint verification failed.');
  }

  const proposal = request.application.metadata?.proposal;
  if (!proposal || typeof proposal !== 'object') {
    throw new Error('Merchant proposal payload is missing its route.');
  }
  return validateMerchantPaymentProposal(
    proposal as MerchantPaymentProposal,
    expectedNetwork,
    now
  );
}

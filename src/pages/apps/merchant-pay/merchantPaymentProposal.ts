import { cashAddressToLockingBytecode } from '@bitauth/libauth';

import { parseBip21Uri } from '../../../utils/bip21';
import { TOKEN_OUTPUT_SATS } from '../../../utils/constants';
import type { Network } from '../../../state/slices/networkSlice';
import {
  createTransactionFingerprint,
  deserializePartiallySignedTransaction,
  serializePartiallySignedTransaction,
  type PartiallySignedTransaction,
} from '../../../services/partiallySignedTransaction';
import type {
  CauldronPoolTrade,
  CauldronTokenId,
  CauldronTradeSummary,
} from '../../../services/cauldron';
import {
  CAULDRON_NATIVE_BCH,
  extractCauldronPoolV0ParametersFromUnlockingBytecode,
} from '../../../services/cauldron';

export const MERCHANT_PAYMENT_PROPOSAL_VERSION = 2 as const;
export const MERCHANT_PAYMENT_PROPOSAL_APPLICATION_ID =
  'optn.builtin.merchant-pay.transaction-proposal';

type MerchantPaymentProposalBase = {
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
};

export type MerchantPaymentProposalV1 = MerchantPaymentProposalBase & {
  version: 1;
  route: {
    supplyTokenId: typeof CAULDRON_NATIVE_BCH;
    demandTokenId: string;
    trades: CauldronPoolTrade[];
    summary: CauldronTradeSummary;
  };
};

export type MerchantPaymentProposalV2 = MerchantPaymentProposalBase & {
  version: 2;
  incomingAsset: 'bch' | 'token';
  customerPaysAtomic: bigint;
  conversionBps: bigint;
  directIncomingAmountAtomic: bigint;
  merchantBchAmountSatoshis: bigint;
  merchantTokenAmountAtomic: bigint;
  route: {
    supplyTokenId: CauldronTokenId;
    demandTokenId: CauldronTokenId;
    trades: CauldronPoolTrade[];
    summary: CauldronTradeSummary;
  };
};

export type MerchantPaymentProposal =
  | MerchantPaymentProposalV1
  | MerchantPaymentProposalV2;

export type MerchantPaymentProposalPayload = {
  proposal: MerchantPaymentProposal;
  payload: Uint8Array;
};

/**
 * Split the customer's incoming amount between the direct merchant output
 * and the Cauldron route. Round half-up at atomic precision so token amounts
 * (including PUSD) never lose or create a unit.
 */
export function splitMerchantPaymentAmount(
  amount: bigint,
  conversionBps: bigint
): { converted: bigint; direct: bigint } {
  const converted = (amount * conversionBps + 5_000n) / 10_000n;
  return { converted, direct: amount - converted };
}

/**
 * The merchant-side half of the one-transaction payment.
 *
 * The buyer's BCH inputs and change are intentionally variable: only the
 * buyer knows which spendable coins they will authorize. The LP inputs,
 * successor outputs, and exact merchant token output are fixed here. The
 * buyer turns this template into the complete BCH PSBT after funding it.
 */
export type MerchantPaymentTransactionTemplate = {
  kind: 'cauldron-merchant-payment-template';
  version: 2;
  locktime: 0;
  inputs: Array<{
    outpointTransactionHash: string;
    outpointIndex: number;
    sequenceNumber: number;
  }>;
  outputs: Array<{
    role: 'pool-successor' | 'merchant-bch' | 'merchant-token';
    valueSatoshis: bigint;
    lockingBytecode: Uint8Array;
    token?: {
      category: string;
      amount: bigint;
    };
  }>;
  funding: {
    signerRole: 'buyer';
    supplyTokenId: CauldronTokenId;
    requiredBchSats: bigint;
    maxBchSats: bigint;
    tokenOutputSatoshis: bigint;
    buyerInputs:
      | 'variable-bch-only'
      | 'variable-token-only'
      | 'variable-token-and-bch';
    buyerChange: 'variable-bch-after-merchant-output';
    merchantOutputIndex: number;
    customerPaysAtomic?: bigint;
    additionalBchUtxoRequired?: boolean;
  };
};

type CompactMerchantPaymentProposal = {
  f: 'mpp1';
  v: 1;
  n: Network;
  i: string;
  c: number;
  e: number;
  m: string;
  t: string;
  d: number;
  s: string;
  a: string;
  b: string;
  q: string;
  r: {
    d: string;
    s: string;
    f: string;
    n: string;
    q: string;
    t: Array<[string, string, string]>;
  };
};

type CompactMerchantPaymentProposalV2 = {
  f: 'mpp2';
  v: 2;
  n: Network;
  i: string;
  c: number;
  e: number;
  m: string;
  t: string;
  d: number;
  s: string;
  a: string;
  b: string;
  q: string;
  x: 'bch' | 'token';
  p: string;
  g: string;
  u: string;
  r: {
    d: string;
    s: string;
    f: string;
    n: string;
    q: string;
    t: Array<[string, string, string]>;
  };
};

type CompactMerchantPaymentTransactionTemplate = {
  f: 'mpt1';
  i: Array<[string, number, number]>;
  o: Array<['p' | 'm', string, string, string, string]>;
  fnd: [string, string, string, number];
};

type CompactMerchantPaymentTransactionTemplateV2 = {
  f: 'mpt2';
  i: Array<[string, number, number]>;
  o: Array<['p' | 'b' | 't', string, string, string, string]>;
  fnd: [string, string, string, number, string, number];
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

function encodeQrBytes(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeQrBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function compactMerchantPaymentProposal(
  proposal: MerchantPaymentProposalV1
): CompactMerchantPaymentProposal {
  return {
    f: 'mpp1',
    v: 1,
    n: proposal.network,
    i: proposal.requestId,
    c: proposal.createdAt,
    e: proposal.expiresAt,
    m: proposal.merchantAddress,
    t: proposal.tokenId,
    d: proposal.tokenDecimals,
    s: proposal.tokenSymbol,
    a: proposal.tokenAmountAtomic.toString(),
    b: proposal.maxBchSats.toString(),
    q: proposal.quoteProtectionBps.toString(),
    r: {
      d: proposal.route.demandTokenId,
      s: proposal.route.supplyTokenId,
      f: proposal.route.summary.tradeFee.toString(),
      n: proposal.route.summary.rateNumerator.toString(),
      q: proposal.route.summary.rateDenominator.toString(),
      t: proposal.route.trades.map((trade) => [
        trade.supply.toString(),
        trade.demand.toString(),
        trade.tradeFee.toString(),
      ]),
    },
  };
}

function compactMerchantPaymentProposalV2(
  proposal: MerchantPaymentProposalV2
): CompactMerchantPaymentProposalV2 {
  return {
    f: 'mpp2',
    v: 2,
    n: proposal.network,
    i: proposal.requestId,
    c: proposal.createdAt,
    e: proposal.expiresAt,
    m: proposal.merchantAddress,
    t: proposal.tokenId,
    d: proposal.tokenDecimals,
    s: proposal.tokenSymbol,
    a: proposal.tokenAmountAtomic.toString(),
    b: proposal.maxBchSats.toString(),
    q: proposal.quoteProtectionBps.toString(),
    x: proposal.incomingAsset,
    p: proposal.conversionBps.toString(),
    g: proposal.customerPaysAtomic.toString(),
    u: proposal.directIncomingAmountAtomic.toString(),
    r: {
      d: proposal.route.demandTokenId,
      s: proposal.route.supplyTokenId,
      f: proposal.route.summary.tradeFee.toString(),
      n: proposal.route.summary.rateNumerator.toString(),
      q: proposal.route.summary.rateDenominator.toString(),
      t: proposal.route.trades.map((trade) => [
        trade.supply.toString(),
        trade.demand.toString(),
        trade.tradeFee.toString(),
      ]),
    },
  };
}

function isCompactMerchantPaymentProposal(
  value: unknown
): value is CompactMerchantPaymentProposal {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { f?: unknown }).f === 'mpp1'
  );
}

function isCompactMerchantPaymentProposalV2(
  value: unknown
): value is CompactMerchantPaymentProposalV2 {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { f?: unknown }).f === 'mpp2'
  );
}

function asCompactTradeTuple(value: unknown): [string, string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('Merchant proposal contains an invalid compact route.');
  }
  return value as [string, string, string];
}

function compactMerchantPaymentTransactionTemplate(
  template: MerchantPaymentTransactionTemplate
): CompactMerchantPaymentTransactionTemplate {
  return {
    f: 'mpt1',
    i: template.inputs.map((input) => [
      input.outpointTransactionHash,
      input.outpointIndex,
      input.sequenceNumber,
    ]),
    o: template.outputs.map((output) => [
      output.role === 'pool-successor' ? 'p' : 'm',
      output.valueSatoshis.toString(),
      encodeQrBytes(output.lockingBytecode),
      output.token?.category ?? '',
      output.token?.amount.toString() ?? '',
    ]),
    fnd: [
      template.funding.requiredBchSats.toString(),
      template.funding.maxBchSats.toString(),
      template.funding.tokenOutputSatoshis.toString(),
      template.funding.merchantOutputIndex,
    ],
  };
}

function compactMerchantPaymentTransactionTemplateV2(
  template: MerchantPaymentTransactionTemplate
): CompactMerchantPaymentTransactionTemplateV2 {
  return {
    f: 'mpt2',
    i: template.inputs.map((input) => [
      input.outpointTransactionHash,
      input.outpointIndex,
      input.sequenceNumber,
    ]),
    o: template.outputs.map((output) => [
      output.role === 'pool-successor'
        ? 'p'
        : output.role === 'merchant-bch'
          ? 'b'
          : 't',
      output.valueSatoshis.toString(),
      encodeQrBytes(output.lockingBytecode),
      output.token?.category ?? '',
      output.token?.amount.toString() ?? '',
    ]),
    fnd: [
      template.funding.requiredBchSats.toString(),
      template.funding.maxBchSats.toString(),
      template.funding.tokenOutputSatoshis.toString(),
      template.funding.merchantOutputIndex,
      template.funding.customerPaysAtomic?.toString() ?? '0',
      template.funding.additionalBchUtxoRequired ? 1 : 0,
    ],
  };
}

function expandCompactMerchantPaymentProposal(
  compact: CompactMerchantPaymentProposal,
  request: PartiallySignedTransaction
): MerchantPaymentProposal {
  type ExpandedTemplate = {
    inputs?: Array<{
      outpointTransactionHash?: unknown;
      outpointIndex?: unknown;
    }>;
    outputs?: Array<{
      role?: unknown;
      valueSatoshis?: unknown;
      lockingBytecode?: unknown;
      token?: { category?: unknown; amount?: unknown };
    }>;
  };
  const templateValue = request.unsignedTransaction as
    | CompactMerchantPaymentTransactionTemplate
    | ExpandedTemplate;
  const template: ExpandedTemplate =
    templateValue &&
    typeof templateValue === 'object' &&
    'f' in templateValue &&
    templateValue.f === 'mpt1'
      ? {
          inputs: templateValue.i.map(
            ([outpointTransactionHash, outpointIndex, sequenceNumber]) => ({
              outpointTransactionHash,
              outpointIndex,
              sequenceNumber,
            })
          ),
          outputs: templateValue.o.map(
            ([role, valueSatoshis, lockingBytecode, category, amount]) => ({
              role: role === 'p' ? 'pool-successor' : 'merchant-token',
              valueSatoshis: BigInt(valueSatoshis),
              lockingBytecode: decodeQrBytes(lockingBytecode),
              token: { category, amount: BigInt(amount) },
            })
          ),
        }
      : (templateValue as ExpandedTemplate);
  const templateInputs = template.inputs ?? [];
  const templateOutputs = template.outputs ?? [];
  const requestInputs = request.inputs;

  const trades = compact.r.t.map((rawTrade, index) => {
    const [supply, demand, tradeFee] = asCompactTradeTuple(rawTrade);
    const templateInput = templateInputs[index];
    const requestInput: unknown = requestInputs[index];
    const successor = templateOutputs[index];
    const txHash = String(templateInput?.outpointTransactionHash ?? '');
    const outputIndex = Number(templateInput?.outpointIndex);
    const successorLockingBytecode = decodeQrBytes(successor?.lockingBytecode);
    const successorValue = successor?.valueSatoshis;
    const successorTokenAmount = successor?.token?.amount;
    if (
      !/^[0-9a-f]{64}$/i.test(txHash) ||
      !Number.isSafeInteger(outputIndex) ||
      successor?.role !== 'pool-successor' ||
      successorLockingBytecode === null ||
      typeof successorValue !== 'bigint' ||
      typeof successorTokenAmount !== 'bigint' ||
      successor.token?.category !== compact.t ||
      successorTokenAmount <= 0n
    ) {
      throw new Error(
        'Merchant proposal transaction template does not match its route.'
      );
    }

    const requestInputIndex = Array.isArray(requestInput)
      ? requestInput[0]
      : (requestInput as { index?: unknown } | undefined)?.index;
    const unlockingValue = Array.isArray(requestInput)
      ? requestInput[1]
      : (requestInput as { unlockingBytecode?: unknown } | undefined)
          ?.unlockingBytecode;
    if (requestInputIndex !== index) {
      throw new Error('Merchant proposal input indexes are invalid.');
    }
    const unlockingBytecode = decodeQrBytes(unlockingValue);
    // mpp2 stores only the pool's 20-byte withdrawal key hash. The rest of
    // the Cauldron unlocking script is deterministic and can be rebuilt by
    // the buyer. Keep accepting mpp1 payloads that carry the full script.
    const parsedUnlocking =
      unlockingBytecode?.length === 20
        ? {
            kind: 'trade' as const,
            parameters: { withdrawPublicKeyHash: unlockingBytecode },
          }
        : unlockingBytecode
          ? extractCauldronPoolV0ParametersFromUnlockingBytecode(
              unlockingBytecode
            )
          : null;
    if (!parsedUnlocking || parsedUnlocking.kind !== 'trade') {
      throw new Error('Merchant proposal contains an invalid LP input script.');
    }

    const amountSatoshis = successorValue - BigInt(supply);
    const tokenAmount = successorTokenAmount + BigInt(demand);

    return {
      supplyTokenId: CAULDRON_NATIVE_BCH,
      demandTokenId: compact.t,
      supply: BigInt(supply),
      demand: BigInt(demand),
      tradeFee: BigInt(tradeFee),
      pool: {
        version: '0' as const,
        parameters: parsedUnlocking.parameters,
        txHash,
        outputIndex,
        ownerPublicKeyHash: null,
        ownerAddress: null,
        poolId: null,
        output: {
          amountSatoshis: BigInt(amountSatoshis),
          tokenCategory: compact.t,
          tokenAmount: BigInt(tokenAmount),
          lockingBytecode: successorLockingBytecode,
        },
      },
    };
  });

  const merchantOutput = templateOutputs[trades.length];
  const merchantLockingResult = cashAddressToLockingBytecode(compact.m);
  const merchantLockingBytecode = decodeQrBytes(
    merchantOutput?.lockingBytecode
  );
  if (
    typeof merchantLockingResult === 'string' ||
    merchantOutput?.role !== 'merchant-token' ||
    merchantOutput.valueSatoshis !== BigInt(TOKEN_OUTPUT_SATS) ||
    merchantOutput.token?.category !== compact.t ||
    merchantOutput.token.amount !== BigInt(compact.a) ||
    merchantLockingBytecode === null ||
    !equalBytes(merchantLockingBytecode, merchantLockingResult.bytecode)
  ) {
    throw new Error(
      'Merchant proposal fixed output does not match its template.'
    );
  }

  return {
    version: 1,
    kind: 'cauldron-merchant-payment-proposal',
    network: compact.n,
    requestId: compact.i,
    createdAt: compact.c,
    expiresAt: compact.e,
    merchantAddress: compact.m,
    tokenId: compact.t,
    tokenDecimals: compact.d,
    tokenSymbol: compact.s,
    tokenAmountAtomic: BigInt(compact.a),
    maxBchSats: BigInt(compact.b),
    quoteProtectionBps: BigInt(compact.q),
    route: {
      supplyTokenId: compact.r.s as typeof CAULDRON_NATIVE_BCH,
      demandTokenId: compact.r.d,
      trades,
      summary: {
        demand: BigInt(compact.a),
        supply: trades.reduce((total, trade) => total + trade.supply, 0n),
        tradeFee: BigInt(compact.r.f),
        rateNumerator: BigInt(compact.r.n),
        rateDenominator: BigInt(compact.r.q),
      },
    },
  };
}

function expandCompactMerchantPaymentProposalV2(
  compact: CompactMerchantPaymentProposalV2,
  request: PartiallySignedTransaction
): MerchantPaymentProposalV2 {
  const templateValue = request.unsignedTransaction as
    | CompactMerchantPaymentTransactionTemplateV2
    | undefined;
  if (!templateValue || templateValue.f !== 'mpt2') {
    throw new Error('Merchant proposal transaction template is unsupported.');
  }

  const templateInputs = templateValue.i;
  const templateOutputs = templateValue.o.map(
    ([role, valueSatoshis, lockingBytecode, category, amount]) => ({
      role,
      valueSatoshis: BigInt(valueSatoshis),
      lockingBytecode: decodeQrBytes(lockingBytecode),
      token: category ? { category, amount: BigInt(amount) } : undefined,
    })
  );
  const trades: CauldronPoolTrade[] = [];
  const routeSupplyTokenId = compact.r.s as CauldronTokenId;
  const routeDemandTokenId = compact.r.d as CauldronTokenId;

  for (const [index, rawTrade] of compact.r.t.entries()) {
    const [supplyText, demandText, tradeFeeText] =
      asCompactTradeTuple(rawTrade);
    const templateInput = templateInputs[index];
    const requestInput = request.inputs[index];
    const successor = templateOutputs[index];
    const txHash = String(templateInput?.[0] ?? '');
    const outputIndex = Number(templateInput?.[1]);
    const supply = BigInt(supplyText);
    const demand = BigInt(demandText);
    if (
      !/^[0-9a-f]{64}$/i.test(txHash) ||
      !Number.isSafeInteger(outputIndex) ||
      successor?.role !== 'p' ||
      successor.lockingBytecode === null ||
      successor.token?.category !== compact.t ||
      (successor.token?.amount ?? 0n) <= 0n
    ) {
      throw new Error(
        'Merchant proposal transaction template does not match its route.'
      );
    }
    const requestInputIndex = Array.isArray(requestInput)
      ? requestInput[0]
      : (requestInput as { index?: unknown } | undefined)?.index;
    const unlockingValue = Array.isArray(requestInput)
      ? requestInput[1]
      : (requestInput as { unlockingBytecode?: unknown } | undefined)
          ?.unlockingBytecode;
    if (requestInputIndex !== index) {
      throw new Error('Merchant proposal input indexes are invalid.');
    }
    const unlockingBytecode = decodeQrBytes(unlockingValue);
    const parsedUnlocking =
      unlockingBytecode?.length === 20
        ? {
            kind: 'trade' as const,
            parameters: { withdrawPublicKeyHash: unlockingBytecode },
          }
        : unlockingBytecode
          ? extractCauldronPoolV0ParametersFromUnlockingBytecode(
              unlockingBytecode
            )
          : null;
    if (!parsedUnlocking || parsedUnlocking.kind !== 'trade') {
      throw new Error('Merchant proposal contains an invalid LP input script.');
    }

    const poolAmount =
      routeSupplyTokenId === CAULDRON_NATIVE_BCH
        ? successor.valueSatoshis - supply
        : successor.valueSatoshis + demand;
    const successorTokenAmount = successor.token?.amount ?? 0n;
    const poolTokenAmount =
      routeSupplyTokenId === CAULDRON_NATIVE_BCH
        ? successorTokenAmount + demand
        : successorTokenAmount - supply;
    if (poolAmount <= 0n || poolTokenAmount <= 0n) {
      throw new Error('Merchant proposal contains an invalid LP successor.');
    }
    trades.push({
      supplyTokenId: routeSupplyTokenId,
      demandTokenId: routeDemandTokenId,
      supply,
      demand,
      tradeFee: BigInt(tradeFeeText),
      pool: {
        version: '0' as const,
        parameters: parsedUnlocking.parameters,
        txHash,
        outputIndex,
        ownerPublicKeyHash: null,
        ownerAddress: null,
        poolId: null,
        output: {
          amountSatoshis: poolAmount,
          tokenCategory: compact.t,
          tokenAmount: poolTokenAmount,
          lockingBytecode: successor.lockingBytecode,
        },
      },
    });
  }

  const routeDemand = trades.reduce((total, trade) => total + trade.demand, 0n);
  const routeSupply = trades.reduce((total, trade) => total + trade.supply, 0n);
  const directIncomingAmountAtomic = BigInt(compact.u);
  const customerPaysAtomic = BigInt(compact.g);
  const merchantBchAmountSatoshis =
    compact.x === 'bch' ? directIncomingAmountAtomic : routeDemand;
  const merchantTokenAmountAtomic =
    compact.x === 'token' ? directIncomingAmountAtomic : routeDemand;
  const merchantLockingResult = cashAddressToLockingBytecode(compact.m);
  if (typeof merchantLockingResult === 'string') {
    throw new Error(
      'Merchant proposal recipient has invalid locking bytecode.'
    );
  }

  const routeOutput = templateOutputs[trades.length];
  const directOutput =
    templateOutputs[trades.length + (routeDemand > 0n ? 1 : 0)];
  if (routeDemand > 0n) {
    const routeOutputMatches =
      compact.x === 'bch'
        ? routeOutput?.role === 't' &&
          routeOutput.valueSatoshis === BigInt(TOKEN_OUTPUT_SATS) &&
          routeOutput.token?.category === compact.t &&
          routeOutput.token.amount === routeDemand
        : routeOutput?.role === 'b' &&
          !routeOutput.token &&
          routeOutput.valueSatoshis === routeDemand;
    if (
      !routeOutputMatches ||
      routeOutput?.lockingBytecode === null ||
      !equalBytes(routeOutput.lockingBytecode, merchantLockingResult.bytecode)
    ) {
      throw new Error(
        'Merchant proposal fixed output does not match its route.'
      );
    }
  }

  if (directIncomingAmountAtomic > 0n) {
    const directOutputMatches =
      compact.x === 'bch'
        ? directOutput?.role === 'b' &&
          !directOutput.token &&
          directOutput.valueSatoshis === directIncomingAmountAtomic
        : directOutput?.role === 't' &&
          directOutput.valueSatoshis === BigInt(TOKEN_OUTPUT_SATS) &&
          directOutput.token?.category === compact.t &&
          directOutput.token.amount === directIncomingAmountAtomic;
    if (
      !directOutputMatches ||
      directOutput?.lockingBytecode === null ||
      !equalBytes(directOutput.lockingBytecode, merchantLockingResult.bytecode)
    ) {
      throw new Error(
        'Merchant proposal direct output does not match its terms.'
      );
    }
  }

  return {
    version: 2,
    kind: 'cauldron-merchant-payment-proposal',
    network: compact.n,
    requestId: compact.i,
    createdAt: compact.c,
    expiresAt: compact.e,
    merchantAddress: compact.m,
    tokenId: compact.t,
    tokenDecimals: compact.d,
    tokenSymbol: compact.s,
    tokenAmountAtomic: merchantTokenAmountAtomic,
    maxBchSats: BigInt(compact.b),
    quoteProtectionBps: BigInt(compact.q),
    incomingAsset: compact.x,
    customerPaysAtomic,
    conversionBps: BigInt(compact.p),
    directIncomingAmountAtomic,
    merchantBchAmountSatoshis,
    merchantTokenAmountAtomic,
    route: {
      supplyTokenId: routeSupplyTokenId,
      demandTokenId: routeDemandTokenId,
      trades,
      summary: {
        demand: routeDemand,
        supply: routeSupply,
        tradeFee: BigInt(compact.r.f),
        rateNumerator: BigInt(compact.r.n),
        rateDenominator: BigInt(compact.r.q),
      },
    },
  };
}

function assertProposalNetwork(network: Network): void {
  if (network !== 'mainnet' && network !== 'chipnet') {
    throw new Error('Merchant proposal has an invalid network.');
  }
}

function validateMerchantPaymentProposalV2(
  proposal: MerchantPaymentProposalV2
): MerchantPaymentProposalV2 {
  if (proposal.incomingAsset !== 'bch' && proposal.incomingAsset !== 'token') {
    throw new Error('Merchant proposal incoming asset is invalid.');
  }
  if (
    proposal.customerPaysAtomic <= 0n ||
    proposal.directIncomingAmountAtomic < 0n ||
    proposal.directIncomingAmountAtomic > proposal.customerPaysAtomic
  ) {
    throw new Error('Merchant proposal incoming amount is invalid.');
  }
  if (proposal.conversionBps < 0n || proposal.conversionBps > 10_000n) {
    throw new Error('Merchant proposal conversion percentage is invalid.');
  }
  if (proposal.maxBchSats < 0n) {
    throw new Error('Merchant proposal BCH amount is invalid.');
  }
  if (proposal.quoteProtectionBps < 0n) {
    throw new Error('Merchant proposal quote protection is invalid.');
  }

  const { direct: expectedDirectIncomingAmount } = splitMerchantPaymentAmount(
    proposal.customerPaysAtomic,
    proposal.conversionBps
  );
  if (proposal.directIncomingAmountAtomic !== expectedDirectIncomingAmount) {
    throw new Error(
      'Merchant proposal direct amount does not match its conversion percentage.'
    );
  }

  const route = proposal.route;
  const expectedSupplyTokenId =
    proposal.incomingAsset === 'bch' ? CAULDRON_NATIVE_BCH : proposal.tokenId;
  const expectedDemandTokenId =
    proposal.incomingAsset === 'bch' ? proposal.tokenId : CAULDRON_NATIVE_BCH;
  if (
    route.supplyTokenId !== expectedSupplyTokenId ||
    route.demandTokenId !== expectedDemandTokenId
  ) {
    throw new Error('Merchant proposal route direction is invalid.');
  }

  const expectedRoutedAmount =
    proposal.customerPaysAtomic - proposal.directIncomingAmountAtomic;
  if (
    route.summary.supply !== expectedRoutedAmount ||
    (proposal.incomingAsset === 'bch' &&
      proposal.maxBchSats !== proposal.customerPaysAtomic) ||
    (proposal.incomingAsset === 'token' && proposal.maxBchSats !== 0n)
  ) {
    throw new Error(
      'Merchant proposal route does not match its incoming amount.'
    );
  }

  const expectedMerchantBch =
    proposal.incomingAsset === 'bch'
      ? proposal.directIncomingAmountAtomic
      : route.summary.demand;
  const expectedMerchantToken =
    proposal.incomingAsset === 'token'
      ? proposal.directIncomingAmountAtomic
      : route.summary.demand;
  if (
    proposal.merchantBchAmountSatoshis !== expectedMerchantBch ||
    proposal.merchantTokenAmountAtomic !== expectedMerchantToken ||
    proposal.tokenAmountAtomic !== expectedMerchantToken
  ) {
    throw new Error(
      'Merchant proposal outputs do not match its conversion terms.'
    );
  }
  if (proposal.conversionBps === 0n && route.trades.length > 0) {
    throw new Error(
      'A zero-conversion merchant proposal cannot include an LP route.'
    );
  }
  if (proposal.conversionBps > 0n && expectedRoutedAmount === 0n) {
    throw new Error('Merchant proposal conversion is below one atomic unit.');
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
      trade.supplyTokenId !== route.supplyTokenId ||
      trade.demandTokenId !== route.demandTokenId ||
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
    totalDemand !== route.summary.demand ||
    totalTradeFee !== route.summary.tradeFee
  ) {
    throw new Error(
      'Merchant proposal route summary does not match its trades.'
    );
  }
  if (route.trades.length === 0 && (totalSupply !== 0n || totalDemand !== 0n)) {
    throw new Error(
      'Merchant proposal has an empty route with non-zero amounts.'
    );
  }

  return proposal;
}

export function validateMerchantPaymentProposal(
  proposal: MerchantPaymentProposal,
  expectedNetwork?: Network,
  now = Date.now()
): MerchantPaymentProposal {
  if (
    proposal.version !== 1 &&
    proposal.version !== MERCHANT_PAYMENT_PROPOSAL_VERSION
  ) {
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
  if (proposal.version === 2) {
    return validateMerchantPaymentProposalV2(proposal);
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

export function getMerchantPaymentTerms(proposal: MerchantPaymentProposal): {
  incomingAsset: 'bch' | 'token';
  incomingTokenCategory?: string;
  incomingAmountAtomic: bigint;
  directIncomingAmountAtomic: bigint;
  merchantBchAmountSatoshis: bigint;
  merchantTokenAmountAtomic: bigint;
} {
  if (proposal.version === 2) {
    return {
      incomingAsset: proposal.incomingAsset,
      incomingTokenCategory:
        proposal.incomingAsset === 'token' ? proposal.tokenId : undefined,
      incomingAmountAtomic: proposal.customerPaysAtomic,
      directIncomingAmountAtomic: proposal.directIncomingAmountAtomic,
      merchantBchAmountSatoshis: proposal.merchantBchAmountSatoshis,
      merchantTokenAmountAtomic: proposal.merchantTokenAmountAtomic,
    };
  }
  return {
    incomingAsset: 'bch',
    incomingAmountAtomic: proposal.route.summary.supply,
    directIncomingAmountAtomic: 0n,
    merchantBchAmountSatoshis: 0n,
    merchantTokenAmountAtomic: proposal.tokenAmountAtomic,
  };
}

export function buildMerchantPaymentTransactionTemplate(
  proposal: MerchantPaymentProposal
): MerchantPaymentTransactionTemplate {
  const merchantLockingResult = cashAddressToLockingBytecode(
    proposal.merchantAddress
  );
  if (typeof merchantLockingResult === 'string') {
    throw new Error(
      'Merchant proposal recipient has invalid locking bytecode.'
    );
  }

  const poolSuccessorOutputs = proposal.route.trades.map((trade) => {
    const valueSatoshis =
      trade.pool.output.amountSatoshis +
      (trade.supplyTokenId === CAULDRON_NATIVE_BCH
        ? trade.supply
        : -trade.demand);
    const tokenAmount =
      trade.pool.output.tokenAmount +
      (trade.supplyTokenId === CAULDRON_NATIVE_BCH
        ? -trade.demand
        : trade.supply);
    if (valueSatoshis <= 0n || tokenAmount <= 0n) {
      throw new Error('Merchant proposal contains an invalid LP successor.');
    }
    return {
      role: 'pool-successor' as const,
      valueSatoshis,
      lockingBytecode: trade.pool.output.lockingBytecode,
      token: {
        category: proposal.tokenId,
        amount: tokenAmount,
      },
    };
  });

  const terms = getMerchantPaymentTerms(proposal);
  const merchantOutputs: MerchantPaymentTransactionTemplate['outputs'] = [];
  if (proposal.route.summary.demand > 0n) {
    if (proposal.route.demandTokenId === CAULDRON_NATIVE_BCH) {
      merchantOutputs.push({
        role: 'merchant-bch',
        valueSatoshis: proposal.route.summary.demand,
        lockingBytecode: merchantLockingResult.bytecode,
      });
    } else {
      merchantOutputs.push({
        role: 'merchant-token',
        valueSatoshis: BigInt(TOKEN_OUTPUT_SATS),
        lockingBytecode: merchantLockingResult.bytecode,
        token: {
          category: proposal.tokenId,
          amount: proposal.route.summary.demand,
        },
      });
    }
  }
  if (terms.directIncomingAmountAtomic > 0n) {
    if (terms.incomingAsset === 'bch') {
      merchantOutputs.push({
        role: 'merchant-bch',
        valueSatoshis: terms.directIncomingAmountAtomic,
        lockingBytecode: merchantLockingResult.bytecode,
      });
    } else {
      merchantOutputs.push({
        role: 'merchant-token',
        valueSatoshis: BigInt(TOKEN_OUTPUT_SATS),
        lockingBytecode: merchantLockingResult.bytecode,
        token: {
          category: proposal.tokenId,
          amount: terms.directIncomingAmountAtomic,
        },
      });
    }
  }
  if (merchantOutputs.length === 0) {
    throw new Error('Merchant proposal has no fixed payment output.');
  }
  const merchantOutputIndex = poolSuccessorOutputs.length;
  return {
    kind: 'cauldron-merchant-payment-template',
    version: 2,
    locktime: 0,
    inputs: proposal.route.trades.map((trade) => ({
      outpointTransactionHash: trade.pool.txHash,
      outpointIndex: trade.pool.outputIndex,
      sequenceNumber: 0,
    })),
    outputs: [...poolSuccessorOutputs, ...merchantOutputs],
    funding: {
      signerRole: 'buyer',
      supplyTokenId: proposal.route.supplyTokenId,
      requiredBchSats: proposal.route.summary.supply,
      maxBchSats: proposal.maxBchSats,
      tokenOutputSatoshis: BigInt(TOKEN_OUTPUT_SATS),
      buyerInputs:
        terms.incomingAsset === 'token'
          ? terms.merchantBchAmountSatoshis > 0n
            ? 'variable-token-and-bch'
            : 'variable-token-only'
          : 'variable-bch-only',
      buyerChange: 'variable-bch-after-merchant-output',
      merchantOutputIndex,
      customerPaysAtomic: terms.incomingAmountAtomic,
      additionalBchUtxoRequired:
        terms.incomingAsset === 'token' && terms.merchantBchAmountSatoshis > 0n,
    },
  };
}

function buildTransportEnvelope(
  proposal: MerchantPaymentProposal
): Omit<PartiallySignedTransaction, 'metadata'> {
  const transactionTemplate = buildMerchantPaymentTransactionTemplate(proposal);
  return {
    version: 1,
    network: proposal.network,
    unsignedTransaction:
      proposal.version === 2
        ? compactMerchantPaymentTransactionTemplateV2(transactionTemplate)
        : compactMerchantPaymentTransactionTemplate(transactionTemplate),
    // The route already carries the public LP output state. Keeping it in the
    // application metadata avoids duplicating every source output in the QR.
    sourceOutputs: [],
    inputs: proposal.route.trades.map((_trade, index) => [
      index,
      encodeQrBytes(
        proposal.route.trades[index].pool.parameters.withdrawPublicKeyHash
      ),
    ]) as unknown as PartiallySignedTransaction['inputs'],
    application: {
      applicationId: MERCHANT_PAYMENT_PROPOSAL_APPLICATION_ID,
      contractName: 'CauldronPoolV0',
      functionName: 'trade',
      metadata: {
        p:
          proposal.version === 2
            ? compactMerchantPaymentProposalV2(proposal)
            : compactMerchantPaymentProposal(proposal),
      },
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

  const base = Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== 'metadata')
  ) as Omit<PartiallySignedTransaction, 'metadata'>;
  if (
    createTransactionFingerprint(base) !==
    request.metadata.transactionFingerprint
  ) {
    throw new Error('Merchant proposal fingerprint verification failed.');
  }

  const proposalPayload =
    request.application.metadata?.p ?? request.application.metadata?.proposal;
  if (!proposalPayload || typeof proposalPayload !== 'object') {
    throw new Error('Merchant proposal payload is missing its route.');
  }
  const proposal = isCompactMerchantPaymentProposalV2(proposalPayload)
    ? expandCompactMerchantPaymentProposalV2(proposalPayload, request)
    : isCompactMerchantPaymentProposal(proposalPayload)
      ? expandCompactMerchantPaymentProposal(proposalPayload, request)
      : (proposalPayload as MerchantPaymentProposal);
  return validateMerchantPaymentProposal(proposal, expectedNetwork, now);
}

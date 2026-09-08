import type { AddonSDK } from '../../../services/AddonsSDK';
import { interpolateMessage } from '../../../i18n/format';
import type { SupportedLocale } from '../../../i18n/types';
import type { Network } from '../../../state/slices/networkSlice';
import { formatAtomicTokenAmount } from '../../../utils/tokenPresentation';
import { toTokenAwareCashAddress } from '../../../utils/cashAddress';
import type { UTXO } from '../../../types/types';
import type { MerchantStablecoin } from './merchantStablecoins';
import {
  createMerchantPaymentProposalPayload,
  splitMerchantPaymentAmount,
  type MerchantPaymentProposal,
} from './merchantPaymentProposal';
import {
  CAULDRON_NATIVE_BCH,
  planMerchantTradeForTargetDemand,
  planMerchantTradeForTargetSupply,
  type CauldronPool,
  type CauldronPoolTrade,
} from '../../../services/cauldron';
import {
  fetchCurrentCauldronPools,
  fetchCurrentLiquidityPoolsFromChain,
} from '../cauldron/preflight';

export type MerchantQuotePreview = {
  createdAt: number;
  expiresAt: number;
  merchantReceivesAtomic: bigint;
  merchantReceivesDisplay: string;
  customerPaysSats: bigint;
  customerPaysDisplay: string;
  routePoolCount: number;
  quoteProtectionBps: bigint;
  trades: CauldronPoolTrade[];
  incomingAsset?: 'bch' | 'token';
  customerPaysAtomic?: bigint;
  conversionBps?: bigint;
  directIncomingAmountAtomic?: bigint;
};

export type MerchantPaymentRequest = {
  requestId: string;
  createdAt: number;
  expiresAt: number;
  network: Network;
  merchantAddress: string;
  merchantAddressBaselineOutpoints: string[];
  stablecoin: MerchantStablecoin;
  merchantReceivesAtomic: bigint;
  merchantReceivesDisplay: string;
  customerPaysSats: bigint;
  customerPaysDisplay: string;
  quoteProtectionBps: bigint;
  routePoolCount: number;
  maxBchSats: bigint;
  incomingAsset: 'bch' | 'token';
  customerPaysAtomic: bigint;
  conversionBps: bigint;
  directIncomingAmountAtomic: bigint;
  merchantBchAmountSatoshis: bigint;
  merchantTokenAmountAtomic: bigint;
  proposal: MerchantPaymentProposal;
  proposalPayload: Uint8Array;
  detailsText: string;
};

export type MerchantPayTranslator = (
  key: string,
  fallback: string,
  values?: Record<string, string | number>
) => string;

function getOutpointKey(utxo: Pick<UTXO, 'tx_hash' | 'tx_pos'>): string {
  return `${utxo.tx_hash}:${utxo.tx_pos}`;
}

function formatFixedAtomicAmount(amount: bigint, decimals: number): string {
  const normalizedDecimals = Math.max(0, Math.trunc(decimals));
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;

  if (normalizedDecimals === 0) {
    return `${negative ? '-' : ''}${absolute.toString()}`;
  }

  const scale = 10n ** BigInt(normalizedDecimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale)
    .toString()
    .padStart(normalizedDecimals, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

function formatCompactBchAmount(valueSats: bigint): string {
  return `${formatAtomicTokenAmount(valueSats, 8)} BCH`;
}

function formatPercentFromBps(value: bigint): string {
  return `${(Number(value) / 100).toFixed(2)}%`;
}

type MerchantTargetTradePlan = NonNullable<
  ReturnType<typeof planMerchantTradeForTargetDemand>
>;

function ceilDivide(dividend: bigint, divisor: bigint): bigint {
  return (dividend + divisor - 1n) / divisor;
}

function findCustomerAmountForConvertedSource(
  convertedSourceAtomic: bigint,
  conversionBps: bigint
): bigint | null {
  if (convertedSourceAtomic <= 0n || conversionBps <= 0n) return null;

  let low = 0n;
  let high = ceilDivide(convertedSourceAtomic * 10_000n, conversionBps) + 1n;
  while (low < high) {
    const middle = (low + high) / 2n;
    const { converted } = splitMerchantPaymentAmount(middle, conversionBps);
    if (converted >= convertedSourceAtomic) high = middle;
    else low = middle + 1n;
  }

  for (let offset = -3n; offset <= 3n; offset += 1n) {
    const candidate = low + offset;
    if (candidate <= 0n) continue;
    const { converted } = splitMerchantPaymentAmount(candidate, conversionBps);
    if (converted === convertedSourceAtomic) return candidate;
  }
  return null;
}

export function planMerchantTargetPayment({
  pools,
  merchantAsset,
  incomingAsset,
  merchantAmountAtomic,
  conversionBps,
  stablecoinTokenId,
}: {
  pools: CauldronPool[];
  merchantAsset: 'bch' | 'token';
  incomingAsset: 'bch' | 'token';
  merchantAmountAtomic: bigint;
  conversionBps: bigint;
  stablecoinTokenId: string;
}): {
  planned: MerchantTargetTradePlan | null;
  customerPaysAtomic: bigint;
  directIncomingAmountAtomic: bigint;
  conversionBps: bigint;
} | null {
  if (merchantAmountAtomic <= 0n) return null;

  if (conversionBps < 0n || conversionBps > 10_000n) return null;

  // Merchant Pay uses BCH as the customer-side settlement asset. The
  // merchant's amount is the price: for a PUSD price, first determine its
  // BCH equivalent; for a BCH price, the price is already the BCH amount.
  // The conversion slider then splits that BCH payment between a PUSD route
  // and a direct BCH output. This keeps the slider meaningful for both
  // merchant target assets.
  if (incomingAsset === 'bch') {
    let customerPaysAtomic = merchantAmountAtomic;
    let fullConversionPlan: MerchantTargetTradePlan | null = null;

    if (merchantAsset === 'token') {
      if (pools.length === 0) return null;
      fullConversionPlan = planMerchantTradeForTargetDemand(
        pools,
        CAULDRON_NATIVE_BCH,
        stablecoinTokenId,
        merchantAmountAtomic,
        4
      );
      if (
        !fullConversionPlan ||
        fullConversionPlan.summary.demand !== merchantAmountAtomic
      ) {
        return null;
      }
      customerPaysAtomic = fullConversionPlan.summary.supply;
    }

    const split = splitMerchantPaymentAmount(customerPaysAtomic, conversionBps);
    if (split.converted === 0n) {
      return {
        planned: null,
        customerPaysAtomic,
        directIncomingAmountAtomic: split.direct,
        conversionBps,
      };
    }
    if (pools.length === 0) return null;

    const planned =
      split.converted === customerPaysAtomic && fullConversionPlan
        ? fullConversionPlan
        : planMerchantTradeForTargetSupply(
            pools,
            CAULDRON_NATIVE_BCH,
            stablecoinTokenId,
            split.converted,
            4
          );
    if (!planned || planned.summary.supply !== split.converted) return null;

    return {
      planned,
      customerPaysAtomic,
      directIncomingAmountAtomic: split.direct,
      conversionBps,
    };
  }

  // Preserve the token-funded reverse direction for callers that use the
  // domain planner directly. The merchant UI does not expose this source
  // selector, but the proposal format still supports it.
  if (merchantAsset === incomingAsset) {
    return {
      planned: null,
      customerPaysAtomic: merchantAmountAtomic,
      directIncomingAmountAtomic: merchantAmountAtomic,
      conversionBps: 0n,
    };
  }

  if (conversionBps <= 0n || pools.length === 0) return null;

  const supplyTokenId = stablecoinTokenId;
  const demandTokenId =
    merchantAsset === 'bch' ? CAULDRON_NATIVE_BCH : stablecoinTokenId;
  const planned = planMerchantTradeForTargetDemand(
    pools,
    supplyTokenId,
    demandTokenId,
    merchantAmountAtomic,
    4
  );
  if (!planned || planned.summary.demand !== merchantAmountAtomic) return null;

  // The requested merchant amount is the converted portion. Scale the
  // customer's source amount so the slider controls how much additional
  // source-asset value is paid directly to the merchant.
  const customerPaysAtomic = findCustomerAmountForConvertedSource(
    planned.summary.supply,
    conversionBps
  );
  if (customerPaysAtomic == null) return null;
  const split = splitMerchantPaymentAmount(customerPaysAtomic, conversionBps);
  if (split.converted !== planned.summary.supply) return null;

  return {
    planned,
    customerPaysAtomic,
    directIncomingAmountAtomic: split.direct,
    conversionBps,
  };
}

function formatCountdownLabel(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return 'Expired';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function formatLocalTime(
  timestamp: number,
  locale: SupportedLocale = 'en'
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function createRequestId(): string {
  const cryptoApi = globalThis.crypto as
    | { randomUUID?: () => string }
    | undefined;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  return `merchant-pay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildMerchantPaymentRequestText(params: {
  proposal: MerchantPaymentProposal;
  merchantReceivesDisplay: string;
  customerPaysDisplay: string;
  locale?: SupportedLocale;
  translate?: MerchantPayTranslator;
}) {
  const { proposal } = params;
  const translate: MerchantPayTranslator =
    params.translate ??
    ((_key, fallback, values) => interpolateMessage(fallback, values));
  const merchantReceivesDisplay = params.merchantReceivesDisplay;
  const customerPaysDisplay = params.customerPaysDisplay;

  const detailsText = [
    translate('details.requestTitle', 'OPTN Merchant transaction proposal'),
    translate('details.requestId', 'Request ID: {id}', {
      id: proposal.requestId,
    }),
    translate('details.merchantReceives', 'Merchant receives: {amount}', {
      amount: merchantReceivesDisplay,
    }),
    translate('details.currentBchEstimate', 'Customer pays: {amount}', {
      amount: customerPaysDisplay,
    }),
    ...(proposal.version === 2
      ? [
          translate('details.conversion', 'Conversion: {percent}', {
            percent: formatPercentFromBps(proposal.conversionBps),
          }),
        ]
      : []),
    proposal.version === 2
      ? translate(
          'details.maximumRouteSupply',
          'Maximum {asset} route supply: {amount}',
          {
            asset:
              proposal.route.supplyTokenId === CAULDRON_NATIVE_BCH
                ? 'BCH'
                : proposal.tokenSymbol,
            amount:
              proposal.route.supplyTokenId === CAULDRON_NATIVE_BCH
                ? formatCompactBchAmount(proposal.route.summary.supply)
                : `${formatFixedAtomicAmount(proposal.route.summary.supply, proposal.tokenDecimals)} ${proposal.tokenSymbol}`,
          }
        )
      : translate(
          'details.maximumBchRouteSupply',
          'Maximum BCH route supply: {amount}',
          { amount: formatCompactBchAmount(proposal.maxBchSats) }
        ),
    translate('details.quoteProtection', 'Quote protection: {percent}', {
      percent: formatPercentFromBps(proposal.quoteProtectionBps),
    }),
    translate(
      'details.lpPoolInputsPrepared',
      'LP pool inputs prepared: {count}',
      {
        count: proposal.route.trades.length,
      }
    ),
    translate('details.quoteExpiresIn', 'Quote expires in: {duration}', {
      duration: formatCountdownLabel(proposal.expiresAt - proposal.createdAt),
    }),
    translate('details.expiresAt', 'Expires at: {time}', {
      time: formatLocalTime(proposal.expiresAt, params.locale),
    }),
    translate('details.merchantAddress', 'Merchant address: {address}', {
      address: proposal.merchantAddress,
    }),
    '',
    translate(
      'details.buyerAction',
      proposal.version === 2
        ? proposal.incomingAsset === 'token'
          ? proposal.merchantBchAmountSatoshis > 0n
            ? 'Buyer action: add PUSD and an additional BCH input, review, sign, and broadcast this one transaction in OPTN Wallet.'
            : 'Buyer action: add PUSD, review, sign, and broadcast this one transaction in OPTN Wallet.'
          : 'Buyer action: add BCH inputs and change, review, sign, and broadcast this one transaction in OPTN Wallet.'
        : 'Buyer action: add BCH inputs and change, review, sign, and broadcast this one transaction in OPTN Wallet.'
    ),
  ].join('\n');

  return {
    merchantReceivesDisplay,
    customerPaysDisplay,
    detailsText,
  };
}

export async function buildMerchantPaymentRequest(params: {
  sdk: AddonSDK;
  currentNetwork: Network;
  draftQuote: MerchantQuotePreview;
  selectedStablecoin: MerchantStablecoin;
  merchantAddress?: string;
  locale?: SupportedLocale;
  translate?: MerchantPayTranslator;
}): Promise<MerchantPaymentRequest> {
  let walletAddresses: Array<{
    address?: string | null;
    tokenAddress?: string | null;
  }> = [];
  try {
    walletAddresses = await params.sdk.wallet.listAddresses();
  } catch (error) {
    console.warn('[MerchantPay] failed to load wallet addresses', error);
    throw new Error('Unable to read wallet addresses.');
  }

  const primaryAddress = walletAddresses[0];
  const rawMerchantAddress =
    primaryAddress?.tokenAddress || primaryAddress?.address || '';

  if (!rawMerchantAddress) {
    throw new Error('No wallet address is available.');
  }

  const requestedMerchantAddress = params.merchantAddress?.trim();
  let merchantAddress = toTokenAwareCashAddress(rawMerchantAddress);
  if (requestedMerchantAddress) {
    const walletTokenAddresses = walletAddresses.flatMap((entry) =>
      [entry.tokenAddress, entry.address].flatMap((address) => {
        if (!address) return [];
        try {
          return [toTokenAwareCashAddress(address)];
        } catch {
          return [];
        }
      })
    );
    if (!walletTokenAddresses.includes(requestedMerchantAddress)) {
      throw new Error(
        'The merchant request address is no longer controlled by this wallet.'
      );
    }
    // A refresh changes the quote and proposal route, not the recipient the
    // merchant already showed to the buyer.
    merchantAddress = requestedMerchantAddress;
  }

  let merchantAddressUtxos: UTXO[] = [];
  try {
    merchantAddressUtxos =
      await params.sdk.utxos.listForAddress(merchantAddress);
  } catch (error) {
    console.warn(
      '[MerchantPay] failed to load merchant request address',
      error
    );
    throw new Error('Unable to read the merchant request address.');
  }

  const merchantAddressBaselineOutpoints = Array.from(
    new Set(merchantAddressUtxos.map(getOutpointKey))
  );

  const requestId = createRequestId();
  const createdAt = Date.now();
  const expiresAt = params.draftQuote.expiresAt;

  if (expiresAt <= createdAt) {
    throw new Error('The merchant quote has expired. Enter the amount again.');
  }
  const incomingAsset = params.draftQuote.incomingAsset ?? 'bch';
  const customerPaysAtomic =
    params.draftQuote.customerPaysAtomic ?? params.draftQuote.customerPaysSats;
  const conversionBps = params.draftQuote.conversionBps ?? 10_000n;
  const directIncomingAmountAtomic =
    params.draftQuote.directIncomingAmountAtomic ?? 0n;
  if (
    customerPaysAtomic <= 0n ||
    conversionBps < 0n ||
    conversionBps > 10_000n ||
    directIncomingAmountAtomic < 0n ||
    directIncomingAmountAtomic > customerPaysAtomic
  ) {
    throw new Error('Merchant payment terms are invalid.');
  }
  const routedIncomingAmountAtomic =
    customerPaysAtomic - directIncomingAmountAtomic;
  if (conversionBps === 0n && routedIncomingAmountAtomic !== 0n) {
    throw new Error('A zero-conversion request must be paid directly.');
  }
  if (conversionBps > 0n && routedIncomingAmountAtomic === 0n) {
    throw new Error('The conversion amount is below one atomic unit.');
  }

  let currentPools: CauldronPool[] = [];
  let planned: {
    trades: CauldronPoolTrade[];
    summary: {
      supply: bigint;
      demand: bigint;
      tradeFee: bigint;
      rateNumerator: bigint;
      rateDenominator: bigint;
    };
  } | null = null;
  if (routedIncomingAmountAtomic > 0n) {
    try {
      const refreshed = await withTimeout(
        fetchCurrentLiquidityPoolsFromChain({
          sdk: params.sdk,
          quotedPools: params.draftQuote.trades.map((trade) => trade.pool),
          forceRefresh: false,
        }),
        30_000,
        'Cauldron chain pool refresh'
      );
      currentPools = refreshed.currentPools;
    } catch (error) {
      console.warn('[MerchantPay] chain Cauldron pool refresh failed', error);
    }

    if (currentPools.length === 0) {
      try {
        currentPools = await withTimeout(
          fetchCurrentCauldronPools({
            network: params.currentNetwork,
            tokenId: params.selectedStablecoin.tokenId,
          }),
          15_000,
          'Cauldron live pool refresh'
        );
      } catch (error) {
        console.warn('[MerchantPay] live Cauldron pool refresh failed', error);
      }
    }

    // A payment proposal carries spendable LP outpoints, so it must not fall
    // back to the displayed quote when current chain state could not be read.
    if (currentPools.length === 0) {
      throw new Error(
        'Current Cauldron liquidity is unavailable. Refresh the quote and try again.'
      );
    }

    planned = planMerchantTradeForTargetSupply(
      currentPools,
      incomingAsset === 'bch'
        ? CAULDRON_NATIVE_BCH
        : params.selectedStablecoin.tokenId,
      incomingAsset === 'bch'
        ? params.selectedStablecoin.tokenId
        : CAULDRON_NATIVE_BCH,
      routedIncomingAmountAtomic,
      4
    );
    if (!planned || planned.summary.supply !== routedIncomingAmountAtomic) {
      throw new Error(
        'The requested amount is no longer available from the current Cauldron liquidity.'
      );
    }
  }

  const routeSummary = planned?.summary ?? {
    supply: 0n,
    demand: 0n,
    tradeFee: 0n,
    rateNumerator: 0n,
    rateDenominator: 1n,
  };
  const routeTrades = planned?.trades ?? [];
  const merchantBchAmountSatoshis =
    incomingAsset === 'bch' ? directIncomingAmountAtomic : routeSummary.demand;
  const merchantTokenAmountAtomic =
    incomingAsset === 'token'
      ? directIncomingAmountAtomic
      : routeSummary.demand;

  const proposal: MerchantPaymentProposal = {
    version: 2,
    kind: 'cauldron-merchant-payment-proposal',
    network: params.currentNetwork,
    requestId,
    createdAt,
    expiresAt,
    merchantAddress,
    tokenId: params.selectedStablecoin.tokenId,
    tokenDecimals: params.selectedStablecoin.decimals,
    tokenSymbol: params.selectedStablecoin.symbol,
    tokenAmountAtomic: merchantTokenAmountAtomic,
    maxBchSats: incomingAsset === 'bch' ? customerPaysAtomic : 0n,
    quoteProtectionBps: params.draftQuote.quoteProtectionBps,
    incomingAsset,
    customerPaysAtomic,
    conversionBps,
    directIncomingAmountAtomic,
    merchantBchAmountSatoshis,
    merchantTokenAmountAtomic,
    route: {
      supplyTokenId:
        incomingAsset === 'bch'
          ? CAULDRON_NATIVE_BCH
          : params.selectedStablecoin.tokenId,
      demandTokenId:
        incomingAsset === 'bch'
          ? params.selectedStablecoin.tokenId
          : CAULDRON_NATIVE_BCH,
      trades: routeTrades,
      summary: routeSummary,
    },
  };
  const { payload: proposalPayload } =
    createMerchantPaymentProposalPayload(proposal);
  const merchantReceiveParts = [
    merchantBchAmountSatoshis > 0n
      ? formatCompactBchAmount(merchantBchAmountSatoshis)
      : null,
    merchantTokenAmountAtomic > 0n
      ? `${formatFixedAtomicAmount(merchantTokenAmountAtomic, proposal.tokenDecimals)} ${proposal.tokenSymbol}`
      : null,
  ].filter((value): value is string => Boolean(value));
  const merchantReceivesDisplay = merchantReceiveParts.join(' + ');
  const customerPaysDisplay =
    incomingAsset === 'bch'
      ? formatCompactBchAmount(customerPaysAtomic)
      : `${formatFixedAtomicAmount(customerPaysAtomic, proposal.tokenDecimals)} ${proposal.tokenSymbol}`;
  const { detailsText } = buildMerchantPaymentRequestText({
    proposal,
    merchantReceivesDisplay,
    customerPaysDisplay,
    locale: params.locale,
    translate: params.translate,
  });

  return {
    requestId,
    createdAt,
    expiresAt,
    network: params.currentNetwork,
    merchantAddress,
    merchantAddressBaselineOutpoints,
    stablecoin: params.selectedStablecoin,
    merchantReceivesAtomic: proposal.tokenAmountAtomic,
    merchantReceivesDisplay,
    customerPaysSats: incomingAsset === 'bch' ? customerPaysAtomic : 0n,
    customerPaysDisplay,
    quoteProtectionBps: proposal.quoteProtectionBps,
    routePoolCount: proposal.route.trades.length,
    maxBchSats: proposal.maxBchSats,
    incomingAsset,
    customerPaysAtomic,
    conversionBps,
    directIncomingAmountAtomic,
    merchantBchAmountSatoshis,
    merchantTokenAmountAtomic,
    proposal,
    proposalPayload,
    detailsText,
  };
}

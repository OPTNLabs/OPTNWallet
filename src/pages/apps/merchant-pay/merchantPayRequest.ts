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
  type MerchantPaymentProposal,
} from './merchantPaymentProposal';
import {
  CAULDRON_NATIVE_BCH,
  planAggregatedTradeForTargetDemand,
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

function formatCountdownLabel(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return 'Expired';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
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
  const merchantReceivesDisplay = `${formatFixedAtomicAmount(
    proposal.tokenAmountAtomic,
    proposal.tokenDecimals
  )} ${proposal.tokenSymbol}`;
  const customerPaysDisplay = params.customerPaysDisplay;

  const detailsText = [
    translate('details.requestTitle', 'OPTN Merchant transaction proposal'),
    translate('details.requestId', 'Request ID: {id}', {
      id: proposal.requestId,
    }),
    translate('details.merchantReceives', 'Merchant receives: {amount}', {
      amount: merchantReceivesDisplay,
    }),
    translate('details.currentBchEstimate', 'Current BCH estimate: {amount}', {
      amount: customerPaysDisplay,
    }),
    translate(
      'details.maximumBchRouteSupply',
      'Maximum BCH route supply: {amount}',
      { amount: formatCompactBchAmount(proposal.maxBchSats) }
    ),
    translate('details.quoteProtection', 'Quote protection: {percent}', {
      percent: formatPercentFromBps(proposal.quoteProtectionBps),
    }),
    translate('details.lpPoolInputsPrepared', 'LP pool inputs prepared: {count}', {
      count: proposal.route.trades.length,
    }),
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
      'Buyer action: add BCH inputs and change, review, sign, and broadcast this one transaction in OPTN Wallet.'
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

  const merchantAddress = toTokenAwareCashAddress(rawMerchantAddress);

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
  if (params.draftQuote.trades.length === 0) {
    throw new Error('No Cauldron liquidity route is available.');
  }

  let currentPools: CauldronPool[] = [];
  try {
    currentPools = await fetchCurrentCauldronPools({
      network: params.currentNetwork,
      tokenId: params.selectedStablecoin.tokenId,
    });
  } catch (error) {
    console.warn('[MerchantPay] live Cauldron pool refresh failed', error);
  }

  if (currentPools.length === 0) {
    try {
      const refreshed = await fetchCurrentLiquidityPoolsFromChain({
        sdk: params.sdk,
        quotedPools: params.draftQuote.trades.map((trade) => trade.pool),
      });
      currentPools = refreshed.currentPools;
    } catch (error) {
      console.warn('[MerchantPay] chain Cauldron pool refresh failed', error);
    }
  }

  // The proposal is advisory until the buyer validates each exact LP
  // outpoint. If live refresh services are unavailable, retain the displayed
  // quote so merchant creation is not blocked by an infra read failure.
  if (currentPools.length === 0) {
    currentPools = [
      ...new Map(
        params.draftQuote.trades.map((trade) => [
          `${trade.pool.txHash.toLowerCase()}:${trade.pool.outputIndex}`,
          trade.pool,
        ])
      ).values(),
    ];
  }

  const planned = planAggregatedTradeForTargetDemand(
    currentPools,
    CAULDRON_NATIVE_BCH,
    params.selectedStablecoin.tokenId,
    params.draftQuote.merchantReceivesAtomic
  );
  if (!planned) {
    throw new Error(
      'The requested amount is no longer available from the current Cauldron liquidity.'
    );
  }

  const proposal: MerchantPaymentProposal = {
    version: 1,
    kind: 'cauldron-merchant-payment-proposal',
    network: params.currentNetwork,
    requestId,
    createdAt,
    expiresAt,
    merchantAddress,
    tokenId: params.selectedStablecoin.tokenId,
    tokenDecimals: params.selectedStablecoin.decimals,
    tokenSymbol: params.selectedStablecoin.symbol,
    tokenAmountAtomic: planned.summary.demand,
    maxBchSats: planned.summary.supply,
    quoteProtectionBps: params.draftQuote.quoteProtectionBps,
    route: {
      supplyTokenId: CAULDRON_NATIVE_BCH,
      demandTokenId: params.selectedStablecoin.tokenId,
      trades: planned.trades,
      summary: planned.summary,
    },
  };
  const { payload: proposalPayload } =
    createMerchantPaymentProposalPayload(proposal);
  const merchantReceivesDisplay = `${formatFixedAtomicAmount(
    proposal.tokenAmountAtomic,
    proposal.tokenDecimals
  )} ${proposal.tokenSymbol}`;
  const customerPaysDisplay = formatCompactBchAmount(proposal.maxBchSats);
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
    customerPaysSats: proposal.maxBchSats,
    customerPaysDisplay,
    quoteProtectionBps: proposal.quoteProtectionBps,
    routePoolCount: proposal.route.trades.length,
    maxBchSats: proposal.maxBchSats,
    proposal,
    proposalPayload,
    detailsText,
  };
}

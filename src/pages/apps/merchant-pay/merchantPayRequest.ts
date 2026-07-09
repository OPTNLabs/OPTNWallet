import type { AddonSDK } from '../../../services/AddonsSDK';
import type { Network } from '../../../state/slices/networkSlice';
import { buildBip21Uri } from '../../../utils/bip21';
import { formatAtomicTokenAmount } from '../../../utils/tokenPresentation';
import type { UTXO } from '../../../types/types';
import type { MerchantStablecoin } from './merchantStablecoins';

export type MerchantQuotePreview = {
  createdAt: number;
  expiresAt: number;
  merchantReceivesAtomic: bigint;
  merchantReceivesDisplay: string;
  customerPaysSats: bigint;
  customerPaysDisplay: string;
  routePoolCount: number;
  quoteProtectionBps: bigint;
};

export type MerchantPaymentRequest = {
  requestId: string;
  createdAt: number;
  expiresAt: number;
  merchantAddress: string;
  merchantAddressBaselineOutpoints: string[];
  stablecoin: MerchantStablecoin;
  merchantReceivesAtomic: bigint;
  merchantReceivesDisplay: string;
  customerPaysSats: bigint;
  customerPaysDisplay: string;
  quoteProtectionBps: bigint;
  routePoolCount: number;
  paymentUri: string;
  detailsText: string;
};

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

function formatLocalTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
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
  network: Network;
  merchantAddress: string;
  stablecoin: MerchantStablecoin;
  merchantReceivesAtomic: bigint;
  customerPaysSats: bigint;
  quoteProtectionBps: bigint;
  routePoolCount: number;
  createdAt: number;
  expiresAt: number;
}) {
  const merchantReceivesDisplay = `${formatFixedAtomicAmount(
    params.merchantReceivesAtomic,
    params.stablecoin.decimals
  )} ${params.stablecoin.symbol}`;
  const customerPaysDisplay = formatCompactBchAmount(params.customerPaysSats);
  const paymentUri = buildBip21Uri(params.merchantAddress, params.network, {
    amount: formatAtomicTokenAmount(params.customerPaysSats, 8),
    label: 'Merchant Pay',
    message: `Merchant receives ${merchantReceivesDisplay}`,
  });

  const detailsText = [
    'BCH payment request',
    `Merchant receives: ${merchantReceivesDisplay}`,
    `Customer pays: ${customerPaysDisplay}`,
    `Quote protection: ${formatPercentFromBps(params.quoteProtectionBps)}`,
    `Planned route pools: ${params.routePoolCount}`,
    `Quote expires in: ${formatCountdownLabel(
      params.expiresAt - params.createdAt
    )}`,
    `Expires at: ${formatLocalTime(params.expiresAt)}`,
    `Merchant address: ${params.merchantAddress}`,
    '',
    paymentUri,
  ].join('\n');

  return {
    merchantReceivesDisplay,
    customerPaysDisplay,
    paymentUri,
    detailsText,
  };
}

export async function buildMerchantPaymentRequest(params: {
  sdk: AddonSDK;
  currentNetwork: Network;
  draftQuote: MerchantQuotePreview;
  selectedStablecoin: MerchantStablecoin;
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
    primaryAddress?.address || primaryAddress?.tokenAddress || '';

  if (!rawMerchantAddress) {
    throw new Error('No wallet address is available.');
  }

  let merchantAddressUtxos: UTXO[] = [];
  try {
    merchantAddressUtxos = await params.sdk.utxos.listForAddress(rawMerchantAddress);
  } catch (error) {
    console.warn('[MerchantPay] failed to load merchant request address', error);
    throw new Error('Unable to read the merchant request address.');
  }

  const merchantAddressBaselineOutpoints = Array.from(
    new Set(merchantAddressUtxos.map(getOutpointKey))
  );

  const requestId = createRequestId();
  const createdAt = Date.now();
  const expiresAt = params.draftQuote.expiresAt;
  const merchantReceivesDisplay = `${formatFixedAtomicAmount(
    params.draftQuote.merchantReceivesAtomic,
    params.selectedStablecoin.decimals
  )} ${params.selectedStablecoin.symbol}`;
  const customerPaysDisplay = formatCompactBchAmount(
    params.draftQuote.customerPaysSats
  );
  const { paymentUri, detailsText } = buildMerchantPaymentRequestText({
    network: params.currentNetwork,
    merchantAddress: rawMerchantAddress,
    stablecoin: params.selectedStablecoin,
    merchantReceivesAtomic: params.draftQuote.merchantReceivesAtomic,
    customerPaysSats: params.draftQuote.customerPaysSats,
    quoteProtectionBps: params.draftQuote.quoteProtectionBps,
    routePoolCount: params.draftQuote.routePoolCount,
    createdAt,
    expiresAt,
  });

  return {
    requestId,
    createdAt,
    expiresAt,
    merchantAddress: rawMerchantAddress,
    merchantAddressBaselineOutpoints,
    stablecoin: params.selectedStablecoin,
    merchantReceivesAtomic: params.draftQuote.merchantReceivesAtomic,
    merchantReceivesDisplay,
    customerPaysSats: params.draftQuote.customerPaysSats,
    customerPaysDisplay,
    quoteProtectionBps: params.draftQuote.quoteProtectionBps,
    routePoolCount: params.draftQuote.routePoolCount,
    paymentUri,
    detailsText,
  };
}

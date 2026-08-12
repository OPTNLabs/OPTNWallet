import {
  CashAddressType,
  decodeBase58Address,
  decodeCashAddress,
} from '@bitauth/libauth';
import { Network } from '../redux/networkSlice';

const MAINNET_PREFIX = 'bitcoincash';
const CHIPNET_PREFIX = 'bchtest';

export type ParsedBip21Uri = {
  isValidAddress: boolean;
  isBip21Uri: boolean;
  normalizedAddress: string;
  isCashAddress: boolean;
  isBase58Address: boolean;
  isTokenAddress: boolean;
  amount?: number;
  amountRaw?: string;
  label?: string;
  message?: string;
};

function expectedPrefixForNetwork(network: Network): string {
  return network === Network.MAINNET ? MAINNET_PREFIX : CHIPNET_PREFIX;
}

function parseAmount(params: URLSearchParams): {
  amount?: number;
  amountRaw?: string;
} {
  const amountRaw = params.get('amount')?.trim() || '';
  if (!amountRaw) return {};

  const parsed = Number.parseFloat(amountRaw);
  if (!Number.isFinite(parsed) || parsed <= 0) return {};

  return { amount: parsed, amountRaw };
}

export function parseBip21Uri(input: string, network: Network): ParsedBip21Uri {
  const raw = input.trim();
  if (!raw) {
    return {
      isValidAddress: false,
      isBip21Uri: false,
      normalizedAddress: '',
      isCashAddress: false,
      isBase58Address: false,
      isTokenAddress: false,
    };
  }

  const [addressPartRaw, queryString = ''] = raw.split('?');
  const isBip21Uri =
    queryString.length > 0 || addressPartRaw.includes(':');

  const addressChunks = addressPartRaw.split(':');
  const noPrefixAddress =
    addressChunks.length > 1
      ? addressChunks[addressChunks.length - 1]
      : addressPartRaw;

  const searchParams = new URLSearchParams(queryString);
  const { amount, amountRaw } = parseAmount(searchParams);
  const label = searchParams.get('label') || undefined;
  const message = searchParams.get('message') || undefined;

  if (!noPrefixAddress) {
    return {
      isValidAddress: false,
      isBip21Uri,
      normalizedAddress: '',
      isCashAddress: false,
      isBase58Address: false,
      isTokenAddress: false,
      amount,
      amountRaw,
      label,
      message,
    };
  }

  const isBase58Address =
    typeof decodeBase58Address(noPrefixAddress) === 'object';

  if (isBase58Address) {
    return {
      isValidAddress: true,
      isBip21Uri,
      normalizedAddress: noPrefixAddress,
      isCashAddress: false,
      isBase58Address: true,
      isTokenAddress: false,
      amount,
      amountRaw,
      label,
      message,
    };
  }

  const expectedPrefix = expectedPrefixForNetwork(network);
  const maybePrefix = addressChunks[0]?.toLowerCase();
  const prefixesToTry = [
    maybePrefix,
    expectedPrefix,
    expectedPrefix === MAINNET_PREFIX ? CHIPNET_PREFIX : MAINNET_PREFIX,
  ].filter((prefix): prefix is string => !!prefix);

  for (const prefix of prefixesToTry) {
    const candidate = `${prefix}:${noPrefixAddress}`;
    const decoded = decodeCashAddress(candidate);
    if (typeof decoded !== 'object') continue;

    const isTokenAddress =
      decoded.type === CashAddressType.p2pkhWithTokens ||
      decoded.type === CashAddressType.p2shWithTokens;

    return {
      isValidAddress: true,
      isBip21Uri,
      normalizedAddress: candidate,
      isCashAddress: true,
      isBase58Address: false,
      isTokenAddress,
      amount,
      amountRaw,
      label,
      message,
    };
  }

  return {
    isValidAddress: false,
    isBip21Uri,
    normalizedAddress: '',
    isCashAddress: false,
    isBase58Address: false,
    isTokenAddress: false,
    amount,
    amountRaw,
    label,
    message,
  };
}

export function buildBip21Uri(
  address: string,
  network: Network,
  options?: {
    amount?: number | string;
    label?: string;
    message?: string;
  }
): string {
  const parsed = parseBip21Uri(address, network);
  if (!parsed.isValidAddress) return '';

  const scheme = expectedPrefixForNetwork(network);
  const payload = parsed.normalizedAddress.includes(':')
    ? parsed.normalizedAddress.split(':').pop() || ''
    : parsed.normalizedAddress;

  const params = new URLSearchParams();
  if (options?.amount !== undefined && options.amount !== '') {
    params.set('amount', String(options.amount));
  }
  if (options?.label) params.set('label', options.label);
  if (options?.message) params.set('message', options.message);

  const query = params.toString();
  return query ? `${scheme}:${payload}?${query}` : `${scheme}:${payload}`;
}

import {
  CashAddressType,
  decodeBase58Address,
  decodeCashAddress,
} from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';

const MAINNET_PREFIX = 'bitcoincash';
const CHIPNET_PREFIX = 'bchtest';

export type ParsedBip21Uri = {
  isValidAddress: boolean;
  isBip21Uri: boolean;
  normalizedAddress: string;
  isCashAddress: boolean;
  isBase58Address: boolean;
  isTokenAddress: boolean;
  /** Explicit cashaddr prefix that does not match the active wallet network. */
  networkMismatch?: boolean;
  amount?: number;
  amountRaw?: string;
  label?: string;
  message?: string;
};

function expectedPrefixForNetwork(network: Network): string {
  return network === Network.MAINNET ? MAINNET_PREFIX : CHIPNET_PREFIX;
}

function oppositePrefix(network: Network): string {
  return network === Network.MAINNET ? CHIPNET_PREFIX : MAINNET_PREFIX;
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

/**
 * Parse a cashaddr / BIP21 string for the *active* wallet network only.
 *
 * Never accepts the opposite chain's prefix (bitcoincash vs bchtest). Doing so
 * let chipnet wallets "send to mainnet addresses" — same hash160, wrong chain,
 * coins invisible on the destination mainnet wallet.
 */
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

  const expectedPrefix = expectedPrefixForNetwork(network);
  const wrongPrefix = oppositePrefix(network);
  const maybePrefix = addressChunks[0]?.toLowerCase();

  // Explicit wrong-network cashaddr (bitcoincash:… while on chipnet, or reverse).
  if (
    addressChunks.length > 1 &&
    (maybePrefix === MAINNET_PREFIX || maybePrefix === CHIPNET_PREFIX) &&
    maybePrefix !== expectedPrefix
  ) {
    return {
      isValidAddress: false,
      isBip21Uri,
      normalizedAddress: '',
      isCashAddress: false,
      isBase58Address: false,
      isTokenAddress: false,
      networkMismatch: true,
      amount,
      amountRaw,
      label,
      message,
    };
  }

  const isBase58Address =
    typeof decodeBase58Address(noPrefixAddress) === 'object';

  if (isBase58Address) {
    // Legacy base58 is mainnet-oriented; reject on chipnet to avoid silent
    // cross-network pays. Mainnet still accepts base58 P2PKH.
    if (network !== Network.MAINNET) {
      return {
        isValidAddress: false,
        isBip21Uri,
        normalizedAddress: '',
        isCashAddress: false,
        isBase58Address: true,
        isTokenAddress: false,
        networkMismatch: true,
        amount,
        amountRaw,
        label,
        message,
      };
    }
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

  // Only try the active network's prefix (plus an already-matching explicit one).
  const prefixesToTry = [maybePrefix, expectedPrefix].filter(
    (prefix): prefix is string =>
      !!prefix &&
      prefix !== wrongPrefix &&
      (prefix === expectedPrefix ||
        prefix === MAINNET_PREFIX ||
        prefix === CHIPNET_PREFIX)
  );
  // Dedupe while preserving order
  const seen = new Set<string>();
  const uniquePrefixes = prefixesToTry.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return p === expectedPrefix; // only expected network
  });

  for (const prefix of uniquePrefixes) {
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

/** User-facing reason when a destination is not valid for this network. */
export function recipientNetworkError(
  input: string,
  network: Network
): string | null {
  const parsed = parseBip21Uri(input, network);
  if (parsed.isValidAddress) return null;
  if (parsed.networkMismatch) {
    return network === Network.MAINNET
      ? 'That address is for Chipnet (bchtest:). This wallet is on Mainnet — paste a bitcoincash: address.'
      : 'That address is for Mainnet (bitcoincash:). This wallet is on Chipnet — paste a bchtest: address.';
  }
  if (!input.trim()) return 'Please enter a destination address.';
  return 'Please enter a valid destination address for this network.';
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

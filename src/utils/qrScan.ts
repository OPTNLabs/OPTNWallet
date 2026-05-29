import { decodePrivateKeyWif } from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';
import { parseBip21Uri } from './bip21';

const BASE58_WIF_PATTERN =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
const BASE58_WIF_CANDIDATE_PATTERN =
  /[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{50,52}/g;

export type ScannedQrPayload =
  | {
      kind: 'paper-wallet';
      scannedValue: string;
      paperWalletWif: string;
    }
  | {
      kind: 'recipient';
      scannedValue: string;
      normalizedAddress: string;
      amountRaw?: string;
      isBip21Uri: boolean;
    }
  | {
      kind: 'unknown';
      scannedValue: string;
    };

export function extractWifCandidates(value: string): string[] {
  const trimmed = value.trim();
  const candidates = new Set<string>();

  if (BASE58_WIF_PATTERN.test(trimmed)) {
    candidates.add(trimmed);
  }

  for (const match of trimmed.match(BASE58_WIF_CANDIDATE_PATTERN) ?? []) {
    if (match && BASE58_WIF_PATTERN.test(match)) {
      candidates.add(match);
    }
  }

  const lastColonIndex = trimmed.lastIndexOf(':');
  if (lastColonIndex !== -1) {
    const suffix = trimmed.slice(lastColonIndex + 1).trim();
    if (suffix && suffix !== trimmed && BASE58_WIF_PATTERN.test(suffix)) {
      candidates.add(suffix);
    }
  }

  return [...candidates];
}

export function classifyScannedQrPayload(
  input: string,
  network: Network
): ScannedQrPayload {
  const scannedValue = input.trim();
  if (!scannedValue) {
    return { kind: 'unknown', scannedValue: '' };
  }

  for (const candidate of extractWifCandidates(scannedValue)) {
    const decoded = decodePrivateKeyWif(candidate);
    if (typeof decoded !== 'string') {
      return {
        kind: 'paper-wallet',
        scannedValue,
        paperWalletWif: candidate,
      };
    }
  }

  const parsed = parseBip21Uri(scannedValue, network);
  if (parsed.isValidAddress) {
    return {
      kind: 'recipient',
      scannedValue,
      normalizedAddress: parsed.normalizedAddress,
      amountRaw: parsed.amountRaw,
      isBip21Uri: parsed.isBip21Uri,
    };
  }

  return { kind: 'unknown', scannedValue };
}

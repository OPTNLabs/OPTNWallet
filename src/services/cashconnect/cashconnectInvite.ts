import { Wallet } from '@cashconnect-js/nostr/wallet';

export const CASHCONNECT_URI_SCHEME = 'bch-cc-v1:';

export function parseCashConnectInvite(value: string): string | null {
  const uri = value.trim();
  if (!uri) return null;
  try {
    Wallet.parseInviteUrl(uri);
    return new URL(uri).href;
  } catch {
    return null;
  }
}

export function isCashConnectUri(value: string): boolean {
  return parseCashConnectInvite(value) !== null;
}

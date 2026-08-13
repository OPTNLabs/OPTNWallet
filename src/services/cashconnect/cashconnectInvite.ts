export const CASHCONNECT_URI_SCHEME = 'bch-cc-v1:';

export function isCashConnectUri(value: string): boolean {
  return value.trim().toLowerCase().startsWith(CASHCONNECT_URI_SCHEME);
}

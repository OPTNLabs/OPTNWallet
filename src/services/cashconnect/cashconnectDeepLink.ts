import { parseCashConnectInvite } from './cashconnectInvite';

let pendingInvite: string | null = null;

export function stashCashConnectInvite(uri: string): void {
  pendingInvite = uri;
}

export function takeStashedCashConnectInvite(): string | null {
  const next = pendingInvite;
  pendingInvite = null;
  return next;
}

export function peekStashedCashConnectInvite(): string | null {
  return pendingInvite;
}

export function extractCashConnectUriFromOpenUrl(
  openUrl: string
): string | null {
  const trimmed = openUrl.trim();
  if (!trimmed) return null;

  const direct = parseCashConnectInvite(trimmed);
  if (direct) return direct;

  try {
    const url = new URL(trimmed);
    const fromQuery =
      url.searchParams.get('uri') ?? url.searchParams.get('invite');
    if (fromQuery) {
      const nested = parseCashConnectInvite(fromQuery);
      if (nested) return nested;
    }
  } catch {
    // Not a standard URL — fall through to a scheme search.
  }

  const embedded = trimmed.match(/bch-cc-v1:[^\s"'<>]+/i);
  return embedded ? parseCashConnectInvite(embedded[0]) : null;
}

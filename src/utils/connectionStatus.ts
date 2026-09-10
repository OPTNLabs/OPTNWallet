import type { TranslationKey } from '../i18n/resources';

/** WizardConnect exposes relay health, not completion of the dApp handshake. */
export function wizardConnectionStatus(status: string): TranslationKey {
  switch (status) {
    case 'connected':
      return 'connection.relayAvailable';
    case 'reconnecting':
      return 'connection.reconnecting';
    case 'disconnected':
      return 'connection.disconnected';
    case 'session_deleted':
      return 'connection.sessionEnded';
    default:
      return 'connection.unknown';
  }
}

/** A valid authorization is not evidence that the remote application is online. */
export function walletConnectSessionStatus(
  session: { acknowledged?: boolean; expiry?: number },
  nowSeconds: number
): TranslationKey {
  const expiry = session.expiry;
  if (
    typeof expiry !== 'number' ||
    !Number.isFinite(expiry) ||
    !Number.isFinite(nowSeconds)
  ) {
    return 'connection.unknown';
  }
  if (expiry <= nowSeconds) return 'connection.expired';
  return session.acknowledged === true
    ? 'connection.sessionAuthorized'
    : 'connection.awaitingAcknowledgement';
}

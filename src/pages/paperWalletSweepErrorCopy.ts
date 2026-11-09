import type { TranslationKey } from '../i18n/resources';

type Translate = (key: TranslationKey) => string;

export function friendlySweepError(message: string, t: Translate): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('insufficient funds') ||
    normalized.includes('not enough funds')
  ) {
    return t('send.insufficientFunds');
  }
  if (
    normalized.includes('network') ||
    normalized.includes('timeout') ||
    normalized.includes('connection') ||
    normalized.includes('offline') ||
    normalized.includes('unreachable')
  ) {
    return t('send.networkError');
  }
  if (
    /^(no qr|invalid qr|no active|no destination|enter|paper wallet)/i.test(
      message
    )
  ) {
    return message;
  }
  return t('send.genericError');
}

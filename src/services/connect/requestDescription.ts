import type { TranslationKey } from '../../i18n/resources';

export type ConnectorRequestDescription = {
  titleKey: TranslationKey;
  detail: string | null;
  tokenLabel: string | null;
};

const CAULDRON_SWAP = /^cauldron\s+swap\s+(.+?)\s*->\s*(.+)$/i;

/**
 * Turn the optional app-supplied prompt into a short, clearly labelled
 * description for the approval sheet. The prompt is context only; verified
 * wallet effects remain the source of truth for what will change.
 */
export function describeConnectorRequest(
  prompt: unknown
): ConnectorRequestDescription {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return {
      titleKey: 'txReview.transactionRequest',
      detail: null,
      tokenLabel: null,
    };
  }

  const detail = prompt.trim();
  const swap = detail.match(CAULDRON_SWAP);
  if (swap) {
    const from = swap[1].trim();
    const to = swap[2].trim();
    const tokenLabel = /\bBCH\b/i.test(from) ? to : from;
    return {
      titleKey: 'txReview.cauldronSwap',
      detail: `${from} → ${to}`,
      tokenLabel,
    };
  }

  if (/^merchant\s+payment\b/i.test(detail)) {
    return {
      titleKey: 'txReview.cauldronPayment',
      detail,
      tokenLabel: null,
    };
  }

  if (/^create\s+cauldron\s+pool\b/i.test(detail)) {
    return {
      titleKey: 'txReview.cauldronPoolCreate',
      detail,
      tokenLabel: null,
    };
  }

  if (/^withdraw\s+cauldron\s+pool\b/i.test(detail)) {
    return {
      titleKey: 'txReview.cauldronPoolWithdraw',
      detail,
      tokenLabel: null,
    };
  }

  return {
    titleKey: 'txReview.transactionRequest',
    detail,
    tokenLabel: null,
  };
}

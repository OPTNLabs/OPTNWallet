export type CauldronQuoteSafetyState = {
  builtAt: number;
  usedCachedPools: boolean;
  warnings: string[];
};

export type CauldronQuoteSafetyBanner = {
  title: string;
  messages: string[];
};

function dedupeMessages(messages: string[]): string[] {
  return [...new Set(messages.map((message) => message.trim()).filter(Boolean))];
}

export function buildCauldronQuoteSafetyBanner(args: {
  quote: CauldronQuoteSafetyState | null;
  liveUpdatesEnabled: boolean;
  liveUpdatedAt: number | null;
  nowMs: number;
}): CauldronQuoteSafetyBanner | null {
  const { quote, liveUpdatesEnabled, liveUpdatedAt, nowMs } = args;
  if (!quote) return null;

  const messages: string[] = [];
  const staleReasons: string[] = [];

  if (!liveUpdatesEnabled) {
    staleReasons.push(
      'Live pool updates are unavailable right now, so this quote should be refreshed before confirming.'
    );
  }

  if (quote.usedCachedPools) {
    staleReasons.push(
      'This quote used the already-visible pool set because live pool confirmation was rate-limited.'
    );
  }

  if (liveUpdatedAt != null && quote.builtAt < liveUpdatedAt) {
    staleReasons.push(
      'The market changed after this quote was built. Refresh the quote before confirming.'
    );
  }

  const ageSeconds = Math.max(0, Math.floor((nowMs - quote.builtAt) / 1000));
  if (ageSeconds >= 60) {
    staleReasons.push(
      `This quote is ${ageSeconds}s old. Refresh it before confirming.`
    );
  }

  messages.push(...staleReasons, ...quote.warnings);
  const uniqueMessages = dedupeMessages(messages);
  if (uniqueMessages.length === 0) return null;

  return {
    title:
      staleReasons.length > 0
        ? 'Quote may be stale'
        : 'Review quote risks',
    messages: uniqueMessages,
  };
}

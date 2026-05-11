export type CauldronQuoteFailureKind =
  | 'minimum'
  | 'market-changed'
  | 'no-route'
  | 'no-confirmed-pools'
  | 'rate-limited'
  | 'generic';

export function classifyCauldronQuoteFailure(message: string): {
  kind: CauldronQuoteFailureKind;
  message: string;
} {
  const lower = message.toLowerCase();
  if (lower.includes('below the current minimum routable market size')) {
    return { kind: 'minimum', message };
  }
  if (lower.includes('changed on chain before this quote could be built')) {
    return { kind: 'market-changed', message };
  }
  if (lower.includes('no cauldron quote is currently available for that amount')) {
    return { kind: 'no-route', message };
  }
  if (lower.includes('no executable cauldron pools are currently confirmed on chain')) {
    return { kind: 'no-confirmed-pools', message };
  }
  if (lower.includes('rate limit')) {
    return { kind: 'rate-limited', message };
  }
  return { kind: 'generic', message };
}

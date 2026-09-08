/**
 * The live Chipnet E2E runner must be explicitly opted into before it spends.
 * Treat every value other than the documented `1` as disabled.
 */
export function isChipnetBroadcastEnabled(value: string | undefined): boolean {
  return value === '1';
}

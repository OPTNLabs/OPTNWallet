export function normalizeRelayDraft(value: string): string | null {
  const trimmed = value.trim();
  if (!/^wss:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(trimmed)) return null;
  return trimmed.replace(/\/$/, '');
}

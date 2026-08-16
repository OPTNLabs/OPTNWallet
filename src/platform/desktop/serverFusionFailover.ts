/**
 * Select one Fusion server before any wallet key derivation or native round.
 * Candidate preparation includes Tor routing plus a validated ServerHello.
 * Once this function returns, the caller runs exactly that candidate and never
 * rotates after a round may have disclosed components or signatures.
 */

export function orderedFusionServerCandidates(
  selected: string | null | undefined,
  configured: readonly string[]
): string[] {
  const ordered = selected ? [selected, ...configured] : [...configured];
  const seen = new Set<string>();
  return ordered.filter((server) => {
    const normalized = server.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export async function selectPreparedFusionServer<T>(options: {
  selected?: string | null;
  configured: readonly string[];
  prepare: (server: string) => Promise<T>;
}): Promise<{ server: string; prepared: T }> {
  const candidates = orderedFusionServerCandidates(
    options.selected,
    options.configured
  );
  if (candidates.length === 0) {
    throw new Error('no fusion server selected');
  }

  let lastError: unknown = null;
  for (const server of candidates) {
    try {
      return { server, prepared: await options.prepare(server) };
    } catch (error) {
      lastError = error;
    }
  }

  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    detail
      ? `no configured fusion server is ready: ${detail}`
      : 'no configured fusion server is ready'
  );
}

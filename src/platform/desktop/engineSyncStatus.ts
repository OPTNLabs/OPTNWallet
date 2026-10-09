/**
 * Holder-facing wording for the shared engine's sync status: how old the
 * snapshot is, which providers are not usable, and where the verified headers
 * stand. The same wording as `optn_app::snapshot_age_label`,
 * `provider_health_summary` and `header_checkpoint_label`, so every surface
 * says the same thing.
 */

export type EngineProviderHealth =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'offline';

export type EngineProviderStatus = {
  source: string;
  /** The protocol's label, such as "Fulcrum / Electrum". */
  protocol: string;
  health: EngineProviderHealth;
};

export type EngineHeaderCheckpoint = {
  height: number;
  /** Who vouches for the view's starting point, such as "shipped-reviewed". */
  provenance: string;
};

const HEALTH: readonly EngineProviderHealth[] = [
  'unknown',
  'healthy',
  'degraded',
  'offline',
];

/** Providers from a runtime snapshot; malformed entries are dropped. */
export function parseEngineProviders(value: unknown): EngineProviderStatus[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const candidate = entry as Partial<
      Record<keyof EngineProviderStatus, unknown>
    >;
    if (
      typeof candidate?.source !== 'string' ||
      typeof candidate.protocol !== 'string' ||
      !HEALTH.includes(candidate.health as EngineProviderHealth)
    ) {
      return [];
    }
    return [
      {
        source: candidate.source,
        protocol: candidate.protocol,
        health: candidate.health as EngineProviderHealth,
      },
    ];
  });
}

/** A header checkpoint from a runtime snapshot, or `null` if absent or malformed. */
export function parseEngineHeaderCheckpoint(
  value: unknown
): EngineHeaderCheckpoint | null {
  const candidate = value as Partial<
    Record<keyof EngineHeaderCheckpoint, unknown>
  >;
  return typeof candidate?.height === 'number' &&
    Number.isInteger(candidate.height) &&
    candidate.height >= 0 &&
    typeof candidate.provenance === 'string'
    ? { height: candidate.height, provenance: candidate.provenance }
    : null;
}

/**
 * How old a snapshot accepted at `snapshotAtUnixMs` is at `nowUnixMs`. A clock
 * behind the snapshot reads as just now, never as a negative age.
 */
export function snapshotAgeLabel(
  snapshotAtUnixMs: number,
  nowUnixMs: number
): string {
  const minutes = Math.floor(
    Math.max(0, nowUnixMs - snapshotAtUnixMs) / 60_000
  );
  if (minutes === 0) return 'updated just now';
  if (minutes < 60) return `updated ${minutes} min ago`;
  if (minutes < 2_880) return `updated ${Math.floor(minutes / 60)} h ago`;
  return `updated ${Math.floor(minutes / 1_440)} days ago`;
}

/** The providers that are degraded or offline, or `null` while all are usable. */
export function providerHealthSummary(
  providers: readonly EngineProviderStatus[]
): string | null {
  const troubled = providers
    .filter(({ health }) => health === 'degraded' || health === 'offline')
    .map(({ source, protocol, health }) => `${source} (${protocol}) ${health}`);
  return troubled.length === 0
    ? null
    : `${troubled.length} of ${providers.length} providers not usable: ${troubled.join(', ')}`;
}

const ANCHORS: Record<string, string> = {
  'shipped-reviewed': ' from the checkpoint shipped with the wallet',
  'self-derived': ' from a start derived on this device',
  'sampled-independent-sources':
    ' from a checkpoint sampled across independent sources',
  'user-provided': ' from a checkpoint you provided',
};

/** Where the verified headers stand, and who vouches for where they began. */
export function headerCheckpointLabel(
  checkpoint: EngineHeaderCheckpoint
): string {
  return `Headers verified to ${checkpoint.height}${ANCHORS[checkpoint.provenance] ?? ''}`;
}

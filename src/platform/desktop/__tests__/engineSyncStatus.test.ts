import { describe, expect, it } from 'vitest';
import {
  headerCheckpointLabel,
  parseEngineHeaderCheckpoint,
  parseEngineProviders,
  providerHealthSummary,
  snapshotAgeLabel,
} from '../engineSyncStatus';

describe('engine sync status wording', () => {
  // The same table as optn_app's snapshot_age_reads_in_the_largest_whole_unit.
  it('reads a snapshot age in the largest whole unit', () => {
    const at = 1_760_000_000_000;
    const minute = 60_000;
    for (const [elapsed, label] of [
      [0, 'updated just now'],
      [minute - 1, 'updated just now'],
      [minute, 'updated 1 min ago'],
      [59 * minute, 'updated 59 min ago'],
      [60 * minute, 'updated 1 h ago'],
      [47 * 60 * minute, 'updated 47 h ago'],
      [48 * 60 * minute, 'updated 2 days ago'],
    ] as const) {
      expect(snapshotAgeLabel(at, at + elapsed)).toBe(label);
    }
    expect(snapshotAgeLabel(at, at - minute)).toBe('updated just now');
  });

  it('names only the providers that are not usable', () => {
    const provider = (
      source: string,
      health: 'healthy' | 'unknown' | 'offline' | 'degraded'
    ) => ({
      source,
      protocol: 'BIP37',
      health,
    });
    expect(providerHealthSummary([])).toBeNull();
    expect(
      providerHealthSummary([
        provider('a', 'healthy'),
        provider('b', 'unknown'),
      ])
    ).toBeNull();
    expect(
      providerHealthSummary([
        provider('a', 'healthy'),
        provider('b', 'offline'),
        provider('c', 'degraded'),
      ])
    ).toBe(
      '2 of 3 providers not usable: b (BIP37) offline, c (BIP37) degraded'
    );
  });

  it('names the header anchor only when it is a known one', () => {
    expect(
      headerCheckpointLabel({ height: 900_000, provenance: 'shipped-reviewed' })
    ).toBe(
      'Headers verified to 900000 from the checkpoint shipped with the wallet'
    );
    expect(
      headerCheckpointLabel({ height: 900_000, provenance: 'something-newer' })
    ).toBe('Headers verified to 900000');
  });

  it('drops malformed runtime entries and reads older payloads as not known', () => {
    expect(parseEngineProviders(undefined)).toEqual([]);
    expect(
      parseEngineProviders([
        { source: 'a', protocol: 'BIP37', health: 'offline' },
        { source: 'b', protocol: 'BIP37', health: 'sideways' },
        { source: 3, protocol: 'BIP37', health: 'healthy' },
        null,
      ])
    ).toEqual([{ source: 'a', protocol: 'BIP37', health: 'offline' }]);
    expect(parseEngineHeaderCheckpoint(undefined)).toBeNull();
    expect(
      parseEngineHeaderCheckpoint({ height: -1, provenance: 'x' })
    ).toBeNull();
    expect(
      parseEngineHeaderCheckpoint({ height: 1.5, provenance: 'x' })
    ).toBeNull();
    expect(
      parseEngineHeaderCheckpoint({ height: 7, provenance: 'self-derived' })
    ).toEqual({ height: 7, provenance: 'self-derived' });
  });
});

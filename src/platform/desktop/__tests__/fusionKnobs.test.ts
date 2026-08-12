import { afterEach, describe, expect, it } from 'vitest';
import {
  applyFusionKnobs,
  clampFusionKnobs,
  FUSION_KNOB_DEFAULTS,
  formatTiersInput,
  getFusionKnobs,
  parseTiersInput,
  resetFusionKnobs,
} from '../fusionKnobs';

describe('fusion knobs', () => {
  afterEach(() => {
    resetFusionKnobs();
  });

  it('defaults to min 6 / min safe 4 / max 10 and five sat tiers', () => {
    expect(FUSION_KNOB_DEFAULTS.minPlayers).toBe(6);
    expect(FUSION_KNOB_DEFAULTS.minSafePlayers).toBe(4);
    expect(FUSION_KNOB_DEFAULTS.maxPlayers).toBe(10);
    expect(FUSION_KNOB_DEFAULTS.tiersSats).toEqual([
      10_000, 100_000, 1_000_000, 10_000_000, 100_000_000,
    ]);
  });

  it('will not go below the onion floor or above the wire cap', () => {
    const knobs = clampFusionKnobs({
      minSafePlayers: 2,
      minPlayers: 2,
      maxPlayers: 99,
    });
    expect(knobs.minSafePlayers).toBe(3);
    expect(knobs.minPlayers).toBe(3);
    expect(knobs.maxPlayers).toBe(20);
  });

  it('keeps min at least min-safe', () => {
    const knobs = clampFusionKnobs({ minSafePlayers: 5, minPlayers: 4 });
    expect(knobs.minSafePlayers).toBe(5);
    expect(knobs.minPlayers).toBe(5);
  });

  it('keeps max at least min', () => {
    const knobs = clampFusionKnobs({ minPlayers: 8, maxPlayers: 5 });
    expect(knobs.minPlayers).toBe(8);
    expect(knobs.maxPlayers).toBe(8);
  });

  it('parses BCH tier lists into sats', () => {
    expect(parseTiersInput('0.0001, 0.001, 1')).toEqual([
      10_000, 100_000, 100_000_000,
    ]);
    expect(formatTiersInput([10_000, 100_000_000])).toBe('0.0001, 1');
  });

  it('applies a live overlay the gather engine can read', () => {
    applyFusionKnobs({ maxPlayers: 9, smallSetHoldMs: 12_000 });
    expect(getFusionKnobs().maxPlayers).toBe(9);
    expect(getFusionKnobs().smallSetHoldMs).toBe(12_000);
  });

  it('reset drops a live overlay back to the protocol defaults', () => {
    applyFusionKnobs({ minPlayers: 4, maxPlayers: 8 });
    resetFusionKnobs();
    expect(getFusionKnobs().minPlayers).toBe(6);
    expect(getFusionKnobs().minSafePlayers).toBe(4);
    expect(getFusionKnobs().maxPlayers).toBe(10);
  });
});

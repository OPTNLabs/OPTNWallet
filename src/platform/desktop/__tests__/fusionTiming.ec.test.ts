import { describe, expect, it } from 'vitest';
import {
  ACCEPT_UNCONFIRMED_FUSION_INPUTS,
  AUTO_WAIT_FOR_BLOCK_BEFORE_NEXT_ROUND,
  EC_DEFAULT_MAX_COINS,
  EC_MAX_FUSE_DEPTH,
  P2P_GATHER_MAX_MS,
  SERVER_BLAME_VERIFY_MS,
  SERVER_COMPS_END_MS,
  SERVER_COMPS_START_MS,
  SERVER_CONCLUSION_MS,
  SERVER_COVERT_CONNECT_SPARES,
  SERVER_COVERT_CONNECT_TIMEOUT_MS,
  SERVER_COVERT_CONNECT_WINDOW_MS,
  SERVER_COVERT_SUBMIT_MS,
  SERVER_COVERT_SUBMIT_TIMEOUT_MS,
  SERVER_JOIN_ACTIVE_CEILING_MS,
  SERVER_JOIN_ALONE_MS,
  SERVER_JOIN_WAIT_MS,
  SERVER_MAX_CLOCK_DISCREPANCY_MS,
  SERVER_MIN_OUTPUT_SATS,
  SERVER_ROUND_BLAME_MS,
  SERVER_ROUND_CLOSE_MS,
  SERVER_SIGS_END_MS,
  SERVER_SIGS_START_MS,
  SERVER_STANDARD_TIMEOUT_MS,
  SERVER_WARMUP_SLOP_MS,
  SERVER_WARMUP_TIME_MS,
} from '../fusionTiming';
import { AUTO_FUSION_COOLDOWN_MS } from '../fusionAutoEngine';

/**
 * Guard rails: these must stay equal to Electron Cash protocol.py / plugin.py.
 * If a test fails, re-read the EC sources before "fixing" by changing OPTN.
 */
describe('Electron Cash protocol.py timing (strict)', () => {
  it('matches critical covert timeline', () => {
    expect(SERVER_COMPS_START_MS).toBe(5_000);
    expect(SERVER_COMPS_END_MS).toBe(15_000);
    expect(SERVER_SIGS_START_MS).toBe(20_000);
    expect(SERVER_SIGS_END_MS).toBe(30_000);
    expect(SERVER_CONCLUSION_MS).toBe(35_000);
    expect(SERVER_ROUND_CLOSE_MS).toBe(45_000);
    expect(SERVER_ROUND_BLAME_MS).toBe(80_000);
  });

  it('matches warmup and covert connection constants', () => {
    expect(SERVER_WARMUP_TIME_MS).toBe(30_000);
    expect(SERVER_WARMUP_SLOP_MS).toBe(3_000);
    expect(SERVER_COVERT_CONNECT_WINDOW_MS).toBe(15_000);
    expect(SERVER_COVERT_CONNECT_TIMEOUT_MS).toBe(15_000);
    expect(SERVER_COVERT_SUBMIT_MS).toBe(5_000);
    expect(SERVER_COVERT_SUBMIT_TIMEOUT_MS).toBe(3_000);
    expect(SERVER_COVERT_CONNECT_SPARES).toBe(6);
    expect(SERVER_MAX_CLOCK_DISCREPANCY_MS).toBe(5_000);
    expect(SERVER_STANDARD_TIMEOUT_MS).toBe(3_000);
    expect(SERVER_BLAME_VERIFY_MS).toBe(5_000);
    expect(SERVER_MIN_OUTPUT_SATS).toBe(10_000);
  });
});

describe('Electron Cash plugin.py client policy', () => {
  it('alone JoinPools budget is P2P-fast (~120s), not a flat 10 min', () => {
    expect(SERVER_JOIN_ALONE_MS).toBe(120_000);
    expect(SERVER_JOIN_WAIT_MS).toBe(SERVER_JOIN_ALONE_MS);
    // Active pool / scheduled start may extend up to EC inactive ceiling.
    expect(SERVER_JOIN_ACTIVE_CEILING_MS).toBe(600_000);
  });

  it('caps batch size at DEFAULT_MAX_COINS = 20', () => {
    expect(EC_DEFAULT_MAX_COINS).toBe(20);
    expect(EC_DEFAULT_MAX_COINS).toBeGreaterThan(10);
  });

  it('matches UI fuse-depth ceiling', () => {
    expect(EC_MAX_FUSE_DEPTH).toBe(10);
  });

  it('keeps P2P gather on the same alone scale as server alone wait', () => {
    expect(P2P_GATHER_MAX_MS).toBe(120_000);
    expect(P2P_GATHER_MAX_MS).toBe(SERVER_JOIN_ALONE_MS);
  });
});

describe('unconfirmed inputs + no block-wait between Auto rounds', () => {
  it('accepts unconfirmed fusion inputs (EC-maintainer-endorsed direction)', () => {
    expect(ACCEPT_UNCONFIRMED_FUSION_INPUTS).toBe(true);
  });

  it('does not wait for a block confirmation before the next Auto round', () => {
    expect(AUTO_WAIT_FOR_BLOCK_BEFORE_NEXT_ROUND).toBe(false);
    // Post-success delay is Electrum lag only — far below one block (~10 min).
    expect(AUTO_FUSION_COOLDOWN_MS).toBeLessThan(60_000);
  });
});

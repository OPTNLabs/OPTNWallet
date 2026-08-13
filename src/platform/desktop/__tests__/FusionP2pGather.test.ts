import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectRolling } from '../FusionP2pService';

vi.mock('../nostr/fusion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nostr/fusion')>();
  return {
    ...actual,
    MIN_PARTICIPANTS: 3,
    MAX_PARTICIPANTS: 4,
    isLivePoolAnnouncement: vi.fn(() => true),
  };
});

vi.mock('../fusionTiming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fusionTiming')>();
  return {
    ...actual,
    P2P_GATHER_ALONE_AUTO_MS: 10_000,
    P2P_GATHER_ALONE_MS: 10_000,
    P2P_GATHER_FAST_WARMUP_MS: 10_000,
    P2P_GATHER_MAX_MS: 10_000,
    P2P_GATHER_MIN_MS: 0,
    P2P_PEAK_GRACE_MS: 3_000,
    P2P_PEER_SET_STABLE_FAST_MS: 0,
    P2P_PEER_SET_STABLE_MS: 0,
    P2P_SMALL_SET_HOLD_MS: 0,
  };
});

vi.mock('../fusionRoundState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fusionRoundState')>();
  return {
    ...actual,
    isOwnRoundKey: vi.fn(() => false),
    isRetiredRoundKey: vi.fn(() => false),
    isBlamedSessionKey: vi.fn(() => false),
  };
});

vi.mock('../logger', () => ({
  log: {
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  },
}));

describe('P2P rolling gather', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never proposes three after this attempt already observed four strict peers', async () => {
    const peers = ['a', 'b', 'c', 'd'].map((pubkey) => ({ pubkey }));
    let visible = peers;
    const statuses: string[] = [];

    const gather = collectRolling(
      1,
      'a',
      () => visible as never,
      (message) => statuses.push(message),
      undefined,
      undefined,
      'auto'
    );
    const rejected = expect(gather).rejects.toThrow(
      /peer set changed.*peak 4, now 3/i
    );

    await vi.advanceTimersByTimeAsync(1);
    visible = peers.slice(0, 3);
    await vi.advanceTimersByTimeAsync(4_100);

    await rejected;
    expect(statuses.some((message) => message.startsWith('Gather done:'))).toBe(
      false
    );
  });
});

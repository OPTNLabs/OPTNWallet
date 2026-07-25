import { describe, expect, it } from 'vitest';
import {
  AUTO_FUSION_COOLDOWN_MS,
  decideAutoFusion,
  type AutoFusionInputs,
} from '../fusionAutoEngine';

/** A wallet that SHOULD fuse; each test negates exactly one thing. */
const ready: AutoFusionInputs = {
  cashFusionEnabled: true,
  autoFuseEnabled: true,
  p2pFusionEnabled: true,
  walletId: 4,
  busy: false,
  eligibleCoinCount: 3,
  torReady: true,
  nowMs: 10_000_000,
  lastAttemptMs: null,
};

describe('auto-fusion decision', () => {
  it('runs the selected P2P transport when everything is ready', () => {
    expect(decideAutoFusion(ready)).toEqual({ run: true, mode: 'p2p' });
  });

  it('runs server fusion when P2P is not the selected mode', () => {
    expect(decideAutoFusion({ ...ready, p2pFusionEnabled: false })).toEqual({
      run: true,
      mode: 'server',
    });
  });

  it('never runs both: the mode is a single choice', () => {
    const p2p = decideAutoFusion(ready);
    const server = decideAutoFusion({ ...ready, p2pFusionEnabled: false });
    expect(p2p).not.toEqual(server);
    // Whatever it picks, it is exactly one transport.
    expect([p2p, server].every((d) => d.run && 'mode' in d)).toBe(true);
  });

  it.each([
    ['master switch off', { cashFusionEnabled: false }],
    ['auto-fusion policy off', { autoFuseEnabled: false }],
    ['no wallet open', { walletId: 0 }],
    ['a round already running', { busy: true }],
    ['every coin at the depth limit', { eligibleCoinCount: 0 }],
  ])('refuses to spend a fee when %s', (_label, override) => {
    const decision = decideAutoFusion({ ...ready, ...override });
    expect(decision.run).toBe(false);
  });

  it('will not start P2P without Tor', () => {
    const decision = decideAutoFusion({ ...ready, torReady: false });
    expect(decision).toEqual({
      run: false,
      reason: 'Tor is not ready for P2P fusion',
    });
  });

  it('lets server fusion proceed without Tor, which it enforces itself', () => {
    expect(
      decideAutoFusion({ ...ready, p2pFusionEnabled: false, torReady: false })
    ).toEqual({ run: true, mode: 'server' });
  });

  it('holds off until the cooldown has fully elapsed', () => {
    const justBefore = {
      ...ready,
      lastAttemptMs: ready.nowMs - (AUTO_FUSION_COOLDOWN_MS - 1),
    };
    expect(decideAutoFusion(justBefore).run).toBe(false);

    const justAfter = { ...ready, lastAttemptMs: ready.nowMs - AUTO_FUSION_COOLDOWN_MS };
    expect(decideAutoFusion(justAfter)).toEqual({ run: true, mode: 'p2p' });
  });

  it('treats a backwards clock as "not yet", never as an instant retry', () => {
    // lastAttempt in the future => negative elapsed. A naive `elapsed > cooldown`
    // would be false here too, but a naive `Math.abs` would fire immediately.
    const skewed = { ...ready, lastAttemptMs: ready.nowMs + 60_000 };
    expect(decideAutoFusion(skewed).run).toBe(false);
  });

  it('checks busy BEFORE the cooldown, so a long round is never doubled up', () => {
    // Cooldown long elapsed, but a round is still in flight from that attempt.
    const longRound = {
      ...ready,
      busy: true,
      lastAttemptMs: ready.nowMs - AUTO_FUSION_COOLDOWN_MS * 4,
    };
    expect(decideAutoFusion(longRound)).toEqual({
      run: false,
      reason: 'A fusion round is already running',
    });
  });
});

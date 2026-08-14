import { describe, expect, it } from 'vitest';
import {
  AUTO_RENDEZVOUS_OPEN_MS,
  AUTO_RENDEZVOUS_PERIOD_MS,
  SERVER_AUTO_POLL_MS,
  decideAutoFusion,
  isAutoRendezvousOpen,
  isAutoTransientFailure,
  msUntilAutoRendezvousOpen,
  msUntilServerAutoStart,
  nextAutoEngineTickForMode,
  nextAutoEngineTickMs,
  nextServerAutoEngineTickMs,
  type AutoFusionInputs,
} from '../fusionAutoEngine';

/** A wallet that SHOULD fuse; each test negates exactly one thing. */
const ready: AutoFusionInputs = {
  cashFusionEnabled: true,
  autoFuseEnabled: true,
  p2pFusionEnabled: true,
  walletId: 4,
  torReady: true,
};

describe('auto-fusion policy decision', () => {
  it('runs the selected P2P transport when everything is ready', () => {
    expect(decideAutoFusion(ready)).toEqual({ run: true, mode: 'p2p' });
  });

  it('runs server fusion when P2P is not the selected mode', () => {
    expect(decideAutoFusion({ ...ready, p2pFusionEnabled: false })).toEqual({
      run: true,
      mode: 'server',
    });
  });

  it('picks exactly one transport, never both', () => {
    const p2p = decideAutoFusion(ready);
    const server = decideAutoFusion({ ...ready, p2pFusionEnabled: false });
    expect(p2p).not.toEqual(server);
    expect([p2p, server].every((d) => d.run && 'mode' in d)).toBe(true);
  });

  it.each([
    ['master switch off', { cashFusionEnabled: false }],
    ['auto-fusion policy off', { autoFuseEnabled: false }],
    ['no wallet open', { walletId: 0 }],
    ['a negative wallet id', { walletId: -1 }],
  ])('refuses to start when %s', (_label, override) => {
    expect(decideAutoFusion({ ...ready, ...override }).run).toBe(false);
  });

  it('will not start P2P without Tor', () => {
    expect(decideAutoFusion({ ...ready, torReady: false })).toEqual({
      run: false,
      reason: 'Tor is not ready for P2P fusion',
    });
  });

  it('lets server fusion proceed without Tor, which it enforces itself', () => {
    expect(
      decideAutoFusion({ ...ready, p2pFusionEnabled: false, torReady: false })
    ).toEqual({ run: true, mode: 'server' });
  });

  it('does not re-check what the runner owns authoritatively', () => {
    // Busy, cooldown and coin eligibility are decided by the cross-window lease,
    // the atomic cooldown claim and live reconciliation respectively. Copies here
    // could not see other windows, so they would pass while the real check
    // refused — a fee decision must have exactly one authority.
    const inputKeys = Object.keys(ready);
    expect(inputKeys).not.toContain('busy');
    expect(inputKeys).not.toContain('lastAttemptMs');
    expect(inputKeys).not.toContain('eligibleCoinCount');
  });
});

describe('auto rendezvous slots', () => {
  it('is open at the start of each period', () => {
    const t0 = 1_700_000_000_000; // aligned
    const slot0 = t0 - (t0 % AUTO_RENDEZVOUS_PERIOD_MS);
    expect(isAutoRendezvousOpen(slot0)).toBe(true);
    expect(msUntilAutoRendezvousOpen(slot0)).toBe(0);
    expect(isAutoRendezvousOpen(slot0 + AUTO_RENDEZVOUS_OPEN_MS - 1)).toBe(
      true
    );
    expect(isAutoRendezvousOpen(slot0 + AUTO_RENDEZVOUS_OPEN_MS)).toBe(false);
    expect(msUntilAutoRendezvousOpen(slot0 + AUTO_RENDEZVOUS_OPEN_MS)).toBe(
      AUTO_RENDEZVOUS_PERIOD_MS - AUTO_RENDEZVOUS_OPEN_MS
    );
  });

  it('next tick is finite and positive', () => {
    const n = nextAutoEngineTickMs(Date.now());
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(AUTO_RENDEZVOUS_PERIOD_MS + 20_000);
  });
});

describe('server Auto scheduling (Electron Cash compatible)', () => {
  it('enters JoinPools immediately instead of waiting for a client UTC slot', () => {
    for (const now of [0, 1, 74_999, 75_000, 1_700_000_000_000]) {
      expect(msUntilServerAutoStart(now)).toBe(0);
    }
  });

  it('uses Electron Cash plugin cadence for the recovery poll', () => {
    expect(SERVER_AUTO_POLL_MS).toBe(5_000);
    for (let i = 0; i < 20; i++) {
      const n = nextServerAutoEngineTickMs(Date.now() + i * 1000);
      expect(n).toBe(SERVER_AUTO_POLL_MS);
    }
  });

  it('mode helper routes server vs p2p', () => {
    const server = nextAutoEngineTickForMode('server');
    expect(server).toBe(SERVER_AUTO_POLL_MS);
    const p2p = nextAutoEngineTickForMode('p2p');
    expect(p2p).toBeGreaterThan(0);
    expect(p2p).toBeLessThan(AUTO_RENDEZVOUS_PERIOD_MS + 20_000);
  });

  it('classifies connect-refused and empty pool as transient (short retry)', () => {
    expect(
      isAutoTransientFailure(
        'could not connect to 127.0.0.1:8787: ... actively refused it. (os error 10061)'
      )
    ).toBe(true);
    expect(
      isAutoTransientFailure(
        'no other players joined in time (best tier 15000000 sats had 1/2 players); registered 5 tier(s)'
      )
    ).toBe(true);
    expect(
      isAutoTransientFailure(
        'receive failed: An established connection was aborted ... (os error 10053)'
      )
    ).toBe(true);
    expect(isAutoTransientFailure('too few remaining live players')).toBe(true);
    expect(
      isAutoTransientFailure('Selected inputs cannot afford any fusion tier.')
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import reducer, {
  normalizeExperimentalPersistedState,
  selectAutoFuseEnabled,
  selectP2pFusionEnabled,
  setAutoFuseEnabled,
  setCashFusionEnabled,
  setP2pFusionEnabled,
} from '../../state/slices/experimentalSlice';

describe('experimentalSlice CashFusion preferences', () => {
  it('defaults automatic Fusion off and P2P Fusion on', () => {
    const state = reducer(undefined, { type: 'unknown' });

    expect(state.autoFuseEnabled).toBe(false);
    expect(state.p2pFusionEnabled).toBe(true);
    expect(selectAutoFuseEnabled({ experimental: state } as never)).toBe(false);
    expect(selectP2pFusionEnabled({ experimental: state } as never)).toBe(true);
  });

  it('preserves an explicit Auto Fuse choice when CashFusion is later re-enabled', () => {
    let state = reducer(undefined, setAutoFuseEnabled(false));
    state = reducer(state, setCashFusionEnabled(true));

    expect(state.cashFusionEnabled).toBe(true);
    expect(state.autoFuseEnabled).toBe(false);
  });

  it('stores the P2P Fusion preference independently', () => {
    const state = reducer(undefined, setP2pFusionEnabled(true));

    expect(state.p2pFusionEnabled).toBe(true);
    expect(selectP2pFusionEnabled({ experimental: state } as never)).toBe(true);
  });

  it('adds safe defaults when restoring settings saved before these controls existed', () => {
    const restored = normalizeExperimentalPersistedState({
      cashFusionEnabled: true,
      fusionServer: 'fusion.example:8789',
    });

    expect(restored).toMatchObject({
      cashFusionEnabled: true,
      autoFuseEnabled: false,
      p2pFusionEnabled: true,
    });
  });

  it('does not overwrite saved choices during persisted-state normalization', () => {
    const restored = normalizeExperimentalPersistedState({
      autoFuseEnabled: false,
      p2pFusionEnabled: false,
    });

    expect(restored).toMatchObject({
      autoFuseEnabled: false,
      p2pFusionEnabled: false,
    });
  });

  it('strips leftover protocol knobs from persisted experimental state', () => {
    const restored = normalizeExperimentalPersistedState({
      cashFusionEnabled: true,
      p2pKnobs: { minPlayers: 4, maxPlayers: 8 },
    });

    expect(restored).toMatchObject({ cashFusionEnabled: true });
    expect(restored).not.toHaveProperty('p2pKnobs');
  });
});

describe('retired Nostr chat switch', () => {
  it('does not maintain a separate chat enable flag', () => {
    const state = reducer(undefined, { type: 'unknown' });
    expect(state).not.toHaveProperty('nostrChatEnabled');
  });

  it.each([false, true])(
    'removes the retired flag after prior migration=%s without resetting unrelated choices',
    (migrated) => {
      const restored = normalizeExperimentalPersistedState({
        nostrChatEnabled: false,
        nostrChatDefaultOnApplied: migrated,
        cashFusionEnabled: false,
        torEnabled: true,
        nostrRelays: ['wss://relay.user.example'],
      });
      expect(restored).not.toHaveProperty('nostrChatEnabled');
      expect(restored).not.toHaveProperty('nostrChatDefaultOnApplied');
      expect(restored).toMatchObject({
        cashFusionEnabled: false,
        torEnabled: true,
      });
      expect(restored?.nostrRelays).toContain('wss://relay.user.example');
    }
  );
});

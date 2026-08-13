import { describe, expect, it } from 'vitest';

import reducer, {
  normalizeExperimentalPersistedState,
  selectAutoFuseEnabled,
  selectNostrChatEnabled,
  selectP2pFusionEnabled,
  setAutoFuseEnabled,
  setCashFusionEnabled,
  setNostrChatEnabled,
  setP2pFusionEnabled,
} from '../../state/slices/experimentalSlice';

describe('experimentalSlice CashFusion preferences', () => {
  it('defaults Auto Fuse on and P2P Fusion off', () => {
    const state = reducer(undefined, { type: 'unknown' });

    expect(state.autoFuseEnabled).toBe(true);
    expect(state.p2pFusionEnabled).toBe(true);
    expect(selectAutoFuseEnabled({ experimental: state } as never)).toBe(true);
    expect(selectP2pFusionEnabled({ experimental: state } as never)).toBe(
      true
    );
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
      autoFuseEnabled: true,
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
});

describe('experimentalSlice Nostr chat preferences', () => {
  it('defaults Nostr chat on', () => {
    const state = reducer(undefined, { type: 'unknown' });

    expect(state.nostrChatEnabled).toBe(true);
    expect(selectNostrChatEnabled({ experimental: state } as never)).toBe(true);
  });

  it('migrates the old default-off value to on exactly once', () => {
    const restored = normalizeExperimentalPersistedState({
      nostrChatEnabled: false,
    });

    expect(restored).toMatchObject({
      nostrChatEnabled: true,
      nostrChatDefaultOnApplied: true,
    });
  });

  it('preserves a later explicit opt-out after the default-on migration', () => {
    let state = reducer(undefined, setNostrChatEnabled(false));
    state = {
      ...state,
      nostrChatDefaultOnApplied: true,
    };

    const restored = normalizeExperimentalPersistedState(state);

    expect(restored).toMatchObject({
      nostrChatEnabled: false,
      nostrChatDefaultOnApplied: true,
    });
  });
});

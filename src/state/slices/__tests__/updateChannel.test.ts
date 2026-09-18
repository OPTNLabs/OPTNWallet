/**
 * The update opt-ins default to off, and stay off across an upgrade.
 *
 * The failure this guards is quiet and bad: a holder who never asked for
 * pre-release builds being shown one because a new field defaulted to true, or
 * because state persisted before the field existed read as `undefined` and
 * something treated that as opted-in.
 */

import { describe, expect, it } from 'vitest';
import reducer, {
  selectUpdateAlpha,
  selectUpdateBeta,
  setUpdateAlpha,
  setUpdateBeta,
} from '../preferencesSlice';
import type { RootState } from '../../store';

const stateOf = (preferences: Record<string, unknown>) =>
  ({ preferences }) as unknown as RootState;

describe('desktop update channels', () => {
  it('is stable-only until asked otherwise', () => {
    const fresh = reducer(undefined, { type: '@@INIT' });
    expect(fresh.updateBeta).toBe(false);
    expect(fresh.updateAlpha).toBe(false);
  });

  it('reads state written before these fields existed as opted out', () => {
    // redux-persist merges the slice, so a missing field normally keeps the
    // initial value -- but the selector must not depend on that, because
    // `undefined` reaching a checkbox as `true` would opt someone in silently.
    const legacy = stateOf({ locale: 'en' });
    expect(selectUpdateBeta(legacy)).toBe(false);
    expect(selectUpdateAlpha(legacy)).toBe(false);
  });

  it('records each opt-in independently', () => {
    let state = reducer(undefined, setUpdateBeta(true));
    expect(state.updateBeta).toBe(true);
    expect(state.updateAlpha).toBe(false);

    state = reducer(state, setUpdateAlpha(true));
    expect(state.updateBeta).toBe(true);
    expect(state.updateAlpha).toBe(true);

    // And turning one back off does not disturb the other.
    state = reducer(state, setUpdateBeta(false));
    expect(state.updateBeta).toBe(false);
    expect(state.updateAlpha).toBe(true);
  });

  it('survives a round trip through the selectors', () => {
    const state = reducer(
      reducer(undefined, setUpdateBeta(true)),
      setUpdateAlpha(false)
    );
    const root = stateOf(state as unknown as Record<string, unknown>);
    expect(selectUpdateBeta(root)).toBe(true);
    expect(selectUpdateAlpha(root)).toBe(false);
  });
});

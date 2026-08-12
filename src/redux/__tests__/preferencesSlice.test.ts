import { describe, expect, it } from 'vitest';

import reducer, {
  selectTooltipsEnabled,
  setEnableTooltips,
  toggleEnableTooltips,
} from '../preferencesSlice';

describe('preferencesSlice', () => {
  it('defaults tooltips to disabled', () => {
    const state = reducer(undefined, { type: 'unknown' });

    expect(state.enableTooltips).toBe(false);
    expect(selectTooltipsEnabled({ preferences: state } as never)).toBe(false);
  });

  it('toggles tooltip visibility', () => {
    const state = reducer(undefined, toggleEnableTooltips());

    expect(state.enableTooltips).toBe(true);
  });

  it('sets tooltip visibility explicitly', () => {
    const state = reducer(undefined, setEnableTooltips(false));

    expect(state.enableTooltips).toBe(false);
  });
});

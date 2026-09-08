import { describe, expect, it } from 'vitest';

import reducer, {
  DEFAULT_MERCHANT_PAY_CONVERSION_BPS,
  selectMerchantPayDefaultConversionBps,
  selectTooltipsEnabled,
  setEnableTooltips,
  setMerchantPayDefaultConversionBps,
  toggleEnableTooltips,
} from '../../state/slices/preferencesSlice';

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

  it('defaults Merchant Pay conversion to 100 percent', () => {
    const state = reducer(undefined, { type: 'unknown' });

    expect(state.merchantPayDefaultConversionBps).toBe(
      DEFAULT_MERCHANT_PAY_CONVERSION_BPS
    );
    expect(
      selectMerchantPayDefaultConversionBps({ preferences: state } as never)
    ).toBe(10_000);
  });

  it('clamps Merchant Pay conversion to whole basis points from 0 to 100 percent', () => {
    const rounded = reducer(
      undefined,
      setMerchantPayDefaultConversionBps(1234.6)
    );
    expect(rounded.merchantPayDefaultConversionBps).toBe(1235);

    const minimum = reducer(undefined, setMerchantPayDefaultConversionBps(-1));
    expect(minimum.merchantPayDefaultConversionBps).toBe(0);

    const maximum = reducer(
      undefined,
      setMerchantPayDefaultConversionBps(10_001)
    );
    expect(maximum.merchantPayDefaultConversionBps).toBe(10_000);
  });
});

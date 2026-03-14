import { describe, expect, it } from 'vitest';
import {
  ADDON_SDK_VERSION,
  getAddonSDKInfo,
  ADDON_SDK_FEATURES,
} from '../SDKContract';

describe('SDKContract', () => {
  it('returns consistent SDK metadata', () => {
    const info = getAddonSDKInfo(['tx:build']);
    expect(info.version).toBe(ADDON_SDK_VERSION);
    expect(info.methods).toBe(ADDON_SDK_FEATURES);
    expect(info.modules.length).toBeGreaterThan(0);
    expect(info.capabilities).toEqual(['tx:build']);
    expect(info.methods.signing).toContain('signMessage');
  });
});

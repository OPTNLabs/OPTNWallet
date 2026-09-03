import { afterEach, describe, expect, it, vi } from 'vitest';

const { isNativePlatformMock, getPlatformMock } = vi.hoisted(() => ({
  isNativePlatformMock: vi.fn(() => false),
  getPlatformMock: vi.fn(() => 'web'),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: isNativePlatformMock,
    getPlatform: getPlatformMock,
  },
}));

import {
  CAPABILITIES,
  capabilityAbsence,
  currentSurface,
  hasCapability,
  offersWatchOnly,
  type Capability,
  type Surface,
} from '../capabilities';

const APP_SURFACES: Surface[] = [
  'desktop',
  'android',
  'ios',
  'web',
  'extension',
];

const DESKTOP_ONLY: Capability[] = [
  'hardwareWallet',
  'keystone',
  'cashFusion',
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  isNativePlatformMock.mockReturnValue(false);
  getPlatformMock.mockReturnValue('web');
});

describe('cross-platform capability contract', () => {
  it('uses the mobile build stamp before WebView runtime heuristics', () => {
    vi.stubEnv('VITE_APP_SURFACE', 'android');
    expect(currentSurface()).toBe('android');
    expect(hasCapability('watchOnlyWallet')).toBe(true);

    vi.stubEnv('VITE_APP_SURFACE', 'ios');
    expect(currentSurface()).toBe('ios');
    expect(hasCapability('watchOnlyWallet')).toBe(true);
  });

  it('keeps each platform decision as a single explicit boolean toggle', () => {
    expect(CAPABILITIES.cashFusion.enabledOn).toEqual({
      desktop: true,
      android: false,
      ios: false,
      web: false,
      extension: false,
    });
    expect(CAPABILITIES.reusablePaymentAddresses.enabledOn).toEqual({
      desktop: true,
      android: true,
      ios: true,
      web: true,
      extension: true,
    });
  });

  it('keeps desktop-only wallet features off non-desktop surfaces', () => {
    for (const capability of DESKTOP_ONLY) {
      expect(hasCapability(capability, 'desktop')).toBe(true);
      for (const surface of APP_SURFACES.filter(
        (candidate) => candidate !== 'desktop'
      )) {
        expect(hasCapability(capability, surface)).toBe(false);
      }
    }
  });

  it('does not classify a native shell as web when the bridge reports web', () => {
    vi.unstubAllEnvs();
    isNativePlatformMock.mockReturnValue(true);
    getPlatformMock.mockReturnValue('web');
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36',
    });

    expect(currentSurface()).toBe('android');
    expect(offersWatchOnly()).toBe(true);
    expect(hasCapability('watchOnlyWallet')).toBe(true);
  });

  it('classifies a Tauri Android WebView as android, not desktop or web', () => {
    vi.unstubAllEnvs();
    isNativePlatformMock.mockReturnValue(false);
    getPlatformMock.mockReturnValue('web');
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36',
    });

    expect(currentSurface()).toBe('android');
    expect(offersWatchOnly()).toBe(true);
    expect(hasCapability('hardwareWallet')).toBe(false);
  });

  it('keeps watch-only on native product surfaces only', () => {
    expect(CAPABILITIES.watchOnlyWallet.enabledOn).toEqual({
      desktop: true,
      android: true,
      ios: true,
      web: false,
      extension: false,
    });
    for (const surface of ['desktop', 'android', 'ios'] as const) {
      expect(hasCapability('watchOnlyWallet', surface)).toBe(true);
    }
    for (const surface of ['web', 'extension'] as const) {
      expect(hasCapability('watchOnlyWallet', surface)).toBe(false);
    }
  });

  it('keeps the shared Rust RPA implementation available on every app surface', () => {
    for (const surface of APP_SURFACES) {
      expect(hasCapability('reusablePaymentAddresses', surface)).toBe(true);
    }
  });

  it('hides CashFusion where unavailable and explains requested wallet types', () => {
    expect(capabilityAbsence('cashFusion', 'android')).toEqual({
      policy: 'hide',
    });
    expect(capabilityAbsence('hardwareWallet', 'ios')).toEqual({
      policy: 'explain',
    });
    expect(capabilityAbsence('cashFusion', 'desktop')).toBeNull();
    expect(hasCapability('hardwareWallet', 'desktop')).toBe(true);
    expect(hasCapability('hardwareWallet', 'android')).toBe(false);
    expect(hasCapability('cashFusion', 'desktop')).toBe(true);
    expect(hasCapability('cashFusion', 'android')).toBe(false);
  });

  it('declares only known surfaces and never declares a dead capability', () => {
    for (const spec of Object.values(CAPABILITIES)) {
      expect(Object.keys(spec.enabledOn).sort()).toEqual(
        [...APP_SURFACES].sort()
      );
      expect(Object.values(spec.enabledOn)).toContain(true);
    }
  });
});

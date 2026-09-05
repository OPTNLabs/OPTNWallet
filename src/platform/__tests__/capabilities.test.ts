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
  setCapabilityOverride,
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

// CashFusion alone. It needs a long-lived background process no other shell
// has, which is a fact about the shell rather than work left undone.
const DESKTOP_ONLY: Capability[] = ['cashFusion'];

// Hardware and Keystone follow the integrations: a browser drives a Ledger
// over WebHID, a OneKey through its own web SDK, and a Keystone by camera.
// The phones wait on a native plugin.
const DEVICE_SURFACES: Capability[] = ['hardwareWallet', 'keystone'];

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

  it('offers devices wherever an integration exists, phones excepted', () => {
    for (const capability of DEVICE_SURFACES) {
      for (const surface of ['desktop', 'web', 'extension'] as const) {
        expect(hasCapability(capability, surface)).toBe(true);
      }
      for (const surface of ['android', 'ios'] as const) {
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

  it('offers watch-only on every surface, hardware only where integrated', () => {
    // Watch-only needs no transport -- an account xPub can be pasted -- so a
    // popup with no camera and no USB can still watch a cold wallet. Hardware
    // is the one that varies, and only because the vendor integrations do not
    // exist off desktop yet.
    expect(CAPABILITIES.watchOnlyWallet.enabledOn).toEqual({
      desktop: true,
      android: true,
      ios: true,
      web: true,
      extension: true,
    });
    for (const surface of APP_SURFACES) {
      expect(hasCapability('watchOnlyWallet', surface)).toBe(true);
      expect(hasCapability('hardwareWallet', surface)).toBe(
        surface !== 'android' && surface !== 'ios'
      );
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

  it('hides hardware on a phone rather than forbidding it', () => {
    // What ships. Nothing on screen, because the default is off -- no native
    // plugin exists for the cabled devices yet.
    expect(hasCapability('hardwareWallet', 'android')).toBe(false);
    expect(hasCapability('hardwareWallet', 'ios')).toBe(false);

    // Switching it on is a real toggle. The table value is a default, so an
    // explicit choice wins over it and the section becomes reachable.
    setCapabilityOverride('hardwareWallet', true);
    expect(hasCapability('hardwareWallet', 'android')).toBe(true);
    expect(hasCapability('hardwareWallet', 'ios')).toBe(true);
    expect(capabilityAbsence('hardwareWallet', 'android')).toBeNull();

    // And it goes back. `null` is "use the default", not "off".
    setCapabilityOverride('hardwareWallet', null);
    expect(hasCapability('hardwareWallet', 'android')).toBe(false);
  });

  it('does not let the override reach a capability that is a veto', () => {
    // CashFusion needs a long-lived background process a phone shell does not
    // have, so turning it on could not make it work. Watch Only is already on
    // everywhere and has nothing hidden to reveal. Neither is overridable, and
    // asking anyway must not change what the app reports.
    setCapabilityOverride('cashFusion', true);
    setCapabilityOverride('watchOnlyWallet', false);
    expect(hasCapability('cashFusion', 'android')).toBe(false);
    expect(hasCapability('watchOnlyWallet', 'android')).toBe(true);
  });

  it('treats unreadable storage as no override rather than throwing', () => {
    // A private window, an extension worker, or a browser set to block site
    // data makes this throw outright. A capability check that throws would
    // take the landing page with it.
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('site data blocked');
      },
    });
    try {
      expect(hasCapability('hardwareWallet', 'desktop')).toBe(true);
      expect(hasCapability('hardwareWallet', 'android')).toBe(false);
      expect(() => setCapabilityOverride('hardwareWallet', true)).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
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

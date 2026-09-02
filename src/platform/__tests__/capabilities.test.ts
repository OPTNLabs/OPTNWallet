import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITIES,
  capabilityAbsence,
  currentSurface,
  hasCapability,
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

  it('enables watch-only wallets on native mobile without enabling web/extension', () => {
    expect(CAPABILITIES.watchOnlyWallet.enabledOn).toEqual({
      desktop: true,
      android: true,
      ios: true,
      web: false,
      extension: false,
    });
    expect(hasCapability('watchOnlyWallet', 'android')).toBe(true);
    expect(hasCapability('watchOnlyWallet', 'ios')).toBe(true);
    expect(hasCapability('watchOnlyWallet', 'web')).toBe(false);
    expect(hasCapability('watchOnlyWallet', 'extension')).toBe(false);
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

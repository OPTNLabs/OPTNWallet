import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  capabilityAbsence,
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

describe('cross-platform capability contract', () => {
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

  it('enables watch-only wallets on every app surface', () => {
    expect(CAPABILITIES.watchOnlyWallet.enabledOn).toEqual({
      desktop: true,
      android: true,
      ios: true,
      web: true,
      extension: true,
    });
    for (const surface of APP_SURFACES) {
      expect(hasCapability('watchOnlyWallet', surface)).toBe(true);
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

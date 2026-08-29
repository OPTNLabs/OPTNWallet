import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  capabilityAbsence,
  hasCapability,
  type Capability,
  type Surface,
} from '../capabilities';
import { translations } from '../../i18n/resources';

const ALL_SURFACES: Surface[] = [
  'desktop',
  'android',
  'ios',
  'web',
  'extension',
];

const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

describe('capability matrix', () => {
  it('answers per surface rather than per call site', () => {
    expect(hasCapability('watchOnlyWallet', 'desktop')).toBe(true);
    expect(hasCapability('watchOnlyWallet', 'android')).toBe(false);
    expect(hasCapability('watchOnlyWallet', 'ios')).toBe(false);
  });

  it('reports nothing to explain where the capability is present', () => {
    expect(capabilityAbsence('watchOnlyWallet', 'desktop')).toBeNull();
    expect(capabilityAbsence('cashFusion', 'desktop')).toBeNull();
  });

  it('explains what a user would go looking for and hides what they would not', () => {
    // Watch-only was reported as missing from a build that simply did not
    // offer it, so its absence has to be stated rather than left silent.
    expect(capabilityAbsence('watchOnlyWallet', 'android')).toEqual({
      policy: 'explain',
      reasonKey: 'onboarding.optionDesktopOnly',
    });
    expect(capabilityAbsence('hardwareWallet', 'android')?.policy).toBe(
      'explain'
    );
    expect(capabilityAbsence('keystone', 'android')?.policy).toBe('explain');

    // Nothing is gained by advertising CashFusion on a phone that cannot run it.
    expect(capabilityAbsence('cashFusion', 'android')?.policy).toBe('hide');
  });

  it('keeps the shared-core capability available on every surface', () => {
    // Reusable payment addresses are implemented once in crates/optn-core and
    // reach the CLI natively and every app surface through wasm. If this ever
    // narrows, the sharing has regressed and a port has crept back in.
    for (const surface of ALL_SURFACES) {
      expect(hasCapability('reusablePaymentAddresses', surface)).toBe(true);
    }
  });

  it('names a real translation key for every reason', () => {
    // The key is typed, so this catches the remaining gap: a key that exists in
    // the type but was never given English text.
    for (const capability of ALL_CAPABILITIES) {
      const key = CAPABILITIES[capability].absenceReasonKey;
      expect(translations.en[key]).toBeTruthy();
    }
  });

  it('declares at least one surface for every capability', () => {
    // A capability available nowhere is dead configuration; it would render as
    // a permanently inert row that no edit here could ever turn on.
    for (const capability of ALL_CAPABILITIES) {
      expect(CAPABILITIES[capability].surfaces.length).toBeGreaterThan(0);
    }
  });

  it('only uses surfaces the resolver can actually return', () => {
    for (const capability of ALL_CAPABILITIES) {
      for (const surface of CAPABILITIES[capability].surfaces) {
        expect(ALL_SURFACES).toContain(surface);
      }
    }
  });
});

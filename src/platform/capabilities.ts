// One declaration of which features exist on which surface.
//
// Before this, every screen answered that question for itself with an inline
// isDesktopPlatform() call, so "is CashFusion available here" had as many
// answers as it had call sites and nothing kept them in agreement. Giving a
// feature mobile support meant finding every place it had been gated, and
// missing one showed up as a button that navigates nowhere.
//
// The matrix below is the single answer. It is plain data, so the UI renders
// from it, tests read it, and a build step can assert against it -- the same
// move that crates/optn-core made for protocol code, applied to availability.
import { Capacitor } from '@capacitor/core';
import { isDesktopPlatform } from '../utils/platform';
import type { TranslationKey } from '../i18n/resources';

export type Surface = 'desktop' | 'android' | 'ios' | 'web' | 'extension';

export type Capability =
  | 'watchOnlyWallet'
  | 'hardwareWallet'
  | 'keystone'
  | 'cashFusion'
  | 'reusablePaymentAddresses';

/**
 * What a surface does with a capability it does not have.
 *
 * `explain` keeps the entry visible but inert, carrying the reason. Use it for
 * things a user has reason to go looking for: silence there reads as a broken
 * build, which is exactly what was reported against the old landing page.
 *
 * `hide` removes the entry. Use it where absence raises no question -- there is
 * no point advertising CashFusion on a phone that cannot run it.
 */
export type AbsencePolicy = 'explain' | 'hide';

export type CapabilitySpec = {
  readonly surfaces: readonly Surface[];
  readonly whenAbsent: AbsencePolicy;
  /** i18n key for the reason. Resolved by the caller, which holds `t`. */
  readonly absenceReasonKey: TranslationKey;
};

export const CAPABILITIES: Readonly<Record<Capability, CapabilitySpec>> = {
  // Portable in principle -- watchOnlyWallet.ts and keystoneAccount.ts touch no
  // native API, and WatchOnlySend already runs everywhere. What is desktop-only
  // is *creating* one: the flow statically imports @tauri-apps/api and protects
  // the wallet with a Tauri biometry plugin. Explained rather than hidden
  // because users do come looking for it.
  watchOnlyWallet: {
    surfaces: ['desktop'],
    whenAbsent: 'explain',
    absenceReasonKey: 'onboarding.optionDesktopOnly',
  },
  hardwareWallet: {
    surfaces: ['desktop'],
    whenAbsent: 'explain',
    absenceReasonKey: 'onboarding.optionDesktopOnly',
  },
  // Reached through the watch-only flow, so it inherits that flow's surface.
  // Listed in its own right so it can move independently later.
  keystone: {
    surfaces: ['desktop'],
    whenAbsent: 'explain',
    absenceReasonKey: 'onboarding.optionDesktopOnly',
  },
  cashFusion: {
    surfaces: ['desktop'],
    whenAbsent: 'hide',
    absenceReasonKey: 'onboarding.optionDesktopOnly',
  },
  // Everywhere, and not by coincidence: this one is implemented once in
  // crates/optn-core and reaches the CLI natively and every app surface through
  // wasm. It is the shape the rows above are meant to grow into.
  reusablePaymentAddresses: {
    surfaces: ['desktop', 'android', 'ios', 'web', 'extension'],
    whenAbsent: 'hide',
    absenceReasonKey: 'onboarding.optionDesktopOnly',
  },
};

/** MV3 gives extension pages a `chrome.runtime.id`; ordinary web pages have none. */
function isExtensionRuntime(): boolean {
  const runtime = (
    globalThis as unknown as { chrome?: { runtime?: { id?: string } } }
  ).chrome?.runtime;
  return typeof runtime?.id === 'string' && runtime.id.length > 0;
}

export function currentSurface(): Surface {
  // Checked before Capacitor: the desktop build reports 'web' from
  // Capacitor.getPlatform(), so asking Capacitor first would call it a browser.
  if (isDesktopPlatform()) return 'desktop';
  const platform = Capacitor.getPlatform();
  if (platform === 'android') return 'android';
  if (platform === 'ios') return 'ios';
  if (isExtensionRuntime()) return 'extension';
  return 'web';
}

export function hasCapability(
  capability: Capability,
  surface: Surface = currentSurface()
): boolean {
  return CAPABILITIES[capability].surfaces.includes(surface);
}

/**
 * How to present a capability the current surface lacks, or `null` when it has
 * it. Callers render the reason; they do not decide the policy.
 */
export function capabilityAbsence(
  capability: Capability,
  surface: Surface = currentSurface()
): { policy: AbsencePolicy; reasonKey: TranslationKey } | null {
  if (hasCapability(capability, surface)) return null;
  const spec = CAPABILITIES[capability];
  return { policy: spec.whenAbsent, reasonKey: spec.absenceReasonKey };
}

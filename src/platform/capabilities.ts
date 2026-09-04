import { Capacitor } from '@capacitor/core';
import { isDesktopPlatform } from '../utils/platform';

export type Surface = 'desktop' | 'android' | 'ios' | 'web' | 'extension';

export type Capability =
  | 'watchOnlyWallet'
  | 'hardwareWallet'
  | 'keystone'
  | 'cashFusion'
  | 'reusablePaymentAddresses';

export type AbsencePolicy = 'explain' | 'hide';

export type CapabilitySpec = {
  /** One reviewed switch per build surface. */
  readonly enabledOn: Readonly<Record<Surface, boolean>>;
  readonly whenAbsent: AbsencePolicy;
};

export const CAPABILITIES: Readonly<Record<Capability, CapabilitySpec>> = {
  // Watch Only is the door an air-gapped device comes through, and unlike
  // hardware it needs no transport at all: an account xPub can be pasted. A
  // popup with no camera and no USB can still watch a cold wallet, which is
  // exactly the extension's case. So it is on everywhere, and this table is
  // how a platform turns it off rather than how it earns it.
  watchOnlyWallet: {
    enabledOn: {
      desktop: true,
      android: true,
      ios: true,
      web: true,
      extension: true,
    },
    whenAbsent: 'explain',
  },
  // Hardware follows the integrations, not the shell. A browser tab and an
  // extension popup can each drive three of the five devices today: a Ledger
  // over WebHID, a OneKey through its own web SDK, and a Keystone by camera.
  // The extension is where people reach for a hardware wallet, so leaving it
  // off there was the wrong default for a wallet meant to stand in for
  // MetaMask on Bitcoin Cash.
  //
  // The phones stay off because no native plugin exists yet -- not because a
  // phone cannot reach a device. Android holds a cable, both have radios and
  // NFC, and a Tangem is a phone-only device.
  hardwareWallet: {
    enabledOn: {
      desktop: true,
      android: false,
      ios: false,
      web: true,
      extension: true,
    },
    whenAbsent: 'explain',
  },
  // Keystone needs no vendor library, no cable and no driver -- only a
  // camera -- so it reaches every surface that offers hardware at all. It is
  // the device MetaMask's extension connects by scanning animated QR.
  keystone: {
    enabledOn: {
      desktop: true,
      android: false,
      ios: false,
      web: true,
      extension: true,
    },
    whenAbsent: 'explain',
  },
  cashFusion: {
    enabledOn: {
      desktop: true,
      android: false,
      ios: false,
      web: false,
      extension: false,
    },
    whenAbsent: 'hide',
  },
  reusablePaymentAddresses: {
    enabledOn: {
      desktop: true,
      android: true,
      ios: true,
      web: true,
      extension: true,
    },
    whenAbsent: 'hide',
  },
};

function isExtensionRuntime(): boolean {
  const runtime = (
    globalThis as unknown as { chrome?: { runtime?: { id?: string } } }
  ).chrome?.runtime;
  return typeof runtime?.id === 'string' && runtime.id.length > 0;
}

function buildSurface(): Surface | null {
  const configured = import.meta.env.VITE_APP_SURFACE;
  return configured === 'desktop' ||
    configured === 'android' ||
    configured === 'ios' ||
    configured === 'web' ||
    configured === 'extension'
    ? configured
    : null;
}

function userAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

function surfaceFromUserAgent(): Surface | null {
  const ua = userAgent();
  if (/android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return null;
}

export function currentSurface(): Surface {
  // Native release builds stamp the intended surface. This is authoritative:
  // capability gating must not depend on WebView bridge timing at first render.
  const configured = buildSurface();
  if (configured) return configured;

  // Named Capacitor platforms first. An Android/iOS WebView must never be
  // classified as web — that hides Watch Only on the landing.
  const platform = Capacitor.getPlatform();
  if (platform === 'android' || platform === 'ios') return platform;

  if (Capacitor.isNativePlatform()) {
    return surfaceFromUserAgent() ?? 'android';
  }

  // Tauri mobile WebViews inject the same internals as desktop. Classify them
  // as Android/iOS so Watch Only stays on the landing and USB hardware stays off.
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const tauriMobile = surfaceFromUserAgent();
    if (tauriMobile) return tauriMobile;
  }

  if (isExtensionRuntime()) return 'extension';
  if (isDesktopPlatform()) return 'desktop';
  return 'web';
}

/** Matches `FeatureFlags::enabled(..., FeatureFlag::WatchOnly)`. */
export function offersWatchOnly(surface: Surface = currentSurface()): boolean {
  return hasCapability('watchOnlyWallet', surface);
}

export function hasCapability(
  capability: Capability,
  surface: Surface = currentSurface()
): boolean {
  return CAPABILITIES[capability].enabledOn[surface];
}

export function capabilityAbsence(
  capability: Capability,
  surface: Surface = currentSurface()
): { policy: AbsencePolicy } | null {
  if (hasCapability(capability, surface)) return null;
  return { policy: CAPABILITIES[capability].whenAbsent };
}

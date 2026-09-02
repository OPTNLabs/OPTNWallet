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
  watchOnlyWallet: {
    enabledOn: {
      desktop: true,
      android: true,
      ios: true,
      web: false,
      extension: false,
    },
    whenAbsent: 'explain',
  },
  hardwareWallet: {
    enabledOn: {
      desktop: true,
      android: false,
      ios: false,
      web: false,
      extension: false,
    },
    whenAbsent: 'explain',
  },
  keystone: {
    enabledOn: {
      desktop: true,
      android: false,
      ios: false,
      web: false,
      extension: false,
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

export function currentSurface(): Surface {
  // Native release builds stamp the intended surface. This is authoritative:
  // capability gating must not depend on WebView bridge timing at first render.
  const configured = buildSurface();
  if (configured) return configured;

  // Runtime fallback for dev/tests and unstamped legacy builds. Check Capacitor
  // before Tauri so an Android/iOS WebView can never be promoted to desktop.
  const platform = Capacitor.getPlatform();
  if (platform === 'android') return 'android';
  if (platform === 'ios') return 'ios';
  if (isExtensionRuntime()) return 'extension';
  if (isDesktopPlatform()) return 'desktop';
  return 'web';
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

import type { AddonManifest } from '../../types/addons';

/**
 * The add-ons this app ships. Their namespace is reserved: nothing installed
 * may use it (see `refuseUntrustedClaims`). Kept here rather than read from
 * `src/addons/builtin`, which imports services that import this module.
 */
export const BUILTIN_ADDON_IDS: ReadonlySet<string> = new Set([
  'optn.builtin.demo',
  'optn.builtin.events',
  'optn.builtin.fundme',
]);
export const RESERVED_ADDON_ID_PREFIX = 'optn.builtin.';

export type HostTrustTier = 'internal' | 'restricted';

/**
 * How far the host trusts an add-on (#83). The host decides; a manifest only
 * claims. A manifest is written by the add-on's author, so honouring its
 * `trustTier` let a sideloaded add-on that said `internal` skip the launch
 * approval and the consent prompt for broadcasting and signing. Only what this
 * app ships is internal; everything installed is restricted, whatever it says.
 */
export function hostTrustTier(
  manifest: Pick<AddonManifest, 'id'>
): HostTrustTier {
  return BUILTIN_ADDON_IDS.has(manifest.id) ? 'internal' : 'restricted';
}

export function isBuiltinAddon(manifest: Pick<AddonManifest, 'id'>): boolean {
  return hostTrustTier(manifest) === 'internal';
}

/**
 * Refuse an installed manifest that takes a shipped add-on's identity or
 * claims a trust only the host grants. Throws with a reason for the holder.
 */
export function refuseUntrustedClaims(
  manifest: Pick<AddonManifest, 'id' | 'trustTier'>
): void {
  if (manifest.id.startsWith(RESERVED_ADDON_ID_PREFIX)) {
    throw new Error(
      `Add-on id "${manifest.id}" is reserved for add-ons shipped with OPTN Wallet.`
    );
  }
  if (manifest.trustTier === 'internal') {
    throw new Error(
      `Add-on "${manifest.id}" claims internal trust, which only the app can grant.`
    );
  }
}

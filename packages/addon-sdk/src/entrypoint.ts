import type { AddonManifest } from './types.js';
import type { AddonWalletClient } from './client.js';
import { validateAddonManifest } from './manifest.js';

export type AddonMountContext = {
  sdk: AddonWalletClient;
  manifest: AddonManifest;
  host: {
    network: string | null;
    /** Host-issued opaque session handle; never use it as a secret or authority by itself. */
    sessionId: string;
    /** ISO timestamp after which the host will reject this session. */
    sessionExpiresAt: string;
  };
};

export type AddonMountResult = {
  dispose?: () => void | Promise<void>;
  render?: (container: HTMLElement) => void | Promise<void>;
};

export type AddonEntrypoint = {
  manifest: AddonManifest;
  mount(
    context: AddonMountContext
  ): AddonMountResult | Promise<AddonMountResult>;
};

export function defineAddon<T extends AddonEntrypoint>(addon: T): T {
  validateAddonManifest(addon.manifest);
  return addon;
}

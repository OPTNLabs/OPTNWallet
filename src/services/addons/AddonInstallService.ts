// Default (mobile/web) implementation: installing third-party 'iframe-bundle'
// addons from disk is a desktop-only feature for now (no filesystem-drop UX
// equivalent on mobile). Desktop builds swap this file for
// src/platform/desktop/AddonInstallService.ts via vite.desktop.config.ts's
// module-swap plugin — same pattern already used for SecretCryptoService,
// DeviceIntegrityService, etc.

import type { AddonManifest } from '../../types/addons';

export interface InstalledAddonSummary {
  id: string;
  name: string;
  version: string;
}

export async function readAddonBundleSource(
  addonId: string,
  entryFile: string
): Promise<string> {
  void addonId;
  void entryFile;
  throw new Error('Installing addons from disk is only supported on desktop.');
}

export async function loadInstalledAddonManifests(): Promise<AddonManifest[]> {
  return [];
}

export async function listInstalledAddons(): Promise<InstalledAddonSummary[]> {
  return [];
}

export async function uninstallAddon(addonId: string): Promise<void> {
  void addonId;
  throw new Error('Installing addons from disk is only supported on desktop.');
}

export async function installAddonFromDirectory(): Promise<AddonManifest | null> {
  throw new Error('Installing addons from disk is only supported on desktop.');
}

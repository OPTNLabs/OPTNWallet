// Desktop implementation of installed-addon reading. Mirrors walletFile.ts's
// <AppData>/wallets/ pattern: installed addons live at
// <AppData>/addons/<addonId>/<entryFile as declared in the manifest>.
//
// Only reads bundle SOURCE TEXT here — it never executes anything itself.
// Execution happens exclusively inside the sandboxed iframe (see
// AddonIframeBridge.ts / public/addon-sandbox.html); this file's job ends at
// handing that iframe a string.

import {
  readTextFile,
  writeTextFile,
  readDir,
  mkdir,
  exists,
  remove,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { validateAddonManifestAgainstSchema } from '../../services/addons/AddonManifestSchema';
import type { AddonManifest } from '../../types/addons';

export const ADDONS_DIR = 'addons';

function safeAddonId(addonId: string): string {
  // Defense in depth: AddonsRegistry already validates entryFile has no ".."
  // or leading "/", but re-check the addonId segment here too, since this
  // function is the one place that actually touches the filesystem.
  if (!addonId || addonId.includes('..') || addonId.includes('/') || addonId.includes('\\')) {
    throw new Error(`Unsafe addon id: ${addonId}`);
  }
  return addonId;
}

function safeEntryFile(entryFile: string): string {
  if (!entryFile || entryFile.includes('..') || entryFile.startsWith('/') || entryFile.startsWith('\\')) {
    throw new Error(`Unsafe addon entry file path: ${entryFile}`);
  }
  return entryFile;
}

export async function readAddonBundleSource(
  addonId: string,
  entryFile: string
): Promise<string> {
  const id = safeAddonId(addonId);
  const file = safeEntryFile(entryFile);
  const rel = `${ADDONS_DIR}/${id}/${file}`;

  if (!(await exists(rel, { baseDir: BaseDirectory.AppData }))) {
    throw new Error(`Addon bundle not found: ${rel}`);
  }
  return readTextFile(rel, { baseDir: BaseDirectory.AppData });
}

export interface InstalledAddonSummary {
  id: string;
  name: string;
  version: string;
}

/** Full parsed manifests for every installed addon — used by AddonsRegistry. */
export async function loadInstalledAddonManifests(): Promise<AddonManifest[]> {
  if (!(await exists(ADDONS_DIR, { baseDir: BaseDirectory.AppData }))) return [];
  const entries = await readDir(ADDONS_DIR, { baseDir: BaseDirectory.AppData });
  const out: AddonManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    try {
      const manifestRel = `${ADDONS_DIR}/${entry.name}/manifest.json`;
      const raw = await readTextFile(manifestRel, { baseDir: BaseDirectory.AppData });
      out.push(JSON.parse(raw) as AddonManifest);
    } catch {
      // A folder without a valid manifest.json isn't a real installed addon; skip it.
    }
  }
  return out;
}

/** Lightweight id/name/version listing for the Settings UI. */
export async function listInstalledAddons(): Promise<InstalledAddonSummary[]> {
  const manifests = await loadInstalledAddonManifests();
  return manifests.map((m) => ({ id: m.id, name: m.name, version: m.version }));
}

export async function uninstallAddon(addonId: string): Promise<void> {
  const id = safeAddonId(addonId);
  const dir = `${ADDONS_DIR}/${id}`;
  if (await exists(dir, { baseDir: BaseDirectory.AppData })) {
    await remove(dir, { baseDir: BaseDirectory.AppData, recursive: true });
  }
}

/**
 * Prompts the user for a folder containing an addon's manifest.json + its
 * entry JS file, validates the manifest against the same schema the registry
 * enforces, and copies both into <AppData>/addons/<id>/. Returns the
 * installed manifest, or null if the user cancelled the dialog.
 *
 * This only ever copies TEXT files the manifest itself points to — nothing
 * here executes any of it. Execution happens exclusively inside the
 * sandboxed iframe once the addon is launched (see AddonIframeBridge.ts).
 */
export async function installAddonFromDirectory(): Promise<AddonManifest | null> {
  const pickedDir = await openDialog({ directory: true, title: 'Install Addon' });
  if (typeof pickedDir !== 'string') return null;

  const manifestPath = `${pickedDir}/manifest.json`;
  if (!(await exists(manifestPath))) {
    throw new Error('Selected folder has no manifest.json.');
  }

  const manifestRaw = await readTextFile(manifestPath);
  let manifest: AddonManifest;
  try {
    manifest = JSON.parse(manifestRaw) as AddonManifest;
  } catch {
    throw new Error('manifest.json is not valid JSON.');
  }

  const schemaErrors = validateAddonManifestAgainstSchema(manifest);
  if (schemaErrors.length) {
    throw new Error(`Invalid addon manifest: ${schemaErrors.join('; ')}`);
  }

  const iframeApps = (manifest.apps ?? []).filter((a) => a.kind === 'iframe-bundle');
  if (iframeApps.length === 0) {
    throw new Error('Manifest has no iframe-bundle app to install.');
  }
  for (const app of iframeApps) {
    if (!app.entryFile || app.entryFile.includes('..') || app.entryFile.startsWith('/')) {
      throw new Error(`App "${app.id}" has a missing or unsafe entryFile.`);
    }
  }

  const id = safeAddonId(manifest.id);
  const destDir = `${ADDONS_DIR}/${id}`;
  await mkdir(destDir, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(`${destDir}/manifest.json`, manifestRaw, {
    baseDir: BaseDirectory.AppData,
  });

  for (const app of iframeApps) {
    const entryFile = safeEntryFile(app.entryFile as string);
    const bundleSource = await readTextFile(`${pickedDir}/${entryFile}`);
    await writeTextFile(`${destDir}/${entryFile}`, bundleSource, {
      baseDir: BaseDirectory.AppData,
    });
  }

  return manifest;
}

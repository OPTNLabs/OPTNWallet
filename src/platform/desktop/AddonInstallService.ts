// Desktop implementation of installed-addon reading. Mirrors walletFile.ts's
// <AppData>/wallets/ pattern: installed addons live at
// <AppData>/addons/<addonId>/<entryFile as declared in the manifest>.
//
// Only reads bundle SOURCE TEXT here — it never executes anything itself.
// Execution happens exclusively inside the sandboxed iframe (see
// AddonIframeBridge.ts / public/addon-sandbox.html); this file's job ends at
// handing that iframe a string.

import { readTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';

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

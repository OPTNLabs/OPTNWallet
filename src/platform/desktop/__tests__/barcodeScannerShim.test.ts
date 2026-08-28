import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as shim from '../barcode-scanner';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..'
);

const sharedModule = readFileSync(
  resolve(repoRoot, 'src', 'utils', 'barcodeScanner.ts'),
  'utf8'
);
const desktopConfig = readFileSync(
  resolve(repoRoot, 'vite.desktop.config.ts'),
  'utf8'
);

/** Value and type imports the shared module takes from the plugin. */
function importedSymbols(): string[] {
  const block = sharedModule.match(
    /import\s*\{([\s\S]*?)\}\s*from\s*'@capacitor\/barcode-scanner';/
  );
  expect(block, 'shared module imports from @capacitor/barcode-scanner').not
    .toBeNull();
  return block![1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

describe('desktop barcode-scanner shim', () => {
  it('is what the desktop bundle resolves the plugin to', () => {
    // If this alias is dropped the test below stops meaning anything, because
    // desktop would then use the real plugin and the shim would be dead code.
    expect(desktopConfig).toContain(
      "'@capacitor/barcode-scanner': resolvePath(__dirname, 'src/platform/desktop/barcode-scanner.ts')"
    );
  });

  it('exports every symbol the shared module imports', () => {
    // The shared module is one code path for web, Android and desktop. A
    // symbol the real plugin exports and this shim does not fails the desktop
    // frontend bundle with MISSING_EXPORT — during a Tauri build, minutes in,
    // rather than here.
    const missing = importedSymbols().filter(
      (name) => !(name in shim) && !sourceDeclaresType(name)
    );
    expect(missing, `desktop shim is missing: ${missing.join(', ')}`).toEqual(
      []
    );
  });

  it('offers the same scanning-library values as the plugin', () => {
    // Values, not just the name: the shared module passes ZXING through to a
    // real Android plugin, and a shim that spelt it differently would send an
    // unknown backend name to the device.
    expect(shim.CapacitorBarcodeScannerAndroidScanningLibrary).toEqual({
      ZXING: 'zxing',
      MLKIT: 'mlkit',
    });
  });
});

/** Type-only exports are erased at runtime, so check the source for them. */
function sourceDeclaresType(name: string): boolean {
  const source = readFileSync(
    resolve(repoRoot, 'src', 'platform', 'desktop', 'barcode-scanner.ts'),
    'utf8'
  );
  // String.raw: in a plain template literal \s is just "s" and \b is a
  // backspace, so the pattern silently matches nothing.
  return new RegExp(String.raw`export\s+type\s+${name}\b`).test(source);
}

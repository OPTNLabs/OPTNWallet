import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'smoke-tor-artifact.mts'
  ),
  'utf8'
);

describe('smoke-tor-artifact', () => {
  it('resolves the AppImage before extraction changes the working directory', () => {
    expect(script).toContain('const appImagePath = resolve(appImage);');
    expect(script).toMatch(
      /execFileSync\(appImagePath, \['--appimage-extract'\], \{\s*cwd: extractionDirectory/
    );
  });
});

// Verify the Tor executable inside a built Linux AppImage, not only the
// repository staging directory. This catches missing resources, wrong ELF
// architecture, and unresolved shared libraries after bundling.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function findTor(root) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findTor(path);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === 'tor') {
      if (path.replaceAll('\\', '/').includes('/resources/tor/tor')) {
        return path;
      }
    }
  }
  return null;
}

function main() {
  const [appImage, target] = process.argv.slice(2);
  if (!appImage || !['linux-x86_64', 'linux-aarch64'].includes(target)) {
    throw new Error(
      'Usage: tsx scripts/smoke-tor-artifact.mts <AppImage> <linux-x86_64|linux-aarch64>'
    );
  }

  // Extraction runs with a temporary working directory. Resolve the artifact
  // first so a workflow-provided relative path still points at the built file.
  const appImagePath = resolve(appImage);
  const expectedArchitecture =
    target === 'linux-aarch64' ? /aarch64/ : /x86-64/;
  const appImageDescription = execFileSync('file', [appImagePath], {
    encoding: 'utf8',
  });
  if (!/AppImage|ELF/.test(appImageDescription)) {
    throw new Error(
      `Not a recognizable Linux AppImage: ${appImageDescription}`
    );
  }

  const extractionDirectory = mkdtempSync(join(tmpdir(), 'optn-tor-artifact-'));
  try {
    execFileSync(appImagePath, ['--appimage-extract'], {
      cwd: extractionDirectory,
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
      stdio: 'pipe',
    });
    const tor = findTor(join(extractionDirectory, 'squashfs-root'));
    if (!tor) {
      throw new Error('Packaged AppImage has no resources/tor/tor executable.');
    }

    const torDescription = execFileSync('file', [tor], { encoding: 'utf8' });
    if (!expectedArchitecture.test(torDescription)) {
      throw new Error(
        `Packaged Tor architecture does not match ${target}: ${torDescription}`
      );
    }

    const version = execFileSync(tor, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
    });
    if (!/Tor version\s+\d+\.\d+\.\d+/.test(version)) {
      throw new Error('Packaged Tor did not report a valid version.');
    }
    console.log(`[smoke-tor-artifact] ${version.split('\n')[0]}`);
  } finally {
    rmSync(extractionDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(
    '[smoke-tor-artifact] ERROR:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
}

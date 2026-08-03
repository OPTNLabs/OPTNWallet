// Fetch and stage the Tor Expert Bundle used by the Tauri desktop app.
//
// Usage:
//   node scripts/fetch-tor.mjs [target]
//
// target is one of windows-x86_64, macos-x86_64, macos-aarch64, or
// linux-x86_64. If omitted, the host target is inferred.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOR_VERSION = '15.0.19';
const DIST =
  'https://archive.torproject.org/tor-package-archive/torbrowser';

// Reviewed against Tor Browser's signed 15.0.19 checksum manifest. Keeping
// these values in the repository prevents a download host from substituting
// both an archive and its checksum, and makes every release reproducible.
export const TOR_ARCHIVE_SHA256 = Object.freeze({
  'windows-x86_64':
    '6ac067402c7b4a3dc37887ed3754b3914b67fdc220c966190683e9ccf91abf0f',
  'macos-x86_64':
    '95243f76bcf05d6179d017c3f3e4ece7b53cc58dff1ba617b03a2fe2c8298b5b',
  'macos-aarch64':
    'c99cf6f69740a443c7fffaf598ceb0952b3914041507c8afe11bed84a3333eb1',
  'linux-x86_64':
    '5a8f19f5f119b5fa2a8fd799a3a532e3236ad36164241800d6302e32f0e1c2a9',
});

const bundleName = (target, version) =>
  `tor-expert-bundle-${target}-${version}.tar.gz`;

export function getTorArtifact(target) {
  const expectedSha256 = TOR_ARCHIVE_SHA256[target];
  if (!expectedSha256) {
    throw new Error(`unsupported or unpinned Tor target: ${target}`);
  }

  const archive = bundleName(target, TOR_VERSION);
  return {
    version: TOR_VERSION,
    archive,
    sha256: expectedSha256,
    url: `${DIST}/${TOR_VERSION}/${archive}`,
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, 'src-tauri', 'resources', 'tor');

function inferTarget() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return 'windows-x86_64';
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64';
  }
  if (platform === 'linux' && arch === 'x64') return 'linux-x86_64';
  throw new Error(`unsupported host platform ${platform}/${arch}`);
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed ${response.status}: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, bytes);
  return bytes;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  const target = process.argv[2] || inferTarget();
  const artifact = getTorArtifact(target);
  const isWindows = target.startsWith('windows');
  const torBinary = isWindows ? 'tor.exe' : 'tor';
  const markerPath = join(outDir, 'VERSION');
  const stagedFiles = [torBinary, 'geoip', 'geoip6', 'VERSION'].map((name) =>
    join(outDir, name),
  );

  if (stagedFiles.every(existsSync)) {
    const marker = readFileSync(markerPath, 'utf8').trim().split(/\s+/);
    const stagedVersion = marker[0];
    const stagedTarget = marker.slice(1).join(' ');
    if (
      stagedVersion === artifact.version &&
      stagedTarget === target
    ) {
      console.log(
        `[fetch-tor] Tor already staged (${readFileSync(markerPath, 'utf8').trim()})`,
      );
      return;
    }
  }

  // Work in the OS temp directory so antivirus handles cannot lock a
  // repository-local extraction directory.
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'optn-tor-'));
  const tarball = join(temporaryDirectory, artifact.archive);

  console.log(`[fetch-tor] downloading ${artifact.archive}`);
  const bytes = await download(artifact.url, tarball);

  console.log('[fetch-tor] verifying pinned SHA256');
  const actualSha256 = sha256(bytes).toLowerCase();
  if (actualSha256 !== artifact.sha256) {
    throw new Error(
      `SHA256 mismatch for ${artifact.archive}: expected ${artifact.sha256}, got ${actualSha256}`,
    );
  }
  console.log('[fetch-tor] pinned checksum OK');

  // System tar is available on supported desktop hosts and GitHub runners.
  // Use a bare filename from the temp directory so Windows tar does not
  // interpret a drive-prefixed path as a remote host.
  console.log('[fetch-tor] extracting');
  execFileSync('tar', ['-xzf', artifact.archive], {
    stdio: 'inherit',
    cwd: temporaryDirectory,
  });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const sourceDirectory = join(temporaryDirectory, 'tor');
  const sourceBinary = join(sourceDirectory, torBinary);
  if (!existsSync(sourceBinary)) {
    throw new Error(`extracted bundle has no ${sourceBinary}`);
  }
  // Stage the whole directory, not just the executable. The Expert Bundle
  // ships the libraries tor links against beside it, and copying the binary
  // alone left them behind: on Linux that produced a tor needing
  // libevent-2.1.so.7 from the host, which failed the AppImage build outright
  // (linuxdeploy resolves every ELF in the AppDir) and would have left deb and
  // rpm users depending on whatever tor their distribution happened to have.
  const staged = readdirSync(sourceDirectory);
  for (const name of staged) {
    copyFileSync(join(sourceDirectory, name), join(outDir, name));
  }
  console.log(`[fetch-tor] staged from bundle: ${staged.join(', ')}`);
  copyFileSync(
    join(temporaryDirectory, 'data', 'geoip'),
    join(outDir, 'geoip'),
  );
  copyFileSync(
    join(temporaryDirectory, 'data', 'geoip6'),
    join(outDir, 'geoip6'),
  );
  writeFileSync(
    markerPath,
    `${artifact.version} ${target}\n`,
  );

  rmSync(temporaryDirectory, { recursive: true, force: true });
  console.log(
    `[fetch-tor] staged Tor ${artifact.version} (${target}) into ${outDir}`,
  );
  if (!existsSync(join(outDir, torBinary))) {
    throw new Error('staging failed: binary missing');
  }
  console.log(readFileSync(markerPath, 'utf8').trim());
}

// Importing this module for tests must never trigger a network download.
const invokedDirectly = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error('[fetch-tor] ERROR:', error.message);
    process.exit(1);
  });
}

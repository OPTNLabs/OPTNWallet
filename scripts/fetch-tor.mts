// Fetch and stage the Tor Expert Bundle used by the Tauri desktop app.
//
// Usage:
//   tsx scripts/fetch-tor.mts [target]
//
// target is one of windows-x86_64, macos-x86_64, macos-aarch64,
// linux-x86_64, or linux-aarch64. If omitted, the host target is inferred.
//
// linux-aarch64: Tor Project does not publish a desktop Expert Bundle for
// Linux ARM. We build a pinned Tor source release on the native ARM runner,
// then stage GeoIP data from the pinned linux-x86_64 Expert Bundle.

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
const DIST = 'https://archive.torproject.org/tor-package-archive/torbrowser';
const TOR_SOURCE_DIST = 'https://dist.torproject.org';

// The official linux-x86_64 Expert Bundle above contains this Tor daemon
// release. Linux ARM has no equivalent Expert Bundle, so its binary is built
// from the same reviewed upstream daemon source instead of inheriting whatever
// version apt happens to install on the CI runner.
export const LINUX_AARCH64_TOR_SOURCE = Object.freeze({
  version: '0.4.9.11',
  sha256: '2e6c1720118c812acf0079fd47cf91b6bfaba5d766c321c4d3d2a28d6a11a8ed',
});

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

export function getLinuxAarch64TorSourceArtifact() {
  const archive = `tor-${LINUX_AARCH64_TOR_SOURCE.version}.tar.gz`;
  return {
    ...LINUX_AARCH64_TOR_SOURCE,
    archive,
    url: `${TOR_SOURCE_DIST}/${archive}`,
  };
}

/**
 * Names of the plain files in an extracted bundle directory.
 *
 * Subdirectories are skipped: the bundle carries a pluggable_transports/
 * directory of censorship-circumvention proxies that nothing here launches, so
 * staging it would only add weight to every installer. Copying it is also not
 * merely wasteful — copyFileSync throws on a directory (EISDIR on Linux,
 * ENOTSUP on macOS), which took out all four desktop builds when this staged
 * the directory listing unfiltered.
 */
export function bundleFileNames(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
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
  if (platform === 'linux' && arch === 'arm64') return 'linux-aarch64';
  throw new Error(`unsupported host platform ${platform}/${arch}`);
}

/**
 * Copy the runtime libraries a dynamically linked Linux Tor binary needs.
 * A missing dependency is a packaging failure, never a warning: shipping an
 * unrunnable Tor binary would otherwise make Fusion silently unavailable.
 */
function copyLinuxSharedLibraries(binary) {
  let lddOut;
  try {
    lddOut = execFileSync('ldd', [binary], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(
      `could not inspect Tor shared libraries: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (/=>\s+not found/.test(lddOut)) {
    throw new Error(`Tor has unresolved shared libraries:\n${lddOut}`);
  }

  for (const line of lddOut.split('\n')) {
    const match = line.match(/=>\s+(\/[^ ]+)/);
    if (!match) continue;
    const libPath = match[1];
    if (!existsSync(libPath)) {
      throw new Error(`Tor dependency disappeared during staging: ${libPath}`);
    }
    // Skip linker and common system libs that AppImage already provides.
    const base = libPath.split('/').pop() ?? '';
    if (
      base.startsWith('libc.so') ||
      base.startsWith('libm.so') ||
      base.startsWith('libpthread') ||
      base.startsWith('libdl.so') ||
      base.startsWith('ld-linux')
    ) {
      continue;
    }
    copyFileSync(libPath, join(outDir, base));
  }
}

/**
 * Source-built Linux ARM Tor is staged with its non-glibc shared libraries.
 * Point the executable at that colocated directory so it remains runnable in
 * the packaged application instead of depending on the CI image's library
 * paths.
 */
function setLinuxRpath(binary) {
  try {
    execFileSync('patchelf', ['--set-rpath', '$ORIGIN', binary], {
      stdio: 'pipe',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to set the staged Tor runtime library path: ${detail}`
    );
  }
}

/**
 * Apple Silicon checks code signatures while loading a dynamically linked
 * executable. Preview builds have no Developer ID credentials, so ad-hoc sign
 * every Mach-O from the extracted Tor bundle before the smoke check. Release
 * builds sign these files again with the configured identity later.
 */
function signMacosTorFiles(target, directory = outDir) {
  if (process.platform !== 'darwin' || !target.startsWith('macos-')) return;

  let count = 0;
  for (const name of bundleFileNames(directory)) {
    const filePath = join(directory, name);
    const description = execFileSync('file', ['-b', filePath], {
      encoding: 'utf8',
    });
    if (!/Mach-O/.test(description)) continue;

    execFileSync(
      'codesign',
      ['--force', '--timestamp=none', '--sign', '-', filePath],
      { stdio: 'inherit' }
    );
    count += 1;
  }

  if (count === 0) {
    throw new Error('macOS Tor staging found no Mach-O files to sign');
  }
  console.log(`[fetch-tor] ad-hoc signed ${count} macOS Tor files`);
}

/** Run the staged binary on matching-host builds to prove it can load. */
function verifyStagedTorExecutable(target, binary) {
  if (inferTarget() !== target) return;
  let output;
  try {
    output = execFileSync(binary, ['--version'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(
      `staged Tor failed its --version smoke check: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!/Tor version\s+\d+\.\d+\.\d+/.test(output)) {
    throw new Error('staged Tor did not report a valid version.');
  }
  console.log(`[fetch-tor] smoke check: ${output.split('\n')[0]}`);
}

/**
 * Stage Tor for Linux aarch64 when no desktop Expert Bundle exists.
 * The daemon comes from a pinned, checksum-verified Tor Project source
 * archive and is built natively on the ARM runner. GeoIP tables come from the
 * pinned x86_64 Expert Bundle (they are architecture-neutral data files).
 */
async function stageLinuxAarch64FromSource() {
  if (process.platform !== 'linux' || process.arch !== 'arm64') {
    throw new Error(
      'linux-aarch64 Tor staging must run on a native Linux ARM64 host.'
    );
  }

  const source = getLinuxAarch64TorSourceArtifact();
  const geoipSource = getTorArtifact('linux-x86_64');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'optn-tor-arm-'));
  try {
    const sourceTarball = join(temporaryDirectory, source.archive);
    console.log(`[fetch-tor] linux-aarch64: downloading ${source.archive}`);
    const sourceBytes = await download(source.url, sourceTarball);
    const sourceSha256 = sha256(sourceBytes).toLowerCase();
    if (sourceSha256 !== source.sha256) {
      throw new Error(
        `SHA256 mismatch for ${source.archive}: expected ${source.sha256}, got ${sourceSha256}`
      );
    }
    execFileSync('tar', ['-xzf', source.archive], {
      stdio: 'inherit',
      cwd: temporaryDirectory,
    });

    const sourceDirectory = join(temporaryDirectory, `tor-${source.version}`);
    const buildDirectory = join(temporaryDirectory, 'build');
    mkdirSync(buildDirectory, { recursive: true });
    execFileSync(
      join(sourceDirectory, 'configure'),
      [
        '--disable-asciidoc',
        '--disable-lzma',
        '--disable-systemd',
        '--disable-zstd',
      ],
      { stdio: 'inherit', cwd: buildDirectory }
    );
    execFileSync('make', ['-j2'], { stdio: 'inherit', cwd: buildDirectory });
    const builtTor = join(buildDirectory, 'src', 'app', 'tor');
    if (!existsSync(builtTor)) {
      throw new Error(`Tor source build produced no executable at ${builtTor}`);
    }

    const geoipTarball = join(temporaryDirectory, geoipSource.archive);
    console.log(
      `[fetch-tor] linux-aarch64: downloading GeoIP source ${geoipSource.archive}`
    );
    const geoipBytes = await download(geoipSource.url, geoipTarball);
    const geoipSha256 = sha256(geoipBytes).toLowerCase();
    if (geoipSha256 !== geoipSource.sha256) {
      throw new Error(
        `SHA256 mismatch for ${geoipSource.archive}: expected ${geoipSource.sha256}, got ${geoipSha256}`
      );
    }
    execFileSync('tar', ['-xzf', geoipSource.archive], {
      stdio: 'inherit',
      cwd: temporaryDirectory,
    });

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const stagedTor = join(outDir, 'tor');
    copyFileSync(builtTor, stagedTor);
    copyLinuxSharedLibraries(builtTor);
    setLinuxRpath(stagedTor);
    copyFileSync(
      join(temporaryDirectory, 'data', 'geoip'),
      join(outDir, 'geoip')
    );
    copyFileSync(
      join(temporaryDirectory, 'data', 'geoip6'),
      join(outDir, 'geoip6')
    );
    writeFileSync(
      join(outDir, 'VERSION'),
      `${TOR_VERSION} linux-aarch64 tor-${source.version}\n`
    );
    verifyStagedTorExecutable('linux-aarch64', stagedTor);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(
    `[fetch-tor] staged linux-aarch64 Tor from pinned source ${source.version}`
  );
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

  // Linux ARM has no official desktop Expert Bundle — special staging path.
  if (target === 'linux-aarch64') {
    const markerPath = join(outDir, 'VERSION');
    const source = getLinuxAarch64TorSourceArtifact();
    if (
      existsSync(join(outDir, 'tor')) &&
      existsSync(join(outDir, 'geoip')) &&
      existsSync(join(outDir, 'geoip6')) &&
      existsSync(markerPath) &&
      readFileSync(markerPath, 'utf8').trim() ===
        `${TOR_VERSION} linux-aarch64 tor-${source.version}`
    ) {
      verifyStagedTorExecutable(target, join(outDir, 'tor'));
      console.log(
        `[fetch-tor] Tor already staged (${readFileSync(markerPath, 'utf8').trim()})`
      );
      return;
    }
    await stageLinuxAarch64FromSource();
    return;
  }

  const artifact = getTorArtifact(target);
  const isWindows = target.startsWith('windows');
  const torBinary = isWindows ? 'tor.exe' : 'tor';
  const markerPath = join(outDir, 'VERSION');
  const stagedFiles = [torBinary, 'geoip', 'geoip6', 'VERSION'].map((name) =>
    join(outDir, name)
  );

  if (stagedFiles.every(existsSync)) {
    const marker = readFileSync(markerPath, 'utf8').trim().split(/\s+/);
    const stagedVersion = marker[0];
    const stagedTarget = marker.slice(1).join(' ');
    if (stagedVersion === artifact.version && stagedTarget === target) {
      signMacosTorFiles(target);
      verifyStagedTorExecutable(target, join(outDir, torBinary));
      console.log(
        `[fetch-tor] Tor already staged (${readFileSync(markerPath, 'utf8').trim()})`
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
      `SHA256 mismatch for ${artifact.archive}: expected ${artifact.sha256}, got ${actualSha256}`
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
  const staged = bundleFileNames(sourceDirectory);
  for (const name of staged) {
    copyFileSync(join(sourceDirectory, name), join(outDir, name));
  }
  console.log(`[fetch-tor] staged from bundle: ${staged.join(', ')}`);
  copyFileSync(
    join(temporaryDirectory, 'data', 'geoip'),
    join(outDir, 'geoip')
  );
  copyFileSync(
    join(temporaryDirectory, 'data', 'geoip6'),
    join(outDir, 'geoip6')
  );
  writeFileSync(markerPath, `${artifact.version} ${target}\n`);
  signMacosTorFiles(target);
  if (target.startsWith('linux-')) {
    setLinuxRpath(join(outDir, torBinary));
  }

  rmSync(temporaryDirectory, { recursive: true, force: true });
  console.log(
    `[fetch-tor] staged Tor ${artifact.version} (${target}) into ${outDir}`
  );
  if (!existsSync(join(outDir, torBinary))) {
    throw new Error('staging failed: binary missing');
  }
  signMacosTorFiles(target);
  verifyStagedTorExecutable(target, join(outDir, torBinary));
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

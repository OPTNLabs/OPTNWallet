// Fetches the Tor Expert Bundle for a target platform and stages the pieces the
// app needs (tor binary + geoip data) into src-tauri/resources/tor/, which the
// Tauri build ships as a resource. The Rust side (resolve_tor_paths) then finds
// tor at <resources>/tor/tor(.exe) so the integrated Tor works with no external
// Tor install.
//
// Usage:
//   node scripts/fetch-tor.mjs [target]
// target is one of: windows-x86_64, macos-x86_64, macos-aarch64, linux-x86_64.
// If omitted, it's inferred from the host. The download is SHA256-verified
// against Tor's signed sums file before extraction.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// dist.torproject.org publishes exactly ONE stable version directory at a time —
// a point release deletes its predecessor. Pinning 15.0.17 therefore did not go
// stale, it went 404, and took the desktop build down on all three runners the
// day 15.0.19 shipped.
//
// The pin is kept because it makes a build reproducible while upstream still has
// it, but it cannot be the only path or CI breaks again on Tor's next release.
// So: use the pin when it is there, otherwise the newest stable upstream.
//
// This does not weaken verification. The checksum is fetched from the same host
// as the tarball either way, so the pin never provided independent integrity —
// only reproducibility, which the fallback preserves whenever it can.
const TOR_VERSION = '15.0.19';
const DIST = 'https://dist.torproject.org/torbrowser';

const bundleName = (target, version) =>
  `tor-expert-bundle-${target}-${version}.tar.gz`;

/**
 * Newest stable version in a dist.torproject.org directory listing.
 *
 * Split out from the fetch so it can be tested against a real captured listing:
 * this function decides which Tor binary ships to users, and the two ways it can
 * be wrong — picking an alpha, or ordering 15.0.9 above 15.0.19 — both produce a
 * plausible-looking version string rather than an error.
 */
export function pickLatestStable(html) {
  // Requiring the whole segment to be numeric drops alphas (`16.0a9/`) without
  // needing to know how Tor spells a pre-release this year.
  const versions = [...html.matchAll(/href="(\d+(?:\.\d+)+)\/"/g)].map((m) => m[1]);
  if (versions.length === 0) throw new Error('no stable versions in listing');
  // Numeric compare per component: "15.0.9" must not sort above "15.0.19".
  versions.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return versions[versions.length - 1];
}

async function latestStableVersion() {
  const res = await fetch(`${DIST}/`);
  if (!res.ok) throw new Error(`could not list ${DIST} (${res.status})`);
  return pickLatestStable(await res.text());
}

/** The pinned version if upstream still has it, else the newest stable. */
async function resolveVersion(target) {
  // HEAD, so discovering a deleted pin costs one round trip instead of a
  // download.
  const pinned = await fetch(`${DIST}/${TOR_VERSION}/${bundleName(target, TOR_VERSION)}`, {
    method: 'HEAD',
  });
  if (pinned.ok) return TOR_VERSION;
  const latest = await latestStableVersion();
  console.warn(
    `[fetch-tor] pinned ${TOR_VERSION} is gone upstream (${pinned.status}); using ${latest}`
  );
  return latest;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, 'src-tauri', 'resources', 'tor');

function inferTarget() {
  const { platform, arch } = process;
  if (platform === 'win32') return 'windows-x86_64';
  if (platform === 'darwin') return arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64';
  if (platform === 'linux') return 'linux-x86_64';
  throw new Error(`unsupported host platform ${platform}/${arch}`);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const target = process.argv[2] || inferTarget();
  const isWindows = target.startsWith('windows');
  // Stage in the OS temp dir (not the repo) so an antivirus handle on the
  // extracted tor binary can't lock a repo-local directory.
  const tmpDir = mkdtempSync(join(tmpdir(), 'optn-tor-'));
  const version = await resolveVersion(target);
  const base = `${DIST}/${version}`;
  const archive = bundleName(target, version);

  console.log(`[fetch-tor] downloading ${archive}`);
  const tarball = join(tmpDir, archive);
  const buf = await download(`${base}/${archive}`, tarball);
  void tarball;

  // Verify against Tor's signed SHA256 sums (the file itself is GPG-signed by
  // the Tor Project; here we at least pin the archive's hash to it).
  console.log('[fetch-tor] verifying SHA256');
  const sumsRes = await fetch(`${base}/sha256sums-signed-build.txt`);
  if (!sumsRes.ok) throw new Error(`could not fetch sha256sums (${sumsRes.status})`);
  const sums = await sumsRes.text();
  const line = sums.split('\n').find((l) => l.includes(archive));
  if (!line) throw new Error(`no checksum entry for ${archive}`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = sha256(buf).toLowerCase();
  if (expected !== actual) {
    throw new Error(`SHA256 mismatch for ${archive}: expected ${expected}, got ${actual}`);
  }
  console.log('[fetch-tor] checksum OK');

  // Extract with the system tar (present on Windows 10+, macOS, Linux, and all
  // CI runners). Run from inside tmpDir with a bare filename so GNU tar on
  // Windows doesn't misread a "C:\..." path as a remote host.
  console.log('[fetch-tor] extracting');
  execFileSync('tar', ['-xzf', archive], { stdio: 'inherit', cwd: tmpDir });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const torBin = isWindows ? 'tor.exe' : 'tor';
  const srcBin = join(tmpDir, 'tor', torBin);
  if (!existsSync(srcBin)) throw new Error(`extracted bundle has no ${srcBin}`);
  copyFileSync(srcBin, join(outDir, torBin));
  copyFileSync(join(tmpDir, 'data', 'geoip'), join(outDir, 'geoip'));
  copyFileSync(join(tmpDir, 'data', 'geoip6'), join(outDir, 'geoip6'));

  // A small marker so it's obvious which version is staged.
  writeFileSync(join(outDir, 'VERSION'), `${version} ${target}\n`);

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[fetch-tor] staged Tor ${version} (${target}) into ${outDir}`);
  // Sanity: confirm the marker + binary exist.
  if (!existsSync(join(outDir, torBin))) throw new Error('staging failed: binary missing');
  console.log(readFileSync(join(outDir, 'VERSION'), 'utf8').trim());
}

// Only download when run as a command. Without this, importing the module to
// test pickLatestStable would kick off a real fetch-and-extract.
const invokedDirectly = (() => {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[fetch-tor] ERROR:', err.message);
    process.exit(1);
  });
}

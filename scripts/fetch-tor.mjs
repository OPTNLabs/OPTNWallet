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
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOR_VERSION = '15.0.17';
const BASE = `https://dist.torproject.org/torbrowser/${TOR_VERSION}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, 'src-tauri', 'resources', 'tor');
// Stage in the OS temp dir (not the repo) so an antivirus handle on the
// extracted tor binary can't lock a repo-local directory.
const tmpDir = mkdtempSync(join(tmpdir(), 'optn-tor-'));

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
  const bundleName = `tor-expert-bundle-${target}-${TOR_VERSION}.tar.gz`;

  console.log(`[fetch-tor] downloading ${bundleName}`);
  const tarball = join(tmpDir, bundleName);
  const buf = await download(`${BASE}/${bundleName}`, tarball);
  void tarball;

  // Verify against Tor's signed SHA256 sums (the file itself is GPG-signed by
  // the Tor Project; here we at least pin the archive's hash to it).
  console.log('[fetch-tor] verifying SHA256');
  const sumsRes = await fetch(`${BASE}/sha256sums-signed-build.txt`);
  if (!sumsRes.ok) throw new Error(`could not fetch sha256sums (${sumsRes.status})`);
  const sums = await sumsRes.text();
  const line = sums.split('\n').find((l) => l.includes(bundleName));
  if (!line) throw new Error(`no checksum entry for ${bundleName}`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = sha256(buf).toLowerCase();
  if (expected !== actual) {
    throw new Error(`SHA256 mismatch for ${bundleName}: expected ${expected}, got ${actual}`);
  }
  console.log('[fetch-tor] checksum OK');

  // Extract with the system tar (present on Windows 10+, macOS, Linux, and all
  // CI runners). Run from inside tmpDir with a bare filename so GNU tar on
  // Windows doesn't misread a "C:\..." path as a remote host.
  console.log('[fetch-tor] extracting');
  execFileSync('tar', ['-xzf', bundleName], { stdio: 'inherit', cwd: tmpDir });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const torBin = isWindows ? 'tor.exe' : 'tor';
  const srcBin = join(tmpDir, 'tor', torBin);
  if (!existsSync(srcBin)) throw new Error(`extracted bundle has no ${srcBin}`);
  copyFileSync(srcBin, join(outDir, torBin));
  copyFileSync(join(tmpDir, 'data', 'geoip'), join(outDir, 'geoip'));
  copyFileSync(join(tmpDir, 'data', 'geoip6'), join(outDir, 'geoip6'));

  // A small marker so it's obvious which version is staged.
  writeFileSync(join(outDir, 'VERSION'), `${TOR_VERSION} ${target}\n`);

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[fetch-tor] staged Tor ${TOR_VERSION} (${target}) into ${outDir}`);
  // Sanity: confirm the marker + binary exist.
  if (!existsSync(join(outDir, torBin))) throw new Error('staging failed: binary missing');
  console.log(readFileSync(join(outDir, 'VERSION'), 'utf8').trim());
}

main().catch((err) => {
  console.error('[fetch-tor] ERROR:', err.message);
  process.exit(1);
});

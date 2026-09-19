#!/usr/bin/env node
/**
 * Build `latest.json` — the manifest an installed desktop wallet polls.
 *
 * Every entry names an artifact and the detached signature the application
 * verifies it against before running it. The signature is the whole point: a
 * manifest that listed a URL without one would be a list of things to download
 * and execute on the say-so of whoever served the list.
 *
 * So this refuses rather than degrades. An artifact with no `.sig` is an error,
 * not an entry with an empty signature, and a platform that produced nothing is
 * an error too — a manifest missing a platform silently strands every holder on
 * it, which is the failure mode that looks like "updates just stopped working"
 * months later.
 *
 * Usage:
 *   node scripts/build-update-manifest.mjs <release-files-dir> <version> <notes-url>
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, version, notesUrl] = process.argv.slice(2);
if (!dir || !version) {
  console.error(
    'usage: build-update-manifest.mjs <release-files-dir> <version> [notes-url]'
  );
  process.exit(2);
}

const DOWNLOAD_BASE = `https://github.com/OPTNLabs/OPTNWallet/releases/download/v${version}`;

/**
 * Which published artifact each Tauri update target installs from.
 *
 * Only these formats can update. A `.msi`, `.dmg`, `.deb` or `.rpm` is
 * published and installed by hand — replacing a distribution-managed install
 * from inside the application would fight the package manager, and Tauri does
 * not support it.
 */
const TARGETS = {
  'windows-x86_64': `OPTNWallet-${version}-windows-x64-setup.exe`,
  'darwin-aarch64': `OPTNWallet-${version}-macos-arm64.app.tar.gz`,
  'darwin-x86_64': `OPTNWallet-${version}-macos-x64.app.tar.gz`,
  'linux-x86_64': `OPTNWallet-${version}-linux-x64.AppImage`,
  'linux-aarch64': `OPTNWallet-${version}-linux-arm64.AppImage`,
};

const present = new Set(readdirSync(dir));
const platforms = {};
const missing = [];

for (const [target, file] of Object.entries(TARGETS)) {
  if (!present.has(file)) {
    missing.push(`${target}: ${file}`);
    continue;
  }
  const sigName = `${file}.sig`;
  if (!present.has(sigName)) {
    console.error(
      `::error::${file} has no ${sigName}. An update artifact without a ` +
        'signature cannot be verified, and publishing it unsigned would ask ' +
        'holders to run whatever the download server handed them.'
    );
    process.exit(1);
  }
  const signature = readFileSync(join(dir, sigName), 'utf8').trim();
  if (!signature) {
    console.error(`::error::${sigName} is empty`);
    process.exit(1);
  }
  platforms[target] = {
    signature,
    url: `${DOWNLOAD_BASE}/${file}`,
  };
}

if (missing.length > 0) {
  console.error(
    '::error::no update artifact for: ' +
      missing.join(', ') +
      '. A platform missing from the manifest strands every holder on it.'
  );
  process.exit(1);
}

const manifest = {
  version: `v${version}`,
  pub_date: new Date().toISOString(),
  notes: notesUrl ?? `${DOWNLOAD_BASE}`,
  platforms,
};

const out = join(dir, 'latest.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `latest.json: ${Object.keys(platforms).length} platforms, each with a signature`
);
for (const target of Object.keys(platforms)) {
  console.log(`  ${target}`);
}

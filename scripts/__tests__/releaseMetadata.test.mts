import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf8'));

const readText = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8');

const packageVersionFromCargoLock = (cargoLock) => {
  const match = cargoLock.match(
    /\[\[package\]\]\s+name = "optn-wallet-desktop"\s+version = "([^"]+)"/m
  );
  if (!match)
    throw new Error('optn-wallet-desktop package is missing from Cargo.lock');
  return match[1];
};

const packageVersionFromCargoToml = (cargoToml) => {
  const packageSection = cargoToml.match(
    /\[package\]([\s\S]*?)(?:\r?\n\[|$)/
  )?.[1];
  const match = packageSection?.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('package.version is missing from Cargo.toml');
  return match[1];
};

describe('release metadata', () => {
  it('uses the npm package version in every shipped application manifest', () => {
    const expectedVersion = readJson('package.json').version;
    const shippedVersions = {
      packageLock: readJson('package-lock.json').packages[''].version,
      tauri: readJson('src-tauri/tauri.conf.json').version,
      cargoToml: packageVersionFromCargoToml(readText('src-tauri/Cargo.toml')),
      cargoLock: packageVersionFromCargoLock(readText('src-tauri/Cargo.lock')),
      chrome: readJson('extension/manifest.chrome.json').version,
      firefox: readJson('extension/manifest.firefox.json').version,
    };

    expect(shippedVersions).toEqual({
      packageLock: expectedVersion,
      tauri: expectedVersion,
      cargoToml: expectedVersion,
      cargoLock: expectedVersion,
      chrome: expectedVersion,
      firefox: expectedVersion,
    });
  });
});

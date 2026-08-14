import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  TOR_ARCHIVE_SHA256,
  TOR_VERSION,
  LINUX_AARCH64_TOR_SOURCE,
  bundleFileNames,
  getLinuxAarch64TorSourceArtifact,
  getTorArtifact,
} from '../fetch-tor.mts';

describe('pinned Tor Expert Bundle', () => {
  it('resolves every desktop target to the immutable Tor archive', () => {
    for (const target of [
      'windows-x86_64',
      'macos-x86_64',
      'macos-aarch64',
      'linux-x86_64',
    ]) {
      const artifact = getTorArtifact(target);

      expect(artifact.version).toBe(TOR_VERSION);
      expect(artifact.archive).toBe(
        `tor-expert-bundle-${target}-${TOR_VERSION}.tar.gz`
      );
      expect(artifact.url).toBe(
        `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/${artifact.archive}`
      );
      expect(artifact.sha256).toBe(TOR_ARCHIVE_SHA256[target]);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('fails closed for a target without a reviewed Expert Bundle checksum', () => {
    // linux-aarch64 has no official desktop Expert Bundle; fetch-tor builds a
    // pinned Tor source release instead of silently accepting host package Tor.
    expect(() => getTorArtifact('linux-aarch64')).toThrow(
      'unsupported or unpinned Tor target'
    );
    expect(() => getTorArtifact('windows-arm64')).toThrow(
      'unsupported or unpinned Tor target'
    );
  });

  it('pins the Linux ARM Tor source used when no Expert Bundle exists', () => {
    const artifact = getLinuxAarch64TorSourceArtifact();
    expect(artifact.version).toBe(LINUX_AARCH64_TOR_SOURCE.version);
    expect(artifact.archive).toBe(`tor-${artifact.version}.tar.gz`);
    expect(artifact.url).toBe(
      `https://dist.torproject.org/${artifact.archive}`
    );
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('staging the extracted bundle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fetch-tor-staging-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('stages tor beside its libraries and skips pluggable_transports', () => {
    // The shape the Expert Bundle actually extracts: the executable, the
    // libraries it links against, and a directory of transports.
    writeFileSync(join(directory, 'tor'), '');
    writeFileSync(join(directory, 'libevent-2.1.so.7'), '');
    mkdirSync(join(directory, 'pluggable_transports'));

    // Sorted because readdir order is not guaranteed across filesystems.
    expect(bundleFileNames(directory).sort()).toEqual([
      'libevent-2.1.so.7',
      'tor',
    ]);
  });
});

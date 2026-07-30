import { describe, expect, it } from 'vitest';
import {
  TOR_ARCHIVE_SHA256,
  TOR_VERSION,
  getTorArtifact,
} from '../fetch-tor.mjs';

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
        `tor-expert-bundle-${target}-${TOR_VERSION}.tar.gz`,
      );
      expect(artifact.url).toBe(
        `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/${artifact.archive}`,
      );
      expect(artifact.sha256).toBe(TOR_ARCHIVE_SHA256[target]);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('fails closed for a target without a reviewed checksum', () => {
    expect(() => getTorArtifact('linux-aarch64')).toThrow(
      'unsupported or unpinned Tor target',
    );
  });
});

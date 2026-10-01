/**
 * `latest.json` is the list of things an installed wallet will download and
 * run. Every failure mode here ends with a holder executing something, so the
 * generator refuses rather than degrades — and these assert the refusals, not
 * the happy path alone.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = resolve(repoRoot, 'scripts', 'build-update-manifest.mjs');
const VERSION = '1.7.4';

const UPDATABLE = [
  `OPTNWallet-${VERSION}-windows-x64-setup.exe`,
  `OPTNWallet-${VERSION}-macos-arm64.app.tar.gz`,
  `OPTNWallet-${VERSION}-macos-x64.app.tar.gz`,
  `OPTNWallet-${VERSION}-linux-x64.AppImage`,
  `OPTNWallet-${VERSION}-linux-arm64.AppImage`,
];

let dir: string;

function populate(
  options: { skip?: string; unsigned?: string; empty?: string } = {}
) {
  for (const name of UPDATABLE) {
    if (name === options.skip) continue;
    writeFileSync(join(dir, name), 'binary');
    if (name === options.unsigned) continue;
    writeFileSync(
      join(dir, `${name}.sig`),
      name === options.empty ? '' : `signature-for-${name}`
    );
  }
}

function run(): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [script, dir, VERSION, 'https://example/notes'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'optn-update-manifest-'));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('build-update-manifest', () => {
  it('names every platform, each with its signature', () => {
    populate();
    const result = run();
    expect(result.ok, result.output).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(dir, 'latest.json'), 'utf8')
    ) as {
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    };

    expect(manifest.version).toBe(`v${VERSION}`);
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-aarch64',
      'linux-x86_64',
      'windows-x86_64',
    ]);
    for (const [target, entry] of Object.entries(manifest.platforms)) {
      expect(entry.signature, `${target} signature`).not.toBe('');
      expect(entry.url, `${target} url`).toContain(
        `releases/download/v${VERSION}/`
      );
    }
  });

  it('refuses an artifact with no signature rather than listing it unsigned', () => {
    // The failure that matters. An entry without a signature is an instruction
    // to download and run whatever the server hands over.
    populate({ unsigned: `OPTNWallet-${VERSION}-linux-x64.AppImage` });
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.output).toContain('has no');
    expect(result.output).toContain('.sig');
  });

  it('refuses an empty signature file', () => {
    populate({ empty: `OPTNWallet-${VERSION}-windows-x64-setup.exe` });
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.output).toContain('is empty');
  });

  it('refuses a manifest that would strand a platform', () => {
    // A platform silently missing is how "updates stopped working" is
    // discovered months later by the people it stopped working for.
    populate({ skip: `OPTNWallet-${VERSION}-macos-arm64.app.tar.gz` });
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.output).toContain('darwin-aarch64');
  });

  it('writes nothing at all when it refuses', () => {
    populate({ skip: `OPTNWallet-${VERSION}-linux-arm64.AppImage` });
    run();
    expect(() => readFileSync(join(dir, 'latest.json'), 'utf8')).toThrow();
  });
});

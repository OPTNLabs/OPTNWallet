import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = parse(
  readFileSync(
    resolve(repoRoot, '.github/workflows/lockfile-freshness.yml'),
    'utf8'
  )
) as {
  jobs: {
    locks: { steps: Array<{ run?: string; 'working-directory'?: string }> };
  };
};
const steps = workflow.jobs.locks.steps.filter((step) =>
  /\bcargo\b/.test(step.run ?? '')
);
const roots = [
  '.',
  'src-tauri',
  'crates/optn-core',
  'crates/optn-cli',
  'crates/optn-ui-egui',
  'fuzz',
];
// Match the existing workflow regression tests' Git-for-Windows Bash lookup.
const bash =
  process.env.BASH ||
  (process.platform === 'win32'
    ? resolve(
        execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
        '../../../bin/bash.exe'
      )
    : 'bash');

describe('lockfile freshness', () => {
  it('validates every committed lock without floating compatible versions', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'optn-lockfile-'));
    const env = {
      ...process.env,
      CARGO_HOME: resolve(fixture, 'cargo-home'),
      CARGO_NET_OFFLINE: 'true',
    };
    const write = (path: string, contents: string) => {
      const file = resolve(fixture, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
    };
    const cargo = (root: string, args: string[]) => {
      const result = spawnSync('cargo', args, {
        cwd: resolve(fixture, root),
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const runGate = () => {
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        const result = spawnSync(bash, ['-e', '-c', step.run!], {
          cwd: resolve(fixture, step['working-directory'] ?? '.'),
          env,
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        if (result.status !== 0) return result;
      }
      return { status: 0, stderr: '' };
    };
    const publish = (version: string) => {
      const path = `registry/fixture-dep-${version}`;
      write(
        `${path}/Cargo.toml`,
        `[package]\nname = "fixture-dep"\nversion = "${version}"\nedition = "2021"\n`
      );
      write(`${path}/src/lib.rs`, 'pub fn value() -> u8 { 1 }\n');
      write(
        `${path}/.cargo-checksum.json`,
        JSON.stringify({ files: {}, package: null })
      );
    };

    try {
      // A directory source makes newly available versions deterministic and offline.
      write(
        '.cargo/config.toml',
        '[source.crates-io]\nreplace-with = "fixture"\n[source.fixture]\ndirectory = "registry"\n'
      );
      publish('1.0.0');
      for (const [index, root] of roots.entries()) {
        write(
          `${root}/Cargo.toml`,
          `[workspace]\n[package]\nname = "lock-fixture-${index}"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nfixture-dep = "1.0"\n`
        );
        write(
          `${root}/src/lib.rs`,
          'pub fn value() -> u8 { fixture_dep::value() }\n'
        );
        cargo(root, ['generate-lockfile']);
      }
      const locks = roots.map((root) =>
        readFileSync(resolve(fixture, root, 'Cargo.lock'), 'utf8')
      );
      publish('1.0.1');
      const valid = runGate();
      expect(valid.status, valid.stderr).toBe(0);
      for (const [index, root] of roots.entries()) {
        expect(readFileSync(resolve(fixture, root, 'Cargo.lock'), 'utf8')).toBe(
          locks[index]
        );
        const metadata = JSON.parse(
          cargo(root, ['metadata', '--locked', '--format-version', '1'])
        );
        expect(
          metadata.packages.find(
            (pkg: { name: string }) => pkg.name === 'fixture-dep'
          ).version
        ).toBe('1.0.0');
      }
      // Prove the fixture exposes the old gate's bug, rather than hiding the patch.
      cargo('.', ['generate-lockfile']);
      expect(readFileSync(resolve(fixture, 'Cargo.lock'), 'utf8')).toContain(
        'version = "1.0.1"'
      );
      write('Cargo.lock', locks[0]);

      for (const [index, root] of roots.entries()) {
        const lock = resolve(fixture, root, 'Cargo.lock');
        rmSync(lock);
        const missing = runGate();
        expect(
          missing.status,
          `${root}: missing lock\n${missing.stderr}`
        ).not.toBe(0);
        expect(missing.stderr).toContain('--locked');
        expect(existsSync(lock)).toBe(false);
        write(`${root}/Cargo.lock`, locks[index]);

        const manifest = readFileSync(
          resolve(fixture, root, 'Cargo.toml'),
          'utf8'
        );
        write(
          `${root}/Cargo.toml`,
          manifest.replace('fixture-dep = "1.0"', 'fixture-dep = "=1.0.1"')
        );
        const incompatible = runGate();
        expect(
          incompatible.status,
          `${root}: incompatible manifest\n${incompatible.stderr}`
        ).not.toBe(0);
        expect(incompatible.stderr).toContain('--locked');
        expect(readFileSync(lock, 'utf8')).toBe(locks[index]);
        write(`${root}/Cargo.toml`, manifest);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 60_000);
});

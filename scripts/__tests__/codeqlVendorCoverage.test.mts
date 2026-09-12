import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const codeqlConfig = readFileSync(
  resolve(repoRoot, '.github', 'codeql', 'codeql-config.yml'),
  'utf8'
);
const securityAnalysis = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'security-analysis.yml'),
  'utf8'
);
const rustQuality = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'rust-quality.yml'),
  'utf8'
);
const glibReview = readFileSync(
  resolve(repoRoot, 'docs', 'security', '2026-09-08-pr63-glib-codeql.md'),
  'utf8'
);

describe('CodeQL vendor coverage', () => {
  it('keeps unrestricted source coverage in the config the security workflow loads', () => {
    expect(codeqlConfig).not.toMatch(/^\s*(?:paths|paths-ignore)\s*:/m);
    expect(codeqlConfig).toContain('name: OPTN Wallet CodeQL');
    expect(securityAnalysis).toContain(
      'config-file: ./.github/codeql/codeql-config.yml'
    );
  });

  it('keeps vendored GLib under rust-quality tests instead of dropping coverage', () => {
    expect(rustQuality).toContain('vendor/glib-0.18.5');
    expect(rustQuality).toContain(
      'cargo test --manifest-path vendor/glib-0.18.5/Cargo.toml'
    );
    expect(glibReview).toContain('#113');
    expect(glibReview).toContain('vendor/glib-0.18.5');
  });
});

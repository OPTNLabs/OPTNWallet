import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const desktopPreviewWorkflow = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'desktop-preview.yml'),
  'utf8',
);
const extensionBuildConfig = readFileSync(
  resolve(repoRoot, 'vite.extension.config.ts'),
  'utf8',
);
const extensionShell = readFileSync(
  resolve(
    repoRoot,
    'src',
    'platform',
    'extension',
    'ExtensionAppShell.tsx',
  ),
  'utf8',
);

describe('release workflow', () => {
  it('pins every external action to an immutable full commit SHA', () => {
    for (const [name, contents] of [
      ['release', workflow],
      ['desktop preview', desktopPreviewWorkflow],
    ]) {
      const actionRefs = [...contents.matchAll(/uses:\s*([^\s#]+)/g)].map(
        (match) => match[1],
      );
      expect(actionRefs.length, `${name} action references`).toBeGreaterThan(0);

      for (const actionRef of actionRefs) {
        expect(actionRef, `${name}: ${actionRef}`).toMatch(
          /^[^@\s]+@[0-9a-f]{40}$/,
        );
      }
    }
  });

  it('builds and publishes both browser-extension archives', () => {
    expect(workflow).toMatch(/^\s{2}extension:\s*$/m);
    expect(workflow).toContain('npm run build:extension:chrome');
    expect(workflow).toContain('npm run build:extension:firefox');
    expect(workflow).toContain('OPTNWallet-${RELEASE_TAG}-chrome.zip');
    expect(workflow).toContain('OPTNWallet-${RELEASE_TAG}-firefox.zip');
    expect(workflow).toMatch(/needs:\s*\[android,\s*desktop,\s*extension\]/);
    expect(workflow).toMatch(/-name '\*\.zip'/);
    expect(workflow).toMatch(/release-files\/\*\.zip/);
    expect(workflow).toContain('Verify expected release files');
    expect(workflow).toContain("require_asset artifacts/browser-extensions '*.zip'");
    expect(extensionBuildConfig).toContain(
      "src/services/TransactionService.ts",
    );
    expect(extensionBuildConfig).toContain(
      "src/platform/extension/TransactionService.ts",
    );
    expect(extensionShell).toContain('<AppShell viewerOnly />');
  });

  it('ships signed and notarized native macOS bundles for Apple Silicon and Intel', () => {
    expect(workflow).toContain('platform: macos-latest');
    expect(workflow).toContain('target: aarch64-apple-darwin');
    expect(workflow).toContain('tor-target: macos-aarch64');
    expect(workflow).toContain('expected-arch: arm64');
    expect(workflow).toContain('platform: macos-15-intel');
    expect(workflow).toContain('target: x86_64-apple-darwin');
    expect(workflow).toContain('tor-target: macos-x86_64');
    expect(workflow).toContain('expected-arch: x86_64');
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('Verify macOS release credentials');
    expect(workflow).toContain('security set-key-partition-list');
    expect(workflow).toContain('APPLE_PASSWORD:');
    expect(workflow).not.toContain('APPLE_ID_PASSWORD:');
    expect(workflow).toContain('APPLE_SIGNING_IDENTITY=');
    expect(workflow).toContain('Verify signed and notarized macOS bundle');
    expect(workflow).toContain('codesign --verify --deep --strict');
    expect(workflow).toContain('spctl --assess --type execute');
    expect(workflow).toContain('hdiutil verify');
    expect(workflow).toContain('spctl --assess --type open');
    expect(workflow).toContain('xcrun stapler validate');
    expect(workflow).toContain('desktop-macos-intel');
    expect(workflow).toContain("require_asset artifacts/desktop-macos-arm '*.dmg'");
    expect(workflow).toContain("require_asset artifacts/desktop-macos-intel '*.dmg'");
  });

  it('builds both native macOS targets with matching Tor bundles before release', () => {
    expect(desktopPreviewWorkflow).toContain('platform: macos-latest');
    expect(desktopPreviewWorkflow).toContain('target: aarch64-apple-darwin');
    expect(desktopPreviewWorkflow).toContain('tor-target: macos-aarch64');
    expect(desktopPreviewWorkflow).toContain('platform: macos-15-intel');
    expect(desktopPreviewWorkflow).toContain('target: x86_64-apple-darwin');
    expect(desktopPreviewWorkflow).toContain('tor-target: macos-x86_64');
    expect(desktopPreviewWorkflow).toContain(
      'node scripts/fetch-tor.mjs ${{ matrix.tor-target }}',
    );
    expect(desktopPreviewWorkflow).toContain(
      'npx tauri build --debug --target ${{ matrix.target }}',
    );
    expect(desktopPreviewWorkflow).toContain(
      'src-tauri/target/${{ matrix.target }}/debug/bundle/**',
    );
  });
});

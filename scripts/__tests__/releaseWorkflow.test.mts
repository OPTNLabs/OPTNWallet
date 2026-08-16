import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'release.yml'),
  'utf8'
);
const desktopPreviewWorkflow = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'desktop-preview.yml'),
  'utf8'
);
const extensionBuildConfig = readFileSync(
  resolve(repoRoot, 'vite.extension.config.ts'),
  'utf8'
);
const extensionShell = readFileSync(
  resolve(repoRoot, 'src', 'platform', 'extension', 'ExtensionAppShell.tsx'),
  'utf8'
);

describe('release workflow', () => {
  it('pins every external action to an immutable full commit SHA', () => {
    for (const [name, contents] of [
      ['release', workflow],
      ['desktop preview', desktopPreviewWorkflow],
    ]) {
      const actionRefs = [...contents.matchAll(/uses:\s*([^\s#]+)/g)].map(
        (match) => match[1]
      );
      expect(actionRefs.length, `${name} action references`).toBeGreaterThan(0);

      for (const actionRef of actionRefs) {
        expect(actionRef, `${name}: ${actionRef}`).toMatch(
          /^[^@\s]+@[0-9a-f]{40}$/
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
    // What matters is that publish waits for every builder, so a release can
    // never be cut without the extension archives. Asserting the literal array
    // instead made this fail the moment publish gained a `resolve` dependency,
    // which is a change in the job graph, not a regression in what is shipped.
    const publishNeeds =
      workflow.match(/^ {2}publish:[\s\S]*?needs:\s*\[([^\]]+)\]/m)?.[1] ?? '';
    for (const builder of ['android', 'desktop', 'extension']) {
      expect(publishNeeds, 'publish job needs').toContain(builder);
    }
    expect(workflow).toMatch(/-name '\*\.zip'/);
    expect(workflow).toMatch(/release-files\/\*\.zip/);
    expect(workflow).toContain('Verify expected release files');
    expect(workflow).toContain(
      "require_asset artifacts/browser-extensions '*.zip'"
    );
    expect(extensionBuildConfig).toContain(
      'src/services/TransactionService.ts'
    );
    expect(extensionBuildConfig).toContain(
      'src/platform/extension/TransactionService.ts'
    );
    expect(extensionShell).toContain('<AppShell viewerOnly />');
  });

  it('ships native macOS bundles anonymously or signs and notarizes when credentials are available', () => {
    expect(workflow).toContain('platform: macos-latest');
    expect(workflow).toContain('target: aarch64-apple-darwin');
    expect(workflow).toContain('tor-target: macos-aarch64');
    expect(workflow).toContain('expected-arch: arm64');
    expect(workflow).toContain('platform: macos-15-intel');
    expect(workflow).toContain('target: x86_64-apple-darwin');
    expect(workflow).toContain('tor-target: macos-x86_64');
    expect(workflow).toContain('expected-arch: x86_64');
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('Detect optional macOS signing credentials');
    expect(workflow).toContain('MACOS_SIGNING_AVAILABLE=false');
    expect(workflow).toContain('APPLE_SIGNING_IDENTITY=-');
    expect(workflow).toContain('adhoc-not-notarized');
    expect(workflow).toContain('Build signed and notarized macOS bundles');
    expect(workflow).toContain(
      'Build ad-hoc-signed macOS bundles without an Apple account'
    );
    expect(workflow).toContain('security set-key-partition-list');
    expect(workflow).toContain('APPLE_PASSWORD:');
    expect(workflow).not.toContain('APPLE_ID_PASSWORD:');
    expect(workflow).toContain('APPLE_SIGNING_IDENTITY=');
    expect(workflow).toContain('Verify macOS bundle');
    expect(workflow).toContain('codesign --verify --deep --strict');
    expect(workflow).toContain('spctl --assess --type execute');
    expect(workflow).toContain('hdiutil verify');
    expect(workflow).toContain('spctl --assess --type open');
    expect(workflow).toContain('xcrun stapler validate');
    expect(workflow).toContain('desktop-macos-intel');
    expect(workflow).toContain(
      "require_asset artifacts/desktop-macos-arm '*.dmg'"
    );
    expect(workflow).toContain(
      "require_asset artifacts/desktop-macos-intel '*.dmg'"
    );
  });

  it('builds both native macOS targets with matching Tor bundles before release', () => {
    expect(desktopPreviewWorkflow).toContain('platform: macos-latest');
    expect(desktopPreviewWorkflow).toContain('target: aarch64-apple-darwin');
    expect(desktopPreviewWorkflow).toContain('tor-target: macos-aarch64');
    expect(desktopPreviewWorkflow).toContain('platform: macos-15-intel');
    expect(desktopPreviewWorkflow).toContain('target: x86_64-apple-darwin');
    expect(desktopPreviewWorkflow).toContain('tor-target: macos-x86_64');
    expect(desktopPreviewWorkflow).toContain(
      'npx --no-install tsx scripts/fetch-tor.mts ${{ matrix.tor-target }}'
    );
    expect(desktopPreviewWorkflow).toContain(
      'npx tauri build --debug --target ${{ matrix.target }}'
    );
    expect(desktopPreviewWorkflow).toContain(
      'src-tauri/target/${{ matrix.target }}/debug/bundle/**'
    );
  });

  it('allows Linux AppImage packaging to finish on uncached preview runners', () => {
    const previewTimeout = Number(
      desktopPreviewWorkflow.match(/timeout-minutes:\s*(\d+)/)?.[1] ?? 0
    );

    expect(previewTimeout).toBeGreaterThanOrEqual(60);
  });

  it('ships Linux x64 and ARM64 AppImages as the portable all-distro Linux path', () => {
    expect(workflow).toContain('target: x86_64-pc-windows-msvc');
    expect(workflow).toContain('target: x86_64-unknown-linux-gnu');
    expect(workflow).toContain('target: aarch64-unknown-linux-gnu');
    expect(workflow).toContain('tor-target: linux-x86_64');
    expect(workflow).toContain('tor-target: linux-aarch64');
    expect(workflow).toContain('platform: ubuntu-24.04-arm');
    expect(workflow).toContain('artifact-name: desktop-linux-arm');
    // AppImage is gated first — portable across distros, not just Ubuntu CI hosts.
    expect(workflow).toContain(
      "require_asset artifacts/desktop-linux '*.AppImage'"
    );
    expect(workflow).toContain(
      "require_asset artifacts/desktop-linux-arm '*.AppImage'"
    );
    expect(workflow).toMatch(
      /portable \.AppImage|all distros|AppImage \(portable/i
    );
    expect(desktopPreviewWorkflow).toContain('ubuntu-24.04-arm');
    expect(desktopPreviewWorkflow).toContain('linux-aarch64');
  });
});

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
const assetWorkflows = [
  'android-preview.yml',
  'cli-preview.yml',
  'desktop-preview.yml',
  'extension-preview.yml',
  'ios-preview.yml',
  'desktop-riscv64.yml',
].map((name) => ({
  name,
  contents: readFileSync(resolve(repoRoot, '.github', 'workflows', name), 'utf8'),
}));

const cliPreviewWorkflow = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'cli-preview.yml'),
  'utf8'
);
const flatpakManifest = readFileSync(
  resolve(repoRoot, 'packaging', 'flatpak', 'com.optilabs.wallet.yml'),
  'utf8'
);
const cargoToml = readFileSync(
  resolve(repoRoot, 'src-tauri', 'Cargo.toml'),
  'utf8'
);
const flatpakMetainfo = readFileSync(
  resolve(repoRoot, 'packaging', 'flatpak', 'com.optilabs.wallet.metainfo.xml'),
  'utf8'
);

/**
 * The jobs `publish` waits for.
 *
 * Extracted rather than matched inline: `publish:` also names an output of
 * the resolve job, so an unanchored pattern reads the wrong part of the file.
 */
function publishNeeds(): string {
  return (
    workflow.match(/^ {2}publish:[\s\S]*?needs:\s*\[([^\]]+)\]/m)?.[1] ?? ''
  );
}

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
    // The target reaches tauri through a shell variable now, because the
    // build is wrapped in a retry for the hdiutil "Resource busy" flake on
    // macOS. Assert the invocation and the wiring separately rather than
    // pinning the exact string, which broke the moment a retry was added.
    expect(desktopPreviewWorkflow).toContain('npx tauri build --debug --target');
    expect(desktopPreviewWorkflow).toContain('${{ matrix.target }}');
    // One artifact per format, not a catch-all over bundle/**. A single glob
    // uploaded whatever happened to exist, so a bundler that quietly stopped
    // emitting a format still produced a green artifact holding the others.
    for (const [dir, pattern] of [
      ['nsis', '*.exe'],
      ['msi', '*.msi'],
      ['dmg', '*.dmg'],
      ['appimage', '*.AppImage'],
      ['deb', '*.deb'],
      ['rpm', '*.rpm'],
    ] as const) {
      expect(desktopPreviewWorkflow).toContain(
        `src-tauri/target/\${{ matrix.target }}/debug/bundle/${dir}/${pattern}`
      );
    }
    expect(desktopPreviewWorkflow).toContain(
      'Verify every expected bundle was produced'
    );
    expect(desktopPreviewWorkflow).toContain('if-no-files-found: error');
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
  it('builds a Flatpak for both Linux architectures and blocks a release without one', () => {
    // Tauri has no Flatpak bundler target, so nothing else in the build would
    // notice if this job disappeared.
    expect(workflow).toMatch(/^\s{2}flatpak:\s*$/m);
    expect(workflow).toContain('deb-artifact: desktop-linux');
    expect(workflow).toContain('deb-artifact: desktop-linux-arm');

    // publish must wait for it, or a release is cut with the Flatpak missing.
    expect(publishNeeds(), 'publish job needs').toContain('flatpak');
    expect(workflow).toContain(
      "require_asset artifacts/flatpak-linux-x64 '*.flatpak'"
    );
    expect(workflow).toContain(
      "require_asset artifacts/flatpak-linux-arm64 '*.flatpak'"
    );
    expect(workflow).toContain(
      'expect "OPTNWallet-${VERSION}-linux-x64.flatpak"'
    );
    expect(workflow).toContain(
      'expect "OPTNWallet-${VERSION}-linux-arm64.flatpak"'
    );

    // Preview builds it too: a manifest that stops working should fail on the
    // pull request, not at release time.
    expect(desktopPreviewWorkflow).toMatch(/^\s{2}flatpak-preview:\s*$/m);
    expect(desktopPreviewWorkflow).toContain('preview-linux-x64-flatpak');
    expect(desktopPreviewWorkflow).toContain('preview-linux-arm64-flatpak');
  });

  it('pins a GNOME runtime that is still supported', () => {
    const pinned = flatpakManifest.match(/^runtime-version: *'?(\d+)'?/m);
    expect(pinned, 'the manifest must pin a runtime version').not.toBeNull();

    // GNOME 48 reached end of life on 24 March 2026. An EOL runtime still
    // builds and still runs; it just stops getting security fixes, which is
    // precisely why nothing else catches it.
    expect(Number(pinned![1])).toBeGreaterThanOrEqual(49);
  });

  it('names the Flatpak metadata for the application id', () => {
    // Flatpak resolves the desktop file, the icons and the AppStream data by
    // application id. Tauri names them after the product instead, so a
    // mismatch ships an application with no icon and no name in a software
    // centre — visible only after installing it.
    const id = 'com.optilabs.wallet';
    expect(flatpakManifest).toContain(`id: ${id}`);
    expect(flatpakMetainfo).toContain(`<id>${id}</id>`);
    expect(flatpakMetainfo).toContain(
      `<launchable type="desktop-id">${id}.desktop</launchable>`
    );
    expect(flatpakManifest).toContain(`/app/share/applications/${id}.desktop`);
    expect(flatpakManifest).toContain(`/app/share/metainfo/${id}.metainfo.xml`);

    // The command has to be the binary the deb actually installs. Tauri's
    // deb bundler names the binary after the Cargo package and the package
    // after productName; those differ here, and a manifest following the
    // product name produces a Flatpak that installs and cannot launch.
    expect(flatpakManifest).toMatch(/^command: optn-wallet-desktop$/m);
    expect(flatpakManifest).toContain('/app/bin/optn-wallet-desktop');
    const cargoBinary = cargoToml.match(/^name = "([^"]+)"/m);
    expect(cargoBinary, 'src-tauri/Cargo.toml package name').not.toBeNull();
    expect(flatpakManifest).toContain(`command: ${cargoBinary![1]}`);
  });

  it('asserts the desktop preview produced every artifact', () => {
    // if-no-files-found catches a bundler that made nothing. It cannot catch a
    // job that never ran, which is how a platform stops being built quietly.
    expect(desktopPreviewWorkflow).toMatch(/^\s{2}preview-complete:\s*$/m);
    for (const artifact of [
      'preview-windows-x64-nsis',
      'preview-windows-x64-msi',
      'preview-macos-arm64-dmg',
      'preview-macos-x64-dmg',
      'preview-linux-x64-appimage',
      'preview-linux-arm64-appimage',
      'preview-linux-x64-deb',
      'preview-linux-arm64-deb',
      'preview-linux-x64-rpm',
      'preview-linux-arm64-rpm',
      'preview-linux-x64-flatpak',
      'preview-linux-arm64-flatpak',
    ]) {
      expect(desktopPreviewWorkflow, `${artifact} must be asserted`).toContain(
        `expect ${artifact}`
      );
    }
    // always(), or a failed build skips the check and hides what is missing.
    expect(desktopPreviewWorkflow).toMatch(
      /preview-complete:[\s\S]*?if: always\(\)/
    );
  });
  it('ships the optn CLI for every target it supports', () => {
    // The CLI had a preview workflow and no release job at all, so it built on
    // every pull request and shipped to nobody.
    expect(workflow).toMatch(/^\s{2}cli:\s*$/m);
    for (const target of [
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'riscv64gc-unknown-linux-gnu',
      'armv7-unknown-linux-gnueabihf',
      'x86_64-pc-windows-msvc',
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
    ]) {
      expect(workflow, `CLI target ${target}`).toContain(`target: ${target}`);
    }
    // publish must wait for it, or a release is cut without the CLI.
    expect(publishNeeds(), 'publish job needs').toContain('cli');
  });

  it('arms the CLI requirement from a probe rather than from the artifacts', () => {
    // The crate lands in a separate pull request. Requiring binaries no branch
    // can build breaks one merge order; building binaries nothing requires
    // breaks the other. The probe makes both work — and keeps "no CLI in this
    // tree" distinguishable from "the CLI failed to build", which is the whole
    // point of the no-drop check.
    expect(workflow).toMatch(/^\s{2}cli-probe:\s*$/m);
    expect(workflow).toContain('if [ -f crates/optn-cli/Cargo.toml ]; then');
    expect(workflow).toContain(
      'needs.cli-probe.outputs.present }}" = \'true\''
    );
    expect(workflow).toContain("require_asset \"artifacts/cli-$label\"");
  });

  it('verifies each cross-built CLI binary is the architecture it claims', () => {
    // A misconfigured linker silently emits a host binary, which would ship
    // labelled riscv64 and fail to start on the only machines that need it.
    expect(workflow).toContain("riscv64gc-*) file \"$SRC\" | grep -q 'RISC-V'");
    expect(workflow).toContain("armv7-*)     file \"$SRC\" | grep -q 'ARM'");
  });
  it('builds the CLI in preview for every target the release ships', () => {
    // The release matrix and the preview matrix must agree, or a target is
    // published without ever having been built on a pull request.
    for (const target of [
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'riscv64gc-unknown-linux-gnu',
      'armv7-unknown-linux-gnueabihf',
      'x86_64-pc-windows-msvc',
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
    ]) {
      expect(cliPreviewWorkflow, `preview target ${target}`).toContain(
        `target: ${target}`
      );
      expect(workflow, `release target ${target}`).toContain(
        `target: ${target}`
      );
    }
  });

  it('runs the CLI preview always, not only when the crate is touched', () => {
    // A path-filtered required check never runs on a branch that does not
    // touch that path, and stays "Expected" forever. The probe is what makes
    // always-on cheap.
    expect(cliPreviewWorkflow).toMatch(/^\s{2}probe:\s*$/m);
    expect(cliPreviewWorkflow).toContain('if [ -f crates/optn-cli/Cargo.toml ]; then');
    // No path filter at all: a path-filtered required check never runs on a
    // branch that does not touch that path, and stays "Expected" forever.
    expect(cliPreviewWorkflow).not.toContain('paths:');
  });

  it('asserts the CLI preview produced every target', () => {
    expect(cliPreviewWorkflow).toMatch(/^\s{2}complete:\s*$/m);
    for (const label of [
      'linux-x64',
      'linux-arm64',
      'linux-riscv64',
      'linux-armv7',
      'windows-x64',
      'macos-arm64',
      'macos-x64',
    ]) {
      expect(cliPreviewWorkflow, `${label} must be asserted`).toContain(label);
    }
    expect(cliPreviewWorkflow).toMatch(/complete:[\s\S]*?if: always\(\)/);
  });
  it('runs every asset check on pull requests to main as well', () => {
    // main is where releases are cut from. A pull request straight to it was
    // the one path that reached a release without any of these checks: the
    // previews listened on dev and staging only, and riscv64 on dev alone.
    for (const { name, contents } of assetWorkflows) {
      const trigger = contents.match(
        /pull_request:[\s\S]*?branches: \[([^\]]+)\]/
      );
      expect(trigger, `${name} should filter pull_request branches`).not.toBeNull();

      const branches = trigger![1].split(',').map((b) => b.trim());
      for (const branch of ['dev', 'staging', 'main']) {
        expect(branches, `${name} must run for ${branch}`).toContain(branch);
      }
    }
  });
});

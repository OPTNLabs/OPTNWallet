import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  contents: readFileSync(
    resolve(repoRoot, '.github', 'workflows', name),
    'utf8'
  ),
}));

const releaseAssets = readFileSync(
  resolve(repoRoot, 'packaging', 'release-assets.json'),
  'utf8'
);
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
  describe('Android instrumentation guard', () => {
    const android = assetWorkflows.find(
      ({ name }) => name === 'android-preview.yml'
    )!.contents;
    const run = android.match(
      /^ {12}run_instrumentation\(\) \{[\s\S]*?^ {12}\}/m
    )?.[0];
    const method = 'useAppContext';
    // Git for Windows supplies Bash; derive its location from the installed Git.
    const bash =
      process.env.BASH ||
      (process.platform === 'win32'
        ? resolve(
            execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
            '../../../bin/bash.exe'
          )
        : 'bash');
    // Replay the AndroidJUnitRunner transcript from CI run 34218705281,
    // with only the GitHub step/timestamp prefix removed.
    const status = (code: number, total = 1) =>
      `INSTRUMENTATION_STATUS: class=com.getcapacitor.myapp.ExampleInstrumentedTest\n` +
      `INSTRUMENTATION_STATUS: current=1\nINSTRUMENTATION_STATUS: id=AndroidJUnitRunner\n` +
      `INSTRUMENTATION_STATUS: numtests=${total}\n` +
      `INSTRUMENTATION_STATUS: stream=${code === 1 ? '\ncom.getcapacitor.myapp.ExampleInstrumentedTest:' : '.'}\n` +
      `INSTRUMENTATION_STATUS: test=${method}\n` +
      `INSTRUMENTATION_STATUS_CODE: ${code}\n`;
    const finish = (count: number) =>
      `INSTRUMENTATION_RESULT: stream=\n\nTime: 0.072\n\nOK (${count} test${count === 1 ? '' : 's'})\n\n\nINSTRUMENTATION_CODE: -1\n`;
    const passed = status(1) + status(0) + finish(1);
    const cases: [string, string, boolean, number?][] = [
      ['captured CI success', passed, true],
      ['CRLF', passed.replaceAll('\n', '\r\n'), true],
      [
        'assumption does not prove the milestone',
        status(1) + status(-4) + finish(1),
        false,
      ],
      [
        'ignored alongside an executed test',
        status(1, 2) + status(-3, 2) + status(1, 2) + status(0, 2) + finish(1),
        false,
      ],
      [
        'assertion failure with runner success',
        status(1) + status(-2) + finish(1),
        false,
      ],
      [
        'test error with runner success',
        status(1) + status(-1) + finish(1),
        false,
      ],
      ['unknown status', status(1) + status(-5) + finish(1), false],
      ['unknown positive status', status(1) + status(2) + finish(1), false],
      ['zero tests', finish(0), false],
      ['only ignored tests', status(1) + status(-3) + finish(0), false],
      ['runner code alone', 'INSTRUMENTATION_CODE: -1\n', false],
      [
        'no JUnit summary',
        status(1) + status(0) + 'INSTRUMENTATION_CODE: -1\n',
        false,
      ],
      ['no terminal status', status(1) + finish(1), false],
      ['no start status', status(0) + finish(1), false],
      ['missing expected test', status(1, 2) + status(0, 2) + finish(1), false],
      ['JUnit count mismatch', status(1) + status(0) + finish(2), false],
      ['wrong method', passed.replaceAll(method, 'otherTest'), false],
      [
        'wrong class',
        passed.replaceAll('ExampleInstrumentedTest', 'OtherTest'),
        false,
      ],
      ['duplicate successful test', status(1) + status(0) + passed, false],
      ['JUnit failure', passed + 'FAILURES!!!\n', false],
      [
        'missing count',
        passed.replaceAll('INSTRUMENTATION_STATUS: numtests=1\n', ''),
        false,
      ],
      [
        'runner failure',
        passed + 'INSTRUMENTATION_FAILED: runner crashed\n',
        false,
      ],
      [
        'runner shortMsg',
        passed + 'INSTRUMENTATION_RESULT: shortMsg=Process crashed\n',
        false,
      ],
      [
        'cancelled runner',
        passed.replace('INSTRUMENTATION_CODE: -1', 'INSTRUMENTATION_CODE: 0'),
        false,
      ],
      [
        'missing final code',
        passed.replace('INSTRUMENTATION_CODE: -1\n', ''),
        false,
      ],
      ['duplicate final code', passed + 'INSTRUMENTATION_CODE: -1\n', false],
      ['adb failure after complete output', passed, false, 1],
      ['adb timeout after complete output', passed, false, 124],
    ];
    it.each(cases)('%s', (name, input, expected, adbExit = 0) => {
      expect(run).toBeTruthy();
      const directory = mkdtempSync(resolve(tmpdir(), 'optn-instrumentation-'));
      try {
        const result = spawnSync(
          bash,
          [
            '-c',
            `set -euo pipefail\ntimeout() { cat; return "$MOCK_ADB_EXIT"; }\nadb_with_timeout() { :; }\nflavour=test\nemulator_serial=test\n${run}\nrun_instrumentation ${method}`,
          ],
          {
            cwd: repoRoot,
            input,
            encoding: 'utf8',
            timeout: 5_000,
            env: {
              ...process.env,
              RUNNER_TEMP: directory,
              MOCK_ADB_EXIT: String(adbExit),
            },
          }
        );
        expect(result.error, name).toBeUndefined();
        expect(result.status === 0, `${name}: ${result.stderr}`).toBe(expected);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

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

  it('pins AppImage tooling to immutable release asset IDs', () => {
    expect(desktopPreviewWorkflow).not.toContain(
      '/releases/download/continuous/'
    );
    expect(desktopPreviewWorkflow).toContain(
      '/releases/assets/$appimage_plugin_asset_id'
    );
    expect(desktopPreviewWorkflow).toContain(
      "--header 'Accept: application/octet-stream'"
    );
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
    expect(desktopPreviewWorkflow).toContain(
      'npx tauri build --debug --target'
    );
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

  it('adds a locked Leptos macOS build without replacing legacy targets or Tor checks', () => {
    const matrix =
      desktopPreviewWorkflow.match(
        /matrix:\s*\n([\s\S]*?)\n    runs-on:/
      )?.[1] ?? '';
    const rows = matrix.split(/- platform: /).slice(1);
    expect(rows).toHaveLength(6);
    for (const label of [
      'windows-x64',
      'macos-arm64',
      'macos-x64',
      'linux-x64',
      'linux-arm64',
    ]) {
      const row = rows.find(
        (value) =>
          value.includes(`label: ${label}\n`) ||
          value.includes(`label: ${label}\r\n`)
      );
      expect(row, label).toBeDefined();
      expect(row).not.toContain('renderer: leptos');
    }
    const leptos = rows.find((row) =>
      row.includes('label: macos-arm64-leptos')
    );
    expect(leptos).toContain('macos-latest');
    expect(leptos).toContain('target: aarch64-apple-darwin');
    expect(leptos).toContain(
      'rust-targets: aarch64-apple-darwin,wasm32-unknown-unknown'
    );
    expect(leptos).toContain('tor-target: macos-aarch64');
    expect(leptos).toContain('renderer: leptos');
    expect(desktopPreviewWorkflow).toContain(
      'targets: ${{ matrix.rust-targets || matrix.target }}'
    );
    expect(desktopPreviewWorkflow).toContain('toolchain: 1.98.0');
    expect(desktopPreviewWorkflow).toContain(
      'cargo install trunk --version 0.21.14 --locked'
    );
    expect(desktopPreviewWorkflow).toContain(
      '--config src-tauri/tauri.leptos.conf.json --config "$resources_config" -- --locked'
    );
    expect(desktopPreviewWorkflow).toContain(
      'codesign --force --timestamp=none --sign - "$f"'
    );
    expect(desktopPreviewWorkflow).toContain(
      'bash scripts/verify-macos-bundle.sh "$APP_PATH"'
    );
    expect(desktopPreviewWorkflow).not.toMatch(/^\s*continue-on-error:/m);

    const base = JSON.parse(
      readFileSync(resolve(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8')
    );
    const overlay = JSON.parse(
      readFileSync(
        resolve(repoRoot, 'src-tauri/tauri.leptos.conf.json'),
        'utf8'
      )
    );
    expect(base.bundle.resources).toContain('resources/tor/*');
    // Compile-only jobs do not fetch Tor. The package build restores exactly
    // the canonical resource list via its final Tauri config override.
    expect(overlay.bundle.resources).toEqual([]);
    const resourceScript = desktopPreviewWorkflow.match(
      /resources_config="\$\(node -e '([^']+)'\)"/
    )?.[1];
    expect(resourceScript).toBeTruthy();
    const packageOverlay = JSON.parse(
      execFileSync(process.execPath, ['-e', resourceScript!], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
    );
    expect(packageOverlay).toEqual({
      bundle: { resources: base.bundle.resources },
    });
    expect(overlay.build.beforeBuildCommand).toContain(
      'trunk build --release --locked --config Trunk.tauri.toml'
    );
    expect(overlay.build.frontendDist).toBe('../crates/optn-ui/dist');
    expect(desktopPreviewWorkflow).toContain(
      'checkout_sha="$(git rev-parse HEAD)"'
    );
    expect(desktopPreviewWorkflow).toContain(
      'PR_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'
    );
    for (const file of ['build-info.txt', 'SHA256SUMS']) {
      expect(desktopPreviewWorkflow).toContain(
        `src-tauri/target/\${{ matrix.target }}/debug/bundle/dmg/${file}`
      );
    }
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
    // Now declared in packaging/release-assets.json, which the workflow
    // generates its checks from.
    expect(releaseAssets).toContain('OPTNWallet-${VERSION}-linux-x64.flatpak');
    expect(releaseAssets).toContain(
      'OPTNWallet-${VERSION}-linux-arm64.flatpak'
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
      'preview-macos-arm64-leptos-dmg',
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
    //
    // Asserted as a property rather than as a job name: the probe used to be
    // a job of its own and now lives in `resolve`, which already runs first
    // and already checks out, so it costs nothing there. What must stay true
    // is that the requirement is armed by looking for the crate, and never by
    // looking at which artifacts happen to have been produced -- an artifact
    // listing cannot tell a failed build from a crate that was never here.
    expect(workflow).toContain('if [ -f crates/optn-cli/Cargo.toml ]; then');
    expect(workflow).toMatch(
      /cli_present: \x24\x7b\x7b steps\.\w+\.outputs\.present \x7d\x7d/
    );
    expect(workflow).toContain(
      "needs.resolve.outputs.cli_present }}\" = 'true'"
    );
    expect(workflow).toContain('require_asset "artifacts/cli-$label"');
  });

  it('verifies each cross-built CLI binary is the architecture it claims', () => {
    // A misconfigured linker silently emits a host binary, which would ship
    // labelled riscv64 and fail to start on the only machines that need it.
    expect(workflow).toContain('riscv64gc-*) file "$SRC" | grep -q \'RISC-V\'');
    expect(workflow).toContain('armv7-*)     file "$SRC" | grep -q \'ARM\'');
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
    expect(cliPreviewWorkflow).toContain(
      'if [ -f crates/optn-cli/Cargo.toml ]; then'
    );
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
      expect(
        trigger,
        `${name} should filter pull_request branches`
      ).not.toBeNull();

      const branches = trigger![1].split(',').map((b) => b.trim());
      for (const branch of ['dev', 'staging', 'main']) {
        expect(branches, `${name} must run for ${branch}`).toContain(branch);
      }
    }
  });
  it('keeps the desktop RISC-V build always-on and blocking', () => {
    const riscv = assetWorkflows.find(
      ({ name }) => name === 'desktop-riscv64.yml'
    )!.contents;
    expect(riscv).not.toMatch(/^\s*(?:paths|paths-ignore|continue-on-error):/m);
    expect(riscv).toContain('targets: riscv64gc-unknown-linux-gnu');
    expect(riscv).toContain('if-no-files-found: error');
  });

  it('exercises wallet creation, lock and reopen in an isolated native profile', () => {
    const e2e = readFileSync(
      resolve(repoRoot, '.github/workflows/desktop-e2e.yml'),
      'utf8'
    );
    const lifecycle = readFileSync(
      resolve(repoRoot, 'scripts/run-e2e-lifecycle.mjs'),
      'utf8'
    );
    expect(e2e).toContain('npm run test:e2e:lifecycle');
    expect(e2e.indexOf('npm run test:e2e:lifecycle')).toBeGreaterThan(
      e2e.indexOf('npx tauri build --debug --no-bundle')
    );
    expect(lifecycle).toContain('mkdtempSync');
    expect(lifecycle).toContain(
      'environment.XDG_DATA_HOME = temporaryDataHome'
    );
    expect(lifecycle).toContain("environment.TAURI_E2E_ALLOW_MUTATION = '1'");
  });
  it('drives the asset checks from one config, with a loud opt-out', () => {
    // The list of what ships and the check that it shipped are generated from
    // the same file, so they cannot drift. Two hand-maintained lists would,
    // and the half that drifts silently is the one that stops rejecting.
    const config = JSON.parse(releaseAssets) as {
      assets: {
        label: string;
        pattern: string;
        required?: boolean;
        reason?: string;
      }[];
    };
    expect(config.assets.length).toBeGreaterThan(20);

    // The general rule: everything ships. required:false is the niche case and
    // must carry a reason, so a waiver nobody reverted is visible in review
    // rather than silent.
    for (const asset of config.assets) {
      if (asset.required === false) {
        expect(
          asset.reason,
          `${asset.label} is waived with no reason`
        ).toBeTruthy();
      }
    }

    expect(workflow).toContain('packaging/release-assets.json');
    expect(workflow).toMatch(/name: Assets completeness/);
    // A waiver has to announce itself in the run.
    expect(workflow).toContain('is waived in packaging/release-assets.json');
  });
});

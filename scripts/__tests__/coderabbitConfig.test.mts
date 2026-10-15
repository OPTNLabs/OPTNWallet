import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = parse(
  readFileSync(resolve(repoRoot, '.coderabbit.yaml'), 'utf8')
);
const filters: string[] = config.reviews.path_filters;

// CodeRabbit: includes restrict scope; any matching exclusion wins.
// https://docs.coderabbit.ai/configuration/path-instructions
// Test repository filters, not the hosted service's separate default ignores.
function eligible(path: string): boolean {
  const includes = filters.filter((pattern) => !pattern.startsWith('!'));
  const excludes = filters.filter((pattern) => pattern.startsWith('!'));
  const matches = (pattern: string) =>
    minimatch(path, pattern, { dot: true, nocase: true });
  return (
    (includes.length === 0 || includes.some(matches)) &&
    !excludes.some((pattern) => matches(pattern.slice(1)))
  );
}

describe('CodeRabbit review coverage', () => {
  it('keeps wallet sources, tests, manifests and build/security scripts eligible', () => {
    for (const path of [
      'Cargo.toml',
      'crates/optn-app/src/lock.rs',
      'crates/optn-chain-bip37/src/merkleblock.rs',
      'crates/optn-runtime/src/sync_worker/historical.rs',
      'crates/optn-runtime/src/sync_worker/historical/tests.rs',
      'crates/optn-runtime/Cargo.toml',
      'crates/optn-cli/tests/shv_regtest.rs',
      'crates/optn-core/tests/fixtures/legacy-wallet-v1.unlock.json',
      'crates/optn-fusion/build.rs',
      'xtask/src/main.rs',
      'fuzz/fuzz_targets/descriptor_parse.rs',
      'src-tauri/src/spv/merkleblock.rs',
      'src-tauri/Cargo.toml',
      'src-tauri/build.rs',
      'src-tauri/tauri.conf.json',
      'src-tauri/capabilities/default.json',
      'android/app/src/main/java/optn/wallet/app/security/SecureKeyStorePlugin.java',
      'android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java',
      'android/app/src/main/AndroidManifest.xml',
      'android/app/build.gradle',
      'android/gradle/wrapper/gradle-wrapper.properties',
      'ios/App/App/AppDelegate.swift',
      'ios/App/App/Info.plist',
      'ios/App/App.xcodeproj/project.pbxproj',
      'ios/App/Podfile',
      'apple/OPTNAppleProvider/Package.swift',
      'apple/OPTNAppleProvider/Sources/OPTNAppleProvider/AppleSecureEnclave.swift',
      'apple/OPTNAppleProvider/Tests/OPTNAppleProviderTests/ApplePlatformProviderTests.swift',
      'src/features/home/Home.tsx',
      'src/services/__tests__/Bip39Service.test.ts',
      'src/platform/desktop/__tests__/fixtures/serverFusionRound.chipnet.json',
      'src/services/generatedAddressPolicy.ts',
      'scripts/fetch-tor.mts',
      'scripts/__tests__/fetchTor.test.mts',
      'scripts/__tests__/releaseWorkflow.test.mts',
      'scripts/__tests__/dependencySecurity.test.mts',
      'scripts/__tests__/lockfileFreshness.test.mts',
      'scripts/check-dependencies.mjs',
      'scripts/verify-release-completeness.sh',
      'scripts/verify-preview-completeness.py',
      'patches/@capacitor+android+7.6.9.patch',
      'packaging/fdroid/com.optilabs.wallet.yml',
      'package.json',
      '.github/workflows/lockfile-freshness.yml',
      '.coderabbit.yaml',
    ]) {
      expect(eligible(path), path).toBe(true);
    }
  });

  it('excludes precise dependency, generated, binary and lockfile noise', () => {
    expect(filters.every((pattern) => pattern.startsWith('!'))).toBe(true);
    for (const path of [
      'node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js',
      'vendor/tool/node_modules/tool/index.js',
      'target/debug/build/output.rs',
      'crates/optn-core/target/debug/build/output.rs',
      'src-tauri/target/release/output',
      'target-frozen/debug/output',
      'dist/assets/index.js',
      'dist-ssr/index.js',
      'dist-extension-chrome/assets/index.js',
      'dist-extension-firefox/assets/index.js',
      'coverage/index.html',
      'android/.gradle/cache.bin',
      'android/build/generated/output.java',
      'android/app/build/generated/output.java',
      'ios/App/build/output.swift',
      'ios/App/Pods/Dependency/source.swift',
      'apple/OPTNAppleProvider/.build/output.swift',
      'apple/OPTNAppleProvider/.swiftpm/cache.json',
      'src/wasm/optn-core/generated/optn_core.js',
      'src/platform/web/secp256k1WasmBase64.generated.ts',
      'Cargo.lock',
      'crates/optn-cli/Cargo.lock',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lock',
      'bun.lockb',
      'ios/App/Podfile.lock',
      'apple/OPTNAppleProvider/Package.resolved',
      'android/gradle.lockfile',
      'src/assets/logo.svg',
      'android/app/src/main/res/drawable/splash.png',
      'android/gradle/wrapper/gradle-wrapper.jar',
      'src/wasm/optn-core/generated/optn_core_bg.wasm',
      'src/__snapshots__/wallet.test.ts.snap',
    ]) {
      expect(eligible(path), path).toBe(false);
    }
  });

  it('preserves the existing review policy without enabling automated approval', () => {
    const { path_filters: _filters, ...reviews } = config.reviews;
    expect({ ...config, reviews }).toEqual({
      language: 'en-US',
      reviews: {
        profile: 'chill',
        request_changes_workflow: false,
        review_status: true,
        high_level_summary: true,
        auto_review: {
          enabled: true,
          drafts: true,
          base_branches: ['dev', 'main', 'master', 'release/.*'],
        },
      },
    });
  });
});

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const recipe = parse(
  readFileSync(
    resolve(repoRoot, 'packaging', 'fdroid', 'com.optilabs.wallet.yml'),
    'utf8'
  )
) as {
  License: string;
  Builds: Array<{
    versionName: string;
    versionCode: number;
    commit: string;
    gradle: string[];
    output: string;
    prebuild?: string[];
  }>;
  CurrentVersion: string;
  CurrentVersionCode: number;
  AntiFeatures?: string[];
};
const gradle = readFileSync(
  resolve(repoRoot, 'android', 'app', 'build.gradle'),
  'utf8'
);

const build = recipe.Builds[0];

describe('F-Droid build recipe', () => {
  it('matches the version the Android build actually produces', () => {
    // The recipe is submitted to a repository we do not control. A drifted
    // version there means F-Droid builds a tag that does not exist, or
    // publishes something numbered differently from what we released — and
    // nobody here would see it happen.
    const versionCode = gradle.match(/versionCode\s+(\d+)/);
    const versionName = gradle.match(/versionName\s+"([^"]+)"/);
    expect(versionCode, 'versionCode in build.gradle').not.toBeNull();
    expect(versionName, 'versionName in build.gradle').not.toBeNull();

    expect(build.versionCode).toBe(Number(versionCode![1]));
    expect(build.versionName).toBe(versionName![1]);
    expect(recipe.CurrentVersion).toBe(versionName![1]);
    expect(recipe.CurrentVersionCode).toBe(Number(versionCode![1]));
    expect(build.commit).toBe(`v${versionName![1]}`);
  });

  it('builds the fdroid flavour, never the Play default', () => {
    // `play` is isDefault in build.gradle. A recipe that omits the flavour
    // builds that one, which links Play In-App Updates — the exact dependency
    // the flavour split exists to avoid.
    expect(build.gradle).toEqual(['fdroid']);
    expect(build.output).toContain('/fdroid/release/');
    expect(build.output).not.toContain('/play/');
  });

  it('names an output path the Gradle rename rule produces', () => {
    // build.gradle renames every APK to
    // optn-wallet-<versionName>-<flavour>-<buildType>.apk. If that rule
    // changes, F-Droid finds no APK where the recipe says one will be.
    expect(gradle).toContain(
      'optn-wallet-${variant.versionName}-${variant.flavorName}-${variant.buildType.name}.apk'
    );
    expect(build.output).toContain('optn-wallet-$$VERSION$$-fdroid-release.apk');
  });

  it('builds the web bundle before Gradle, as a Capacitor app must', () => {
    // The Android project is a shell around a web bundle. Without these the
    // APK builds and ships an empty WebView.
    const prebuild = (build.prebuild ?? []).join('\n');
    expect(prebuild).toContain('npm ci');
    expect(prebuild).toContain('build:web');
    expect(prebuild).toContain('cap sync android');
  });

  it('declares the licence F-Droid will publish it under', () => {
    expect(recipe.License).toBe('GPL-3.0-or-later');
  });

  it('does not silently carry an unreviewed anti-feature list', () => {
    // NonFreeNet is an open question recorded in packaging/fdroid/README.md.
    // This asserts only that anything declared is a known F-Droid value, so a
    // typo cannot slip into a submission.
    const known = [
      'Ads',
      'Tracking',
      'NonFreeNet',
      'NonFreeAdd',
      'NonFreeDep',
      'NonFreeAssets',
      'UpstreamNonFree',
      'NoSourceSince',
      'DisabledAlgorithm',
      'KnownVuln',
      'ApplicationDebuggable',
    ];
    for (const flag of recipe.AntiFeatures ?? []) {
      expect(known, `${flag} is not an F-Droid anti-feature`).toContain(flag);
    }
  });
});

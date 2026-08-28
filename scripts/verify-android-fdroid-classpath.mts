// Flavor-gate: fdroid runtime classpaths must not ship Play Core app-update.
// Play/default keeps it so Play builds can still in-app update.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const ANDROID = resolve(ROOT, 'android');
const APP_UPDATE = 'com.google.android.play:app-update';
const FDROID_CONFIGS = [
  'fdroidDebugRuntimeClasspath',
  'fdroidReleaseRuntimeClasspath',
];
const PLAY_CONFIGS = [
  'playDebugRuntimeClasspath',
  'playReleaseRuntimeClasspath',
];

function fail(message: string): never {
  console.error(`[verify-android-fdroid-classpath] ERROR: ${message}`);
  process.exit(1);
}

function gradleWrapper(): string {
  const name = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const path = resolve(ANDROID, name);
  if (!existsSync(path)) fail(`Missing ${path}`);
  return path;
}

function dependenciesFor(configuration: string): string {
  const result = spawnSync(
    gradleWrapper(),
    [':app:dependencies', '--configuration', configuration],
    {
      cwd: ANDROID,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    console.error(output);
    fail(
      `Gradle :app:dependencies --configuration ${configuration} failed (exit ${result.status})`
    );
  }
  return output;
}

function hasAppUpdate(output: string): boolean {
  return output.includes(APP_UPDATE);
}

function main() {
  console.log(
    '[verify-android-fdroid-classpath] Resolving flavor runtime classpaths...'
  );

  for (const configuration of FDROID_CONFIGS) {
    const output = dependenciesFor(configuration);
    if (hasAppUpdate(output)) {
      const matches = output
        .split(/\r?\n/)
        .filter((line) => line.includes(APP_UPDATE));
      console.error(matches.join('\n'));
      fail(`${configuration} contains ${APP_UPDATE}`);
    }
    console.log(
      `[verify-android-fdroid-classpath] ${configuration}: OK (no ${APP_UPDATE})`
    );
  }

  for (const configuration of PLAY_CONFIGS) {
    const output = dependenciesFor(configuration);
    if (!hasAppUpdate(output)) {
      fail(`${configuration} is missing ${APP_UPDATE}`);
    }
    const match = output
      .split(/\r?\n/)
      .find((line) => line.includes(APP_UPDATE));
    console.log(
      `[verify-android-fdroid-classpath] ${configuration}: OK (${match?.trim() ?? APP_UPDATE})`
    );
  }

  console.log('[verify-android-fdroid-classpath] Flavor gate passed.');
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

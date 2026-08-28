// F-Droid gate for the Android build.
//
// Two things are checked, because F-Droid's bar is the whole dependency graph
// and not just the one library that started this:
//
//   1. The fdroid classpath must not carry Play Core app-update, and the play
//      classpath must still carry it, so Play users keep in-app updates.
//   2. Every artifact on the fdroid classpath must be a group we have decided
//      is free software. An allowlist rather than a blocklist: a blocklist only
//      catches the proprietary dependencies someone already thought of, and the
//      failure mode here is a new transitive dependency nobody reviewed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.cwd());
const ANDROID = resolve(ROOT, 'android');
const APP_UPDATE = 'com.google.android.play:app-update';

/**
 * Maven groups permitted on the F-Droid classpath.
 *
 * Each is free software under a licence F-Droid accepts:
 *   androidx.*, com.google.android.material  Apache-2.0 (AOSP / Jetpack)
 *   com.google.code.gson                     Apache-2.0
 *   com.google.zxing                         Apache-2.0
 *   com.google.guava, .errorprone, .j2objc   Apache-2.0
 *   org.jetbrains.*                          Apache-2.0
 *   io.ionic.libs, com.capacitorjs           MIT
 *   org.chromium.net (cronet-embedded)       BSD-3-Clause
 *   org.checkerframework                     MIT
 *
 * Deliberately absent: com.google.mlkit and com.google.android.gms. Both are
 * proprietary; see the exclusion in android/app/build.gradle.
 *
 * Adding a group here is a decision that it is free software. Make it
 * consciously — that is the point of the list.
 */
export const ALLOWED_GROUPS = [
  'androidx',
  'com.capacitorjs',
  'com.google.android.material',
  'com.google.code.findbugs',
  'com.google.code.gson',
  'com.google.errorprone',
  'com.google.guava',
  'com.google.j2objc',
  'com.google.zxing',
  'io.ionic.libs',
  'org.checkerframework',
  'org.chromium.net',
  'org.jetbrains',
  'org.jspecify',
];

/** `+--- group:artifact:version` and its many box-drawing variants. */
const COORDINATE = /([A-Za-z][\w.-]*(?:\.[\w-]+)+):([\w.-]+):/g;
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

/** Maven groups appearing in a `gradle :app:dependencies` tree. */
export function groupsIn(output: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const line of output.split(/\r?\n/)) {
    // Project dependencies (`project :capacitor-android`) are our own source.
    if (line.includes('--- project ')) continue;
    for (const match of line.matchAll(COORDINATE)) {
      const [, group, artifact] = match;
      const existing = found.get(group) ?? new Set<string>();
      existing.add(`${group}:${artifact}`);
      found.set(group, existing);
    }
  }
  return found;
}

export function isAllowed(group: string): boolean {
  return ALLOWED_GROUPS.some(
    (allowed) => group === allowed || group.startsWith(`${allowed}.`)
  );
}

/**
 * Fail on any artifact whose group has not been reviewed.
 *
 * F-Droid rejects a build for a single proprietary dependency anywhere in the
 * graph, and a transitive one arrives without anyone choosing it.
 */
function auditGraph(configuration: string, output: string): void {
  const groups = groupsIn(output);
  if (groups.size === 0) {
    fail(
      `${configuration} resolved no dependency coordinates; the output format ` +
        'probably changed and this check is no longer reading anything'
    );
  }

  const unreviewed = [...groups.entries()].filter(([g]) => !isAllowed(g));
  if (unreviewed.length > 0) {
    console.error(
      `[verify-android-fdroid-classpath] ${configuration} contains groups that ` +
        'have not been reviewed for F-Droid:'
    );
    for (const [group, artifacts] of unreviewed) {
      console.error(`  ${group}`);
      for (const artifact of [...artifacts].sort()) {
        console.error(`    ${artifact}`);
      }
    }
    console.error(
      '\nF-Droid requires every dependency to be free software, not only the ' +
        'application. If these are, add the group to ALLOWED_GROUPS with its ' +
        'licence. If they are not, exclude them in android/app/build.gradle.'
    );
    fail(`${configuration} has ${unreviewed.length} unreviewed group(s)`);
  }

  console.log(
    `[verify-android-fdroid-classpath] ${configuration}: ${groups.size} ` +
      'dependency group(s), all reviewed as free software'
  );
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
    auditGraph(configuration, output);
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

// Only run when invoked directly. The parsing helpers above are imported by
// tests, and importing this file must not shell out to Gradle.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

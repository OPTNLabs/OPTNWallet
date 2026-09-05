// After `tauri android init`, cargo-mobile2 still templates Kotlin 1.9.x.
// tauri-plugin-biometry 0.2.8 then resolves kotlin-stdlib 2.1.0, and the 1.9
// compiler refuses that metadata ("can read versions up to 2.0.0").
//
// Usage:
//   tsx scripts/pin-tauri-android-kotlin.mts [src-tauri/gen/android]

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const KOTLIN_PIN = '2.1.21';
export const STDLIB_PIN_MARKER = 'optn-kotlin-stdlib-pin';

export function rewriteKotlinCompilerPins(text: string): string {
  return text
    .replace(
      /org\.jetbrains\.kotlin:kotlin-gradle-plugin:1\.[0-9]+\.[0-9]+/g,
      `org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_PIN}`
    )
    .replace(
      /(id\("org\.jetbrains\.kotlin\.android"\)\s+version\s+")1\.[0-9]+\.[0-9]+(")/g,
      `$1${KOTLIN_PIN}$2`
    );
}

export function ensureKotlinStdlibPin(text: string): string {
  if (text.includes(STDLIB_PIN_MARKER)) return text;
  return `${text.trimEnd()}

// ${STDLIB_PIN_MARKER}: keep stdlib metadata on the same Kotlin line as the
// compiler so plugin Android sources compile.
subprojects {
    configurations.configureEach {
        resolutionStrategy.eachDependency {
            if (requested.group == "org.jetbrains.kotlin" &&
                requested.name.startsWith("kotlin-stdlib")) {
                useVersion("${KOTLIN_PIN}")
            }
        }
    }
}
`;
}

function walkGradleFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      out.push(...walkGradleFiles(path));
      continue;
    }
    if (/\.(kts|gradle)$/.test(name)) out.push(path);
  }
  return out;
}

export function pinTauriAndroidKotlin(androidRoot: string): string[] {
  if (!existsSync(androidRoot)) {
    throw new Error(
      `Tauri Android project is missing at ${androidRoot}. Run tauri android init first.`
    );
  }

  const changed: string[] = [];
  for (const file of walkGradleFiles(androidRoot)) {
    const original = readFileSync(file, 'utf8');
    const next = rewriteKotlinCompilerPins(original);
    if (next !== original) {
      writeFileSync(file, next);
      changed.push(file);
    }
  }

  const rootGradleCandidates = [
    join(androidRoot, 'build.gradle.kts'),
    join(androidRoot, 'build.gradle'),
  ];
  for (const rootGradle of rootGradleCandidates) {
    if (!existsSync(rootGradle)) continue;
    const original = readFileSync(rootGradle, 'utf8');
    const next = ensureKotlinStdlibPin(original);
    if (next !== original) {
      writeFileSync(rootGradle, next);
      if (!changed.includes(rootGradle)) changed.push(rootGradle);
    }
    break;
  }

  if (changed.length === 0) {
    throw new Error(
      `No Kotlin 1.9.x pins found under ${androidRoot}. The Tauri Android template may have changed.`
    );
  }
  return changed;
}

const invokedAsCli = (process.argv[1] ?? '')
  .replace(/\\/g, '/')
  .endsWith('pin-tauri-android-kotlin.mts');

if (invokedAsCli) {
  const root = resolve(process.argv[2] ?? 'src-tauri/gen/android');
  const changed = pinTauriAndroidKotlin(root);
  for (const file of changed) {
    console.log(`[pin-tauri-android-kotlin] updated ${file}`);
  }
}

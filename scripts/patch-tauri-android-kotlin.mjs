import fs from 'node:fs';

export const TAURI_ANDROID_KOTLIN_VERSION = '2.1.21';
const LEGACY = 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25';
const COMPATIBLE = `org.jetbrains.kotlin:kotlin-gradle-plugin:${TAURI_ANDROID_KOTLIN_VERSION}`;

export function patchTauriAndroidKotlin(source) {
  if (source.includes(COMPATIBLE)) return source;
  if (!source.includes(LEGACY)) {
    throw new Error(
      `Expected Tauri Android Kotlin plugin ${LEGACY}; generated template changed, refusing a blind patch.`
    );
  }
  return source.replace(LEGACY, COMPATIBLE);
}

const invokedDirectly =
  process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (invokedDirectly) {
  const path = process.argv[2] ?? 'src-tauri/gen/android/build.gradle.kts';
  if (!fs.existsSync(path)) {
    throw new Error(
      `Tauri Android project is not initialized: missing ${path}. Run tauri android init first.`
    );
  }
  const before = fs.readFileSync(path, 'utf8');
  const after = patchTauriAndroidKotlin(before);
  if (after !== before) {
    fs.writeFileSync(path, after);
    console.log(
      `Pinned generated Tauri Android Kotlin compiler to ${TAURI_ANDROID_KOTLIN_VERSION} for biometry compatibility.`
    );
  } else {
    console.log(
      `Tauri Android Kotlin compiler already pinned to ${TAURI_ANDROID_KOTLIN_VERSION}.`
    );
  }
}

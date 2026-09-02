import { describe, expect, it } from 'vitest';

import {
  patchTauriAndroidKotlin,
  TAURI_ANDROID_KOTLIN_VERSION,
} from '../patch-tauri-android-kotlin.mjs';

describe('Tauri Android Kotlin compatibility patch', () => {
  it('raises the generated Tauri 2.11.4 Kotlin compiler to the biometry-compatible line', () => {
    const source =
      'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")';
    expect(patchTauriAndroidKotlin(source)).toBe(
      `classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${TAURI_ANDROID_KOTLIN_VERSION}")`
    );
    expect(TAURI_ANDROID_KOTLIN_VERSION).toBe('2.1.21');
  });

  it('is idempotent after patching', () => {
    const source =
      'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.21")';
    expect(patchTauriAndroidKotlin(source)).toBe(source);
  });

  it('fails closed if the generated Tauri template changes unexpectedly', () => {
    expect(() =>
      patchTauriAndroidKotlin(
        'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")'
      )
    ).toThrow(/template changed/i);
  });
});

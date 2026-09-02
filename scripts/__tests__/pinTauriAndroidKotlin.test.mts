import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KOTLIN_PIN,
  STDLIB_PIN_MARKER,
  ensureKotlinStdlibPin,
  pinTauriAndroidKotlin,
  rewriteKotlinCompilerPins,
} from '../pin-tauri-android-kotlin.mts';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('pin Tauri Android Kotlin', () => {
  it('rewrites the cargo-mobile2 1.9.x compiler classpath to the pinned line', () => {
    const templated = `buildscript {
    dependencies {
        classpath("com.android.tools.build:gradle:8.5.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}
`;
    const rewritten = rewriteKotlinCompilerPins(templated);
    expect(rewritten).toContain(
      `org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_PIN}`
    );
    expect(rewritten).not.toContain('kotlin-gradle-plugin:1.9.25');
    expect(rewriteKotlinCompilerPins(rewritten)).toBe(rewritten);
  });

  it('rewrites a versioned kotlin.android plugin id', () => {
    const templated =
      'id("org.jetbrains.kotlin.android") version "1.9.0"\n';
    expect(rewriteKotlinCompilerPins(templated)).toContain(
      `id("org.jetbrains.kotlin.android") version "${KOTLIN_PIN}"`
    );
  });

  it('appends a stdlib resolution pin once', () => {
    const once = ensureKotlinStdlibPin('buildscript {}\n');
    expect(once).toContain(STDLIB_PIN_MARKER);
    expect(once).toContain(`useVersion("${KOTLIN_PIN}")`);
    expect(ensureKotlinStdlibPin(once)).toBe(once);
  });

  it('patches a generated Android tree so plugin Kotlin compiles against 2.1 metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'optn-kotlin-pin-'));
    temps.push(root);
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(
      join(root, 'build.gradle.kts'),
      `buildscript {
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}
`
    );
    writeFileSync(
      join(root, 'app', 'build.gradle.kts'),
      'plugins { id("org.jetbrains.kotlin.android") version "1.9.25" }\n'
    );

    const changed = pinTauriAndroidKotlin(root);
    expect(changed.length).toBeGreaterThan(0);

    const rootGradle = readFileSync(join(root, 'build.gradle.kts'), 'utf8');
    expect(rootGradle).toContain(
      `org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_PIN}`
    );
    expect(rootGradle).toContain(STDLIB_PIN_MARKER);

    const appGradle = readFileSync(join(root, 'app', 'build.gradle.kts'), 'utf8');
    expect(appGradle).toContain(
      `id("org.jetbrains.kotlin.android") version "${KOTLIN_PIN}"`
    );
  });
});

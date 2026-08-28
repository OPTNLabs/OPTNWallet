import { describe, expect, it } from 'vitest';

import {
  ALLOWED_GROUPS,
  groupsIn,
  isAllowed,
} from '../verify-android-fdroid-classpath.mts';

// A real `gradlew :app:dependencies` tree, trimmed. The box-drawing prefixes
// and the (*) / (c) markers are what the parser has to survive.
const TREE = `
fdroidReleaseRuntimeClasspath - Runtime classpath of compilation 'fdroidRelease'.
+--- androidx.appcompat:appcompat:1.7.0
|    +--- androidx.activity:activity:1.8.2
|    |    \--- androidx.core:core:1.13.0 (*)
|    \--- androidx.fragment:fragment:1.5.4 (c)
+--- com.google.code.gson:gson:2.10.1
+--- project :capacitor-android
|    \--- androidx.core:core-ktx:1.15.0
+--- io.ionic.libs:ionbarcode-android:1.2.0
+--- com.google.zxing:core:3.4.1
\--- org.jetbrains.kotlin:kotlin-stdlib:2.0.0
     \--- org.jetbrains:annotations:13.0
`;

const TAINTED =
  TREE + '+--- com.google.mlkit:barcode-scanning:17.3.0\n' +
  '|    \--- com.google.android.gms:play-services-mlkit-barcode-scanning:18.3.1\n';

describe('F-Droid dependency graph audit', () => {
  it('reads every maven coordinate out of a gradle tree', () => {
    const groups = groupsIn(TREE);
    expect([...groups.keys()].sort()).toEqual([
      'androidx.activity',
      'androidx.appcompat',
      'androidx.core',
      'androidx.fragment',
      'com.google.code.gson',
      'com.google.zxing',
      'io.ionic.libs',
      'org.jetbrains',
      'org.jetbrains.kotlin',
    ]);
    expect(groups.get('androidx.core')).toContain('androidx.core:core');
    expect(groups.get('androidx.core')).toContain('androidx.core:core-ktx');
  });

  it('ignores our own project dependencies', () => {
    // `project :capacitor-android` is source in this repository, not a
    // third-party artifact to be licence-checked.
    expect(groupsIn(TREE).has('project')).toBe(false);
  });

  it('accepts every group a clean fdroid classpath resolves', () => {
    for (const group of groupsIn(TREE).keys()) {
      expect(isAllowed(group), `${group} should be allowed`).toBe(true);
    }
  });

  it('rejects ML Kit and Play Services', () => {
    // The whole point: F-Droid rejects the build for one proprietary
    // dependency anywhere in the graph, including a transitive one.
    const groups = [...groupsIn(TAINTED).keys()];
    const unreviewed = groups.filter((g) => !isAllowed(g));
    expect(unreviewed.sort()).toEqual([
      'com.google.android.gms',
      'com.google.mlkit',
    ]);
  });

  it('does not allow a group by accidental prefix', () => {
    // 'androidx' must not admit 'androidxevil', and 'com.google.zxing' must
    // not admit 'com.google.zxingfoo'.
    expect(isAllowed('androidxevil')).toBe(false);
    expect(isAllowed('com.google.zxingfoo')).toBe(false);
    expect(isAllowed('androidx.core')).toBe(true);
  });

  it('names a licence for every allowed group in the source comment', () => {
    // The list is a record of decisions. An entry with no stated licence is an
    // entry nobody actually reviewed.
    expect(ALLOWED_GROUPS.length).toBeGreaterThan(0);
    expect(ALLOWED_GROUPS).not.toContain('com.google.mlkit');
    expect(ALLOWED_GROUPS).not.toContain('com.google.android.gms');
  });
});

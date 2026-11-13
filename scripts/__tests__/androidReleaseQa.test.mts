import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  ANDROID_PACKAGE,
  CHIPNET_PUBLIC_BCMR_BASE_URLS,
  CHIPNET_TOKENINDEXER_BASE_URL,
  DEFAULT_MAX_HEIGHT_LAG,
} from '../run-android-release-qa.mts';

describe('Android release QA preflight', () => {
  it('targets the packaged wallet and public Chipnet metadata services', () => {
    expect(ANDROID_PACKAGE).toBe('optn.wallet.app');
    expect(CHIPNET_PUBLIC_BCMR_BASE_URLS).toEqual([
      'https://bcmr.optnlabs.com/api',
      'https://bcmr-chipnet.paytaca.com/api',
    ]);
    expect(CHIPNET_TOKENINDEXER_BASE_URL).toBe(
      'https://tokenindex.optnlabs.com/v1'
    );
  });

  it('uses a conservative default height freshness threshold', () => {
    expect(DEFAULT_MAX_HEIGHT_LAG).toBe(3);
  });

  it('keeps connected instrumentation opt-in because it may replace app data', async () => {
    const source = await readFile(
      new URL('../run-android-release-qa.mts', import.meta.url),
      'utf8'
    );
    expect(source).toContain("label !== 'android:test:instrumented'");
    expect(source).toContain('--run-instrumented');
  });
});

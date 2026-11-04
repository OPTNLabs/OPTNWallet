import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const homeSource = readFileSync(
  fileURLToPath(new URL('../Home.tsx', import.meta.url)),
  'utf8'
);
const desktopHomeSource = readFileSync(
  fileURLToPath(
    new URL('../../../platform/desktop/DesktopHome.tsx', import.meta.url)
  ),
  'utf8'
);

describe('Home currency breakdown', () => {
  it('keeps the spendable breakdown in the selected currency', () => {
    for (const source of [homeSource, desktopHomeSource]) {
      expect(source).toContain("t('home.spendableUsd'");
      expect(source).toContain("t('home.stealthUsd'");
      expect(source).toContain("t('home.spendableBch'");
      expect(source).toContain("t('home.stealthBch'");
      expect(source).toContain("t('home.usdUnavailable')");
    }
  });
});

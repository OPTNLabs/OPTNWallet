import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(
    new URL('../ConnectorWalletEffectSummary.tsx', import.meta.url)
  ),
  'utf8'
);

describe('connector wallet effect disclosure', () => {
  it('explains loading and unavailable wallet-effect states', () => {
    expect(source).toContain('connector-wallet-effect-loading-help');
    expect(source).toContain('connector-wallet-effect-unavailable-help');
    expect(source).toContain("t('txReview.walletEffectHelp')");
  });
});

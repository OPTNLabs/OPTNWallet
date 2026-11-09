import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(
  fileURLToPath(new URL('../FundMeAddonApp.tsx', import.meta.url)),
  'utf8'
);
const modalSource = readFileSync(
  fileURLToPath(
    new URL('../components/FundMeDetailModal.tsx', import.meta.url)
  ),
  'utf8'
);

describe('FundMe transaction disclosure', () => {
  it('keeps broadcast transaction IDs behind the shared masked disclosure', () => {
    expect(appSource).toContain('actionTxid');
    expect(appSource).toContain('setActionTxid(result.txid)');
    expect(modalSource).toContain('import MaskedValue');
    expect(modalSource).toContain('value={actionTxid}');
    expect(modalSource).toContain('module.transactionId');
  });
});

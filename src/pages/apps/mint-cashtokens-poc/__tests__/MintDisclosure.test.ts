import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../MintCashTokensPoCApp.tsx', import.meta.url)),
  'utf8'
);

describe('CashToken mint transaction disclosure', () => {
  it('uses the localized Transaction ID label with masked output', () => {
    expect(source).toContain("walletT('history.transactionId')");
    expect(source).toContain('value={txid}');
    expect(source).toContain(
      'copySuccessMessageKey="history.transactionCopied"'
    );
    expect(source).not.toContain('Broadcast txid');
  });
});

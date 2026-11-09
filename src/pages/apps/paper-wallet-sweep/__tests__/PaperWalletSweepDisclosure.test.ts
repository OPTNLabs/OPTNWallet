import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../PaperWalletSweepApp.tsx', import.meta.url)),
  'utf8'
);

describe('paper-wallet sweep transaction disclosure', () => {
  it('masks transaction IDs in the spendable-output list', () => {
    expect(source).toContain('value={u.tx_hash}');
    expect(source).toContain("walletT('history.transactionId')");
    expect(source).toContain(
      'copySuccessMessageKey="history.transactionCopied"'
    );
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const utxoSource = readFileSync(
  fileURLToPath(new URL('../UtxoNotificationCenter.tsx', import.meta.url)),
  'utf8'
);
const serverSource = readFileSync(
  fileURLToPath(new URL('../ServerNotificationCenter.tsx', import.meta.url)),
  'utf8'
);

describe('notification identifier disclosure', () => {
  it('keeps transient incoming notifications copyable and long-press discoverable', () => {
    for (const source of [utxoSource, serverSource]) {
      expect(source).toContain('<MaskedValue');
      expect(source).toContain('copySuccessMessageKey="receive.addressCopied"');
      expect(source).toContain(
        'copySuccessMessageKey="history.transactionCopied"'
      );
      expect(source).not.toContain('shortAddr');
      expect(source).not.toContain('shortTx');
    }
  });
});

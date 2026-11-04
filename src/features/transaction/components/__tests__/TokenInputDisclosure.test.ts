import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cashTokenSource = readFileSync(
  fileURLToPath(new URL('../CashTokenView.tsx', import.meta.url)),
  'utf8'
);
const nftSource = readFileSync(
  fileURLToPath(new URL('../NFTView.tsx', import.meta.url)),
  'utf8'
);

describe('token input identifier disclosure', () => {
  it('masks genesis transaction IDs while retaining raw option values', () => {
    expect(cashTokenSource).toContain('value={utxo.tx_hash}');
    expect(cashTokenSource).toContain('maskSensitiveValue(utxo.tx_hash)');
    expect(nftSource).toContain('value={utxo.tx_hash}');
    expect(nftSource).toContain('maskSensitiveValue(utxo.tx_hash)');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = [
  'MultisigHome.tsx',
  'MultisigReceive.tsx',
  'MultisigPolicy.tsx',
  'MultisigCosignerWorkspace.tsx',
].map((file) =>
  readFileSync(join(process.cwd(), 'src/features/multisig', file), 'utf8')
);

describe('multisig network context', () => {
  it('keeps every policy-backed multisig screen visibly network-scoped', () => {
    for (const source of files) {
      expect(source).toContain('NetworkContextBanner');
    }
  });
});

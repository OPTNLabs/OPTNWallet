import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) =>
  readFileSync(join(process.cwd(), 'src/features/multisig', file), 'utf8');

describe('multisig setup disclosure', () => {
  it('uses the policy network in setup and the shared error disclosure', () => {
    const setup = readSource('MultisigSetup.tsx');
    const qr = readSource('QrScanDialog.tsx');

    expect(setup).toContain('MultisigError');
    expect(setup).toContain('network: setupNetwork');
    expect(qr).toContain('MultisigError');
    expect(qr).not.toContain('<p role="alert"');
  });
});

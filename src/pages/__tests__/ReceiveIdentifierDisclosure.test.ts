import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../Receive.tsx', import.meta.url)),
  'utf8'
);

describe('Receive identifier disclosure', () => {
  it('keeps Quantumroot status addresses behind the shared full-value path', () => {
    expect(source).toContain('selectedQuantumrootVault.receive_address');
    expect(source).toContain('selectedQuantumrootVault.quantum_lock_address');
    expect(source).toContain('<MaskedValue');
    expect(source).toContain('copySuccessMessageKey="receive.addressCopied"');
  });

  it('keeps direct Receive navigation inside the active wallet context', () => {
    expect(source).toContain(
      "currentWalletId ? `/home/${currentWalletId}` : '/actions'"
    );
    expect(source).toContain('getReturnPath(');
    expect(source).toContain(
      'wallet-btn-secondary min-h-[44px] w-full py-3 font-semibold shadow-xl'
    );
  });

  it('keeps inline copy affordances on the selected receive address', () => {
    expect(source).toContain("t('receive.copyAddress')");
    expect(source).toContain('data-testid="receive-address"');
    expect(source).toContain('<MdContentCopy');
    expect(source).not.toContain('shareWithFeedback(');
    expect(source).not.toContain("t('receive.shareAddress')");
  });

  it('centers the receive payload selector buttons', () => {
    expect(source).toContain(
      'min-w-0 max-w-full overflow-x-auto overscroll-x-contain pb-1'
    );
    expect(source).toContain('flex w-max min-w-full justify-center gap-1.5');
  });

  it('preserves the BCH prefix and five-character address ends', () => {
    expect(source).toContain('addressMaskPrefixLength');
    expect(source).toContain('addressMaskSuffixLength = 5');
    expect(source).toContain('prefixLength={addressMaskPrefixLength}');
    expect(source).toContain('suffixLength={addressMaskSuffixLength}');
  });

  it('lets the QR preview toggle the full address payload', () => {
    expect(source).toContain('setShowQrAddress((visible) => !visible)');
    expect(source).toContain('showQrAddress ?');
    expect(source).toContain('value={activeQrPayload}');
  });
});

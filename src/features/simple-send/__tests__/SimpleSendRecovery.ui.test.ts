import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../SimpleSend.tsx', import.meta.url)),
  'utf8'
);
const hookSource = readFileSync(
  fileURLToPath(new URL('../../../hooks/useSimpleSend.ts', import.meta.url)),
  'utf8'
);

describe('Simple Send recovery behavior', () => {
  it('keeps the payment fields mounted and focuses the amount for balance errors', () => {
    expect(source).toContain(
      'const amountInputRef = useRef<HTMLInputElement>(null);'
    );
    expect(source).toContain(
      'const tokenAmountInputRef = useRef<HTMLInputElement>(null);'
    );
    expect(source).toContain(
      'const tokenOutputBchInputRef = useRef<HTMLInputElement>(null);'
    );
    expect(source).toContain('ref={amountInputRef}');
    expect(source).toContain('ref={tokenAmountInputRef}');
    expect(source).toContain('ref={tokenOutputBchInputRef}');
    expect(source).toContain('isInsufficientFundsError(pageError)');
    expect(source).toContain("'unable to build bch send'");
    expect(source).toContain("'unable to build with non-token bch fee utxos'");
    expect(source).toContain('enteredAmountExceedsSpendable');
    expect(source).toContain('amountInputRef.current?.focus();');
    expect(source).toContain('tokenAmountInputRef.current?.focus();');
    expect(source).toContain('tokenOutputBchInputRef.current?.focus();');
    expect(source).toContain('onClick={focusErrorField}');
  });

  it('keeps the primary send mode and advanced controls touch-sized', () => {
    expect(source).toContain('min-h-[44px] rounded-[16px]');
    expect(source).toContain(
      'wallet-btn-secondary col-span-2 flex min-h-[44px]'
    );
    expect(source).toContain(
      'className="flex min-h-[44px] min-w-0 flex-1 items-center'
    );
  });

  it('provides a display-only fixture for the retained-form error recovery path', () => {
    expect(hookSource).toContain("uiFixtureScenario() === 'send-error'");
    expect(hookSource).toContain(
      'Unable to build BCH send with one free candidate totaling 10,000 sats.'
    );
    expect(hookSource).toContain("setMode('error');");
  });
});

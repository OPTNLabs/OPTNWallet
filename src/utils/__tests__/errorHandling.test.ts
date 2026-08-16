import { afterEach, describe, expect, it, vi } from 'vitest';

import { logError, logWarn } from '../errorHandling';

describe('error handling secret redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts sensitive context fields before logging errors', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    logError('wallet', new Error('unable to derive address'), {
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      privateKey: 'secret-wif',
      safeValue: 'visible diagnostic',
    });

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[1]).toMatchObject({
      context: {
        mnemonic: '[REDACTED]',
        privateKey: '[REDACTED]',
        safeValue: 'visible diagnostic',
      },
    });
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain(
      'secret-wif'
    );
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain(
      'abandon abandon'
    );
  });

  it('redacts sensitive fields in warning context too', () => {
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    logWarn('wallet', 'diagnostic warning', {
      seedPhrase: 'seed phrase value',
      signature: 'signature value',
      stage: 'build',
    });

    expect(consoleWarn).toHaveBeenCalledOnce();
    expect(consoleWarn.mock.calls[0]?.[1]).toMatchObject({
      context: {
        seedPhrase: '[REDACTED]',
        signature: '[REDACTED]',
        stage: 'build',
      },
    });
    expect(JSON.stringify(consoleWarn.mock.calls[0])).not.toContain(
      'seed phrase value'
    );
    expect(JSON.stringify(consoleWarn.mock.calls[0])).not.toContain(
      'signature value'
    );
  });
});

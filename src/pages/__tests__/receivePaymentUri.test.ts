import { describe, expect, it } from 'vitest';
import {
  buildBchPaymentUri,
  isValidBchPaymentAmount,
  normalizeBchPaymentAmountInput,
} from '../receivePaymentUri';

describe('buildBchPaymentUri', () => {
  it('does not duplicate the mainnet CashAddr prefix', () => {
    expect(buildBchPaymentUri('bitcoincash:qexample')).toBe(
      'bitcoincash:qexample'
    );
  });

  it('retains an explicit testnet CashAddr prefix', () => {
    expect(buildBchPaymentUri('bchtest:qexample')).toBe(
      'bitcoincash:bchtest:qexample'
    );
  });

  it('encodes optional BIP21 fields in a stable order', () => {
    expect(
      buildBchPaymentUri('bitcoincash:qexample', {
        amount: '0.0105',
        label: 'Coffee & tea',
        message: 'Thanks?',
      })
    ).toBe(
      'bitcoincash:qexample?amount=0.0105&label=Coffee+%26+tea&message=Thanks%3F'
    );
  });

  it('returns no URI when there is no receive address', () => {
    expect(buildBchPaymentUri('')).toBe('');
  });
});

describe('BCH payment request amount validation', () => {
  it.each(['0.00000001', '1', '12.5', '0001.25'])('accepts %s', (value) => {
    expect(isValidBchPaymentAmount(value)).toBe(true);
  });

  it.each(['0', '0.00000000', '-1', '1e-3', '13abc', '1.123456789', '1.'])(
    'rejects malformed or zero amount %s',
    (value) => {
      expect(isValidBchPaymentAmount(value)).toBe(false);
    }
  );

  it('normalizes one comma decimal separator without stripping other input', () => {
    expect(normalizeBchPaymentAmountInput('1,5')).toBe('1.5');
    expect(normalizeBchPaymentAmountInput('1e-3')).toBe('1e-3');
    expect(normalizeBchPaymentAmountInput('1,2.3')).toBe('1,2.3');
  });
});

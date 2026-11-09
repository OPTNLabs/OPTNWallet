/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MaskedValue from '../MaskedValue';

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MaskedValue', () => {
  it('opens the full value after a long press when embedded in a row', () => {
    vi.useFakeTimers();

    render(
      <MaskedValue
        value="1234567890abcdef"
        label="Transaction ID"
        ariaLabel="Copy transaction ID"
        embedded
      />
    );

    const trigger = screen.getByRole('button', { name: 'Copy transaction ID' });
    expect(trigger).toHaveTextContent('1234********cdef');
    expect(
      trigger.querySelector('[data-mask-part="prefix"]')
    ).toHaveTextContent('1234');
    expect(
      trigger.querySelector('[data-mask-part="suffix"]')
    ).toHaveTextContent('cdef');

    fireEvent.pointerDown(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByRole('dialog')).toHaveTextContent('1234567890abcdef');
  });

  it('reveals the full value on click when requested', () => {
    render(
      <MaskedValue
        value="bchtest:ppqwabcdefghijklmnop12345"
        label="Address"
        revealOnClick
      />
    );

    const trigger = screen.getByRole('button', { name: 'Address' });
    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'bchtest:ppqwabcdefghijklmnop12345'
    );
  });

  it('keeps the CashAddr prefix and reveals five payload characters', () => {
    render(
      <MaskedValue
        value="bchtest:ppqwabcdefghijklmnop12345"
        label="Address"
        prefixLength={5}
        suffixLength={5}
        preserveCashAddressPrefix
      />
    );

    const trigger = screen.getByRole('button', { name: 'Address' });
    expect(trigger.querySelector('[data-mask-part="prefix"]')).toHaveTextContent(
      'bchtest:ppqwa'
    );
    expect(trigger.querySelector('[data-mask-part="suffix"]')).toHaveTextContent(
      '12345'
    );
  });
});

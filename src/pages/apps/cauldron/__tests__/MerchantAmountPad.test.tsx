import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import MerchantAmountPad from '../MerchantAmountPad';

describe('MerchantAmountPad', () => {
  it('renders the keypad and forwards amount edits', () => {
    const onChange = vi.fn();

    const initial = MerchantAmountPad({
      amount: '',
      decimals: 6,
      symbol: 'MUSD',
      onChange,
    });
    const initialHtml = renderToStaticMarkup(initial);
    expect(initialHtml).toContain('Amount to receive');
    expect(initialHtml).toContain('MUSD');
    expect(initialHtml).toContain('Clear');
    expect(initialHtml).toContain('⌫');

    const initialChildren = Children.toArray(initial.props.children).filter(
      isValidElement
    );
    const keypadGrid = initialChildren[2];
    if (!keypadGrid) {
      throw new Error('Expected the merchant keypad to render');
    }
    const keypadButtons = Children.toArray(keypadGrid.props.children).filter(
      isValidElement
    );
    const digitOneButton = keypadButtons.find(
      (button) => button.props.children === '1'
    );
    if (!digitOneButton) {
      throw new Error('Expected the digit 1 button to render');
    }
    digitOneButton.props.onClick();
    expect(onChange).toHaveBeenLastCalledWith('1');

    const decimalPad = MerchantAmountPad({
      amount: '1',
      decimals: 6,
      symbol: 'MUSD',
      onChange,
    });
    const decimalButtons = Children.toArray(decimalPad.props.children).filter(
      isValidElement
    );
    const decimalGrid = decimalButtons[2];
    const dotButton = Children.toArray(decimalGrid.props.children)
      .filter(isValidElement)
      .find((button) => button.props.children === '.');
    if (!dotButton) {
      throw new Error('Expected the decimal button to render');
    }
    dotButton.props.onClick();
    expect(onChange).toHaveBeenLastCalledWith('1.');

    const clearButton = Children.toArray(decimalButtons[1].props.children)
      .filter(isValidElement)
      .find((button) => button.props.children === 'Clear');
    if (!clearButton) {
      throw new Error('Expected the clear button to render');
    }
    clearButton.props.onClick();
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});


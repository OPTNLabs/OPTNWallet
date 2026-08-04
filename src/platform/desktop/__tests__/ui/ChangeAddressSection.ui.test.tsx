/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangeAddressSection } from '../../../../features/simple-send/ChangeAddressSection';

vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(() => cleanup());

describe('ChangeAddressSection UI', () => {
  it('reports the selected change address to the send flow', async () => {
    const user = userEvent.setup();
    const setSelectedChangeAddress = vi.fn();
    const addresses = [
      { address: 'bitcoincash:qreceive', tokenAddress: 'bitcoincash:qreceive' },
      { address: 'bitcoincash:qchange', tokenAddress: 'bitcoincash:qchange' },
    ];

    render(
      <ChangeAddressSection
        selectedChangeAddress={addresses[0].address}
        setSelectedChangeAddress={setSelectedChangeAddress}
        selectClass="wallet-input"
        addresses={addresses}
        mask={(value) => value}
      />
    );

    const select = screen.getByRole('combobox');
    expect(select).toHaveValue(addresses[0].address);

    await user.selectOptions(select, addresses[1].address);

    expect(setSelectedChangeAddress).toHaveBeenLastCalledWith(
      addresses[1].address
    );
  });
});

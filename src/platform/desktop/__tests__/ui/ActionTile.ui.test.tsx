/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ActionTile from '../../../../components/ui/ActionTile';

afterEach(() => cleanup());

describe('ActionTile UI', () => {
  it('invokes its action when the enabled tile is selected', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <ActionTile
        title="Send"
        description="Send BCH or CashTokens"
        onClick={onClick}
      />
    );

    await user.click(screen.getByRole('button', { name: /Send/ }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders unavailable actions as disabled controls', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <ActionTile
        title="ParyonUSD"
        description="Coming soon"
        disabled
        onClick={onClick}
      />
    );

    const button = screen.getByRole('button', { name: /ParyonUSD/ });
    expect(button).toBeDisabled();

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

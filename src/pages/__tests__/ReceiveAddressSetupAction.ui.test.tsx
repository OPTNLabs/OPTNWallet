/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ReceiveAddressSetupAction from '../ReceiveAddressSetupAction';

it('announces preparation failure and offers a retryable 44px action', () => {
  const onPrepare = vi.fn();
  render(
    <ReceiveAddressSetupAction
      busy={false}
      error="prepare-failed"
      label="Prepare addresses"
      loadingLabel="Preparing addresses"
      errorLabel="Could not prepare addresses. Try again."
      onPrepare={onPrepare}
    />
  );

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Could not prepare addresses. Try again.'
  );
  const button = screen.getByRole('button', { name: 'Prepare addresses' });
  expect(button).toHaveClass('min-h-[44px]');
  fireEvent.click(button);
  expect(onPrepare).toHaveBeenCalledOnce();
});

it('disables duplicate preparation while announcing progress', () => {
  render(
    <ReceiveAddressSetupAction
      busy
      error={null}
      label="Prepare addresses"
      loadingLabel="Preparing addresses"
      errorLabel="Could not prepare addresses. Try again."
      onPrepare={vi.fn()}
    />
  );

  expect(
    screen.getByRole('button', { name: 'Preparing addresses' })
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Preparing addresses' })
  ).toHaveAttribute('aria-busy', 'true');
});

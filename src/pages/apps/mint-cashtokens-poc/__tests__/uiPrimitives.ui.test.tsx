/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContainedSwipeConfirmModal } from '../components/uiPrimitives';

afterEach(cleanup);

it('contains focus, supports Escape, and offers one keyboard confirmation', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const { rerender } = render(
    <>
      <button type="button">Open review</button>
      <ContainedSwipeConfirmModal
        open={false}
        title="Review swap"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </>
  );
  const trigger = screen.getByRole('button', { name: 'Open review' });
  trigger.focus();
  rerender(
    <>
      <button type="button">Open review</button>
      <ContainedSwipeConfirmModal
        open
        title="Review swap"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </>
  );

  const dialog = screen.getByRole('dialog', { name: 'Review swap' });
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  const confirm = screen.getByRole('button', { name: 'Confirm action' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(confirm);
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(cancel);
  expect(dialog).toContainElement(confirm);
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(onConfirm).toHaveBeenCalledOnce();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledOnce();
  rerender(
    <>
      <button type="button">Open review</button>
      <ContainedSwipeConfirmModal
        open={false}
        title="Review swap"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </>
  );
  expect(document.activeElement).toBe(trigger);
});

it('does not allow keyboard approval when confirmation is unavailable', () => {
  const onConfirm = vi.fn();
  render(
    <ContainedSwipeConfirmModal
      open
      title="Review swap"
      canConfirm={false}
      onCancel={() => undefined}
      onConfirm={onConfirm}
    />
  );
  const confirm = screen.getByRole('button', { name: 'Confirm action' });
  expect(confirm).toBeDisabled();
  fireEvent.click(confirm);
  expect(onConfirm).not.toHaveBeenCalled();
});

it('uses a single plain action for a preview-only confirmation', () => {
  const onConfirm = vi.fn();
  render(
    <ContainedSwipeConfirmModal
      open
      title="Redeem preview"
      confirmationMode="button"
      confirmationLabel="Finish preview"
      onCancel={() => undefined}
      onConfirm={onConfirm}
    />
  );
  expect(screen.queryByText('Slide to confirm')).not.toBeInTheDocument();
  const finish = screen.getByRole('button', { name: 'Finish preview' });
  fireEvent.click(finish);
  fireEvent.click(finish);
  expect(onConfirm).toHaveBeenCalledOnce();
});

/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import PersonalLabelEditor from '../PersonalLabelEditor';

it('keeps label save failures in-wallet and allows a retry', async () => {
  const onSave = vi
    .fn<(_: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('write failed'))
    .mockResolvedValueOnce(undefined);
  render(
    <PersonalLabelEditor
      initialValue="rent"
      fieldLabel="Personal note"
      saveLabel="Save label"
      savingLabel="Saving…"
      cancelLabel="Cancel"
      errorLabel="Could not save this label."
      onSave={onSave}
      onCancel={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not save this label.'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
  expect(onSave).toHaveBeenNthCalledWith(2, 'rent');
  expect(screen.queryByRole('alert')).toBeNull();
});

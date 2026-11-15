/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WizardSignInProofView, {
  type WizardSignInProofViewProps,
} from '../wizardconnect/WizardSignInProofView';

vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function view(overrides: Partial<WizardSignInProofViewProps> = {}) {
  const onApprove = vi.fn();
  const onReject = vi.fn();
  render(
    <WizardSignInProofView
      dappName="Some dApp"
      domain="example.com"
      address="bitcoincash:qzcyvxr0e23d408u62ulf6cnspc0k4dyduy8kh77nc"
      code="Session_abcdef-0123456789"
      onApprove={onApprove}
      onReject={onReject}
      {...overrides}
    />
  );
  const approve = screen.getByRole('button', {
    name: 'wizard.signInProofApprove',
  });
  return { approve, onApprove, onReject };
}

describe('WizardSignInProofView', () => {
  afterEach(cleanup);

  it('names the relying party the proof is for, apart from the dApp', () => {
    const { approve, onApprove } = view();
    const domain = screen.getByTestId('wizard-sign-in-proof-domain');
    expect(domain).toHaveTextContent('example.com');
    // Under "Sign in to", not under the dApp's self-reported name.
    const block = domain.parentElement!;
    expect(
      within(block).getByText('wizard.signInProofSignInTo')
    ).toBeInTheDocument();
    expect(within(block).queryByText('Some dApp')).not.toBeInTheDocument();
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['there is no domain to show', { domain: undefined }],
    ['the request was refused', { error: 'invalid relying-party domain' }],
    ['sign-in proofs are turned off', { disabledBySetting: true }],
    ['a signature is already in flight', { busy: true }],
  ])('cannot be approved when %s', (_reason, overrides) => {
    const { approve, onApprove } = view(overrides);
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
  });
});

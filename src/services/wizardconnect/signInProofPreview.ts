import type { PendingSignRequest } from '@wizardconnect/wallet';
import type { Network } from '../../state/slices/networkSlice';
import { PREFIX } from '../../utils/constants';
import {
  findClaimedSignInProofSchemeInPayload,
  signInProofAddress,
  type ValidatedSignInProof,
} from './signInProof';

/** The part of OptnWizardWalletAdapter the approval screen needs. */
type SignInProofInspector = {
  readonly network: Network;
  inspectSignInProof(
    request: PendingSignRequest['request']
  ): ValidatedSignInProof | null;
};

let activeInspector: SignInProofInspector | null = null;

/** Called by the WizardConnect slice whenever its wallet adapter changes. */
export function setSignInProofInspector(
  inspector: SignInProofInspector | null
): void {
  activeInspector = inspector;
}

export type WizardSignInProofPreview =
  | { kind: 'none' }
  | {
      kind: 'proof';
      schemeId: string;
      schemeLabel: string;
      code: string;
      address: string;
    }
  | { kind: 'invalid'; message: string };

/**
 * Classify a pending request for the approval screen. The same validation
 * runs again inside the adapter at signing time, so this preview is display
 * only and cannot widen what gets signed.
 */
export function previewWizardSignInProof(
  request: PendingSignRequest['request']
): WizardSignInProofPreview {
  try {
    if (!findClaimedSignInProofSchemeInPayload(request.transaction)) {
      return { kind: 'none' };
    }
    if (!activeInspector) {
      return { kind: 'invalid', message: 'WizardConnect wallet is not ready' };
    }
    const proof = activeInspector.inspectSignInProof(request);
    if (!proof) return { kind: 'none' };
    return {
      kind: 'proof',
      schemeId: proof.scheme.id,
      schemeLabel: proof.scheme.label,
      code: proof.code,
      address: signInProofAddress(proof, PREFIX[activeInspector.network]),
    };
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

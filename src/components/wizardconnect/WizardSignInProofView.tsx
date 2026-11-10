import { useI18n } from '../../i18n/useI18n';

export type WizardSignInProofViewProps = {
  dappName: string;
  /** Scheme label shown on the approval screen, "WizardConnect sign-in". */
  schemeLabel?: string;
  address?: string;
  code?: string;
  /** Validation failure. Approval stays disabled. */
  error?: string;
  /** Sign-in proofs turned off in settings. Approval stays disabled. */
  disabledBySetting?: boolean;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
};

/**
 * Approval screen for a WizardConnect sign-in proof. Distinct from the
 * payment screen: there are no amounts, only who is asking, which address is
 * being proven, and the one-time code.
 */
export default function WizardSignInProofView({
  dappName,
  schemeLabel,
  address,
  code,
  error,
  disabledBySetting = false,
  busy = false,
  onApprove,
  onReject,
}: WizardSignInProofViewProps) {
  const { t } = useI18n();
  const canApprove =
    !error && !disabledBySetting && !!address && !!code && !busy;

  return (
    <div className="wallet-popup-backdrop">
      <div
        className="wallet-popup-panel max-w-lg w-full flex flex-col space-y-4"
        data-testid="wizard-sign-in-proof"
      >
        <h3 className="text-xl font-bold text-center">
          {t('wizard.signInProofTitle')}
        </h3>

        <div className="space-y-3 text-sm">
          <div>
            <div className="wallet-muted">{t('wizard.dapp')}</div>
            <div className="font-semibold wallet-text-strong break-words">
              {dappName}
            </div>
          </div>
          {schemeLabel && (
            <div>
              <div className="wallet-muted">
                {t('wizard.signInProofSignInTo')}
              </div>
              <div className="font-semibold wallet-text-strong break-words">
                {schemeLabel}
              </div>
            </div>
          )}
          {address && (
            <div>
              <div className="wallet-muted">
                {t('wizard.signInProofAddress')}
              </div>
              <div className="font-mono wallet-link break-all">{address}</div>
            </div>
          )}
          {code && (
            <div>
              <div className="wallet-muted">{t('wizard.signInProofCode')}</div>
              <div className="font-mono wallet-text-strong break-all">
                {code}
              </div>
            </div>
          )}
        </div>

        <div
          className="text-sm font-semibold wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong"
          data-testid="wizard-sign-in-proof-no-funds"
        >
          {t('wizard.signInProofNoFunds')}
        </div>
        <p className="text-xs wallet-muted">
          {t('wizard.signInProofExplainer')}
        </p>

        {disabledBySetting && (
          <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong">
            {t('wizard.signInProofDisabled')}
          </div>
        )}
        {error && (
          <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong break-words">
            {t('wizard.signInProofInvalid', { message: error })}
          </div>
        )}

        <div className="flex justify-around pt-2">
          <button
            disabled={!canApprove}
            onClick={onApprove}
            className="wallet-btn-primary"
          >
            {t('wizard.signInProofApprove')}
          </button>
          <button onClick={onReject} className="wallet-btn-danger">
            {t('wizard.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

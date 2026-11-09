import FriendlyErrorPanel from '../../components/ui/FriendlyErrorPanel';
import { useI18n } from '../../i18n/useI18n';

type ContractLoadFailureProps = {
  message: string;
  technicalMessage?: string;
  retryLabel: string;
  onRetry: () => void;
};

export default function ContractLoadFailure({
  message,
  technicalMessage,
  retryLabel,
  onRetry,
}: ContractLoadFailureProps) {
  const { t } = useI18n();
  return (
    <div className="mt-4 space-y-2 text-center">
      <FriendlyErrorPanel title={t('contractView.error')} message={message} />
      {technicalMessage ? (
        <details className="text-left">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-xs font-semibold wallet-muted">
            {t('send.technicalDetails')}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3 text-[11px] wallet-muted">
            {technicalMessage}
          </pre>
        </details>
      ) : null}
      <button
        type="button"
        className="wallet-btn-secondary mt-3 min-h-[44px] px-4 py-2"
        onClick={onRetry}
      >
        {retryLabel}
      </button>
    </div>
  );
}

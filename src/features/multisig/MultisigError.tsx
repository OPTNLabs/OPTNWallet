import FriendlyErrorPanel from '../../components/ui/FriendlyErrorPanel';
import { useI18n } from '../../i18n/useI18n';

type MultisigErrorProps = {
  message: string;
  className?: string;
};

function friendlyMultisigError(
  message: string,
  t: ReturnType<typeof useI18n>['t']
): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('insufficient funds') ||
    normalized.includes('not enough funds')
  ) {
    return t('send.insufficientFunds');
  }
  if (
    normalized.includes('network') ||
    normalized.includes('timeout') ||
    normalized.includes('connection') ||
    normalized.includes('offline') ||
    normalized.includes('unreachable')
  ) {
    return t('send.networkError');
  }
  if (
    /(?:typeerror|referenceerror|undefined|null|sql|electrum|rpc|json|stack trace|cannot read)/i.test(
      message
    )
  ) {
    return t('send.genericError');
  }
  return message;
}

export default function MultisigError({
  message,
  className = '',
}: MultisigErrorProps) {
  const { t } = useI18n();
  return (
    <div className={className}>
      <FriendlyErrorPanel
        title={t('send.errorTitle')}
        message={friendlyMultisigError(message, t)}
      />
      <details className="mt-1">
        <summary className="flex min-h-[44px] cursor-pointer items-center text-xs font-semibold wallet-muted">
          {t('send.technicalDetails')}
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3 text-left text-[11px] wallet-muted">
          {message}
        </pre>
      </details>
    </div>
  );
}

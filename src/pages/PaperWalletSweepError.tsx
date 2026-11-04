import FriendlyErrorPanel from '../components/ui/FriendlyErrorPanel';
import { useI18n } from '../i18n/useI18n';
import { friendlySweepError } from './paperWalletSweepErrorCopy';

type PaperWalletSweepErrorProps = {
  message: string;
  compact?: boolean;
};

export default function PaperWalletSweepError({
  message,
  compact = false,
}: PaperWalletSweepErrorProps) {
  const { t } = useI18n();
  return (
    <div className={compact ? undefined : 'mt-3'}>
      <FriendlyErrorPanel
        title={t('send.errorTitle')}
        message={friendlySweepError(message, t)}
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

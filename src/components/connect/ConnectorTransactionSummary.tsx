import { useId } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { ConnectorTransactionPreview } from '../../services/connect/transactionPreview';

type ConnectorOperation = 'sign-and-broadcast' | 'sign-and-return';

type Props = {
  network: 'mainnet' | 'chipnet';
  operation: ConnectorOperation;
  preview: ConnectorTransactionPreview;
};

function formatBch(satoshis: bigint): string {
  return `${(Number(satoshis) / 100_000_000).toFixed(8)} BCH`;
}

/**
 * The first thing a connector request should answer is what the wallet will
 * do. Whole-transaction totals stay available, but are intentionally kept
 * behind a technical disclosure because they may include other participants.
 */
export default function ConnectorTransactionSummary({
  network,
  operation,
  preview,
}: Props) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="wallet-signature-panel rounded-2xl border border-[var(--wallet-border)] p-3 text-sm"
    >
      <h4 id={titleId} className="font-semibold wallet-text-strong">
        {t('txReview.requestSummary')}
      </h4>
      <dl className="mt-2 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <dt className="wallet-muted">{t('txReview.network')}</dt>
          <dd className="font-medium wallet-text-strong">
            {network === 'chipnet' ? 'Chipnet' : 'Mainnet'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="wallet-muted">{t('txReview.action')}</dt>
          <dd className="text-right font-medium wallet-text-strong">
            {operation === 'sign-and-broadcast'
              ? t('txReview.signAndBroadcast')
              : t('txReview.signAndReturn')}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="wallet-muted">{t('txReview.estimatedNetworkFee')}</dt>
          <dd className="font-medium wallet-text-strong">
            {formatBch(preview.fee)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs wallet-muted">{t('txReview.feeScope')}</p>
      <details className="mt-3 rounded-xl border border-[var(--wallet-border)] px-3 py-2">
        <summary className="cursor-pointer font-semibold wallet-text-strong">
          {t('txReview.technicalTotals')}
        </summary>
        <dl className="mt-2 space-y-1 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="wallet-muted">{t('txReview.totalInput')}</dt>
            <dd className="font-mono wallet-text-strong">
              {formatBch(preview.totalInput)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="wallet-muted">{t('txReview.totalOutput')}</dt>
            <dd className="font-mono wallet-text-strong">
              {formatBch(preview.totalOutput)}
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

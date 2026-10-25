import { useEffect, useId, useState } from 'react';
import {
  deriveConnectorWalletEffect,
  type ConnectorWalletEffect,
} from '../../services/connect/connectorWalletEffect';
import type { ConnectorTransactionPreview } from '../../services/connect/transactionPreview';
import { loadWalletPublicAddresses } from '../../services/connect/walletPublicAddresses';
import { useI18n } from '../../i18n/useI18n';

type Props = {
  preview: ConnectorTransactionPreview;
  walletId: number;
  tokenLabel?: string | null;
};

function bchEffect(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${(Number(absolute) / 100_000_000).toFixed(8)} BCH`;
}

function tokenEffect(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${absolute.toString()} atoms`;
}

export default function ConnectorWalletEffectSummary({
  preview,
  walletId,
  tokenLabel,
}: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const [effect, setEffect] = useState<ConnectorWalletEffect | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading'
  );

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setEffect(null);
    void (async () => {
      try {
        if (!walletId) throw new Error('No wallet selected');
        const addresses = await loadWalletPublicAddresses(walletId);
        const next = deriveConnectorWalletEffect(preview, addresses);
        if (cancelled) return;
        setEffect(next);
        setStatus(
          next.ownedInputCount > 0 || next.ownedOutputCount > 0
            ? 'ready'
            : 'unavailable'
        );
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preview, walletId]);

  if (status === 'loading') {
    return (
      <div role="status" className="wallet-card p-3 text-sm wallet-muted">
        Verifying this wallet’s inputs and change…
      </div>
    );
  }

  if (status !== 'ready' || !effect) {
    return (
      <div
        role="status"
        className="wallet-warning-panel rounded-xl p-3 text-sm"
      >
        Wallet-owned inputs and change could not be verified from this request.
        Review the whole transaction details carefully before signing.
      </div>
    );
  }

  return (
    <section
      role="status"
      aria-labelledby={titleId}
      className="wallet-card p-3 text-sm space-y-3"
    >
      <div>
        <h4 id={titleId} className="font-semibold wallet-text-strong">
          {t('txReview.walletEffect')}
        </h4>
        <p className="mt-1 text-xs wallet-muted">
          {t('txReview.walletEffectHelp')}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {effect.bchDeltaSats !== 0n && (
          <div className="rounded-xl border border-[var(--wallet-border)] p-3">
            <div className="text-xs wallet-muted">
              {effect.bchDeltaSats < 0n
                ? t('txReview.spend')
                : t('txReview.receive')}
            </div>
            <div className="mt-1 text-base font-semibold wallet-text-strong">
              {bchEffect(effect.bchDeltaSats)}
            </div>
          </div>
        )}

        {effect.tokenEffects.map((token) => (
          <div
            key={token.category}
            className="rounded-xl border border-[var(--wallet-border)] p-3"
          >
            <div className="text-xs wallet-muted">
              {(
                token.fungibleDelta !== 0n
                  ? token.fungibleDelta < 0n
                  : token.nftDelta < 0
              )
                ? t('txReview.spend')
                : t('txReview.receive')}{' '}
              {tokenLabel ?? t('txReview.token')}
            </div>
            {token.fungibleDelta !== 0n && (
              <div className="mt-1 text-base font-semibold wallet-text-strong">
                {tokenEffect(token.fungibleDelta)}
              </div>
            )}
            {token.nftDelta !== 0 && (
              <div className="mt-1 font-medium wallet-text-strong">
                {Math.abs(token.nftDelta)} {t('txReview.nft')}
                {Math.abs(token.nftDelta) === 1 ? '' : 's'}
              </div>
            )}
          </div>
        ))}
      </div>

      {effect.tokenEffects.map((token) => (
        <details
          key={`identity-${token.category}`}
          className="rounded-xl border border-[var(--wallet-border)] px-3 py-2"
        >
          <summary className="cursor-pointer font-semibold wallet-text-strong">
            {t('txReview.tokenIdentity')}
          </summary>
          <div className="mt-2 break-all font-mono text-xs wallet-muted">
            {token.category}
          </div>
        </details>
      ))}

      <p className="text-xs wallet-muted">
        Matched {effect.ownedInputCount} wallet input
        {effect.ownedInputCount === 1 ? '' : 's'} and {effect.ownedOutputCount}{' '}
        wallet output{effect.ownedOutputCount === 1 ? '' : 's'} by locking
        bytecode. Whole-transaction fees can include other participants.
      </p>
    </section>
  );
}

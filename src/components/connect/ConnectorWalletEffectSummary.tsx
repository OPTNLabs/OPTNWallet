import { useEffect, useId, useMemo, useState } from 'react';
import {
  deriveConnectorWalletEffect,
  type ConnectorWalletEffect,
} from '../../services/connect/connectorWalletEffect';
import type { ConnectorTransactionPreview } from '../../services/connect/transactionPreview';
import { loadWalletPublicAddresses } from '../../services/connect/walletPublicAddresses';
import { useI18n } from '../../i18n/useI18n';
import useSharedTokenMetadata, {
  type SharedTokenMetadata,
} from '../../hooks/useSharedTokenMetadata';
import {
  formatAtomicTokenAmount,
  shortTokenCategory,
} from '../../utils/tokenPresentation';
import { getBcmrMetadataStatusLabel } from '../../types/bcmr';
import InfoButton from '../ui/InfoButton';

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

function hasVerifiedTokenName(
  category: string,
  metadata?: SharedTokenMetadata
): boolean {
  const name = metadata?.name?.trim();
  return Boolean(
    metadata?.snapshot && name && name.toLowerCase() !== category.toLowerCase()
  );
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
  const tokenCategories = useMemo(
    () =>
      Array.from(
        new Set(
          [...preview.inputs, ...preview.outputs]
            .map((item) => item.token?.category)
            .filter((category): category is Uint8Array => category != null)
            .map((category) =>
              Array.from(category)
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('')
            )
        )
      ),
    [preview]
  );
  const tokenMetadata = useSharedTokenMetadata(tokenCategories);

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
      <div
        role="status"
        className="wallet-card flex items-center gap-1 p-3 text-sm wallet-muted"
      >
        <span>{t('txReview.verifyingWalletEffect')}</span>
        <InfoButton
          id="connector-wallet-effect-loading-help"
          ariaLabel={t('txReview.walletEffect')}
          content={t('txReview.walletEffectHelp')}
        />
      </div>
    );
  }

  if (status !== 'ready' || !effect) {
    return (
      <div
        role="status"
        className="wallet-warning-panel flex items-start gap-1 rounded-xl p-3 text-sm"
      >
        <span>{t('txReview.walletEffectUnavailable')}</span>
        <InfoButton
          id="connector-wallet-effect-unavailable-help"
          ariaLabel={t('txReview.walletEffect')}
          content={t('txReview.walletEffectHelp')}
        />
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

        {effect.tokenEffects.map((token) =>
          (() => {
            const metadata = tokenMetadata[token.category];
            const verifiedName = hasVerifiedTokenName(token.category, metadata)
              ? metadata?.name.trim()
              : null;
            const verifiedSymbol = metadata?.symbol?.trim() || null;
            const displayLabel =
              verifiedName || verifiedSymbol || t('txReview.token');
            const appLabelDiffers = Boolean(
              tokenLabel &&
                (!verifiedName ||
                  tokenLabel.trim().toLowerCase() !==
                    verifiedName.toLowerCase())
            );
            const decimals = metadata?.decimals ?? 0;
            const absoluteAmount =
              token.fungibleDelta < 0n
                ? -token.fungibleDelta
                : token.fungibleDelta;
            const formattedAmount =
              decimals > 0
                ? `${formatAtomicTokenAmount(absoluteAmount, decimals)} ${displayLabel} (${tokenEffect(token.fungibleDelta)})`
                : `${tokenEffect(token.fungibleDelta)} ${displayLabel}`;

            return (
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
                  {displayLabel}
                </div>
                {token.fungibleDelta !== 0n && (
                  <div className="mt-1 text-base font-semibold wallet-text-strong">
                    {formattedAmount}
                  </div>
                )}
                {token.nftDelta !== 0 && (
                  <div className="mt-1 font-medium wallet-text-strong">
                    {Math.abs(token.nftDelta)} {t('txReview.nft')}
                    {Math.abs(token.nftDelta) === 1 ? '' : 's'}
                  </div>
                )}
                <div className="mt-2 text-xs wallet-muted">
                  {metadata
                    ? t('txReview.bcmrStatus', {
                        status: getBcmrMetadataStatusLabel(metadata),
                      })
                    : t('txReview.bcmrIdentifying')}
                  {appLabelDiffers ? (
                    <span className="ml-2">
                      {t('txReview.appLabel')}: {tokenLabel}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })()
        )}
      </div>

      {effect.tokenEffects.map((token) =>
        (() => {
          const metadata = tokenMetadata[token.category];
          const verifiedName = hasVerifiedTokenName(token.category, metadata)
            ? metadata?.name.trim()
            : null;
          const verifiedSymbol = metadata?.symbol?.trim() || null;
          const label = verifiedName || verifiedSymbol || t('txReview.token');

          return (
            <details
              key={`identity-${token.category}`}
              className="rounded-xl border border-[var(--wallet-border)] px-3 py-2"
            >
              <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold wallet-text-strong">
                {t('txReview.tokenIdentity')} · {label}
              </summary>
              <div className="mt-2 space-y-1 text-xs wallet-muted">
                <div>
                  {t('txReview.bcmr')}:{' '}
                  {metadata
                    ? getBcmrMetadataStatusLabel(metadata)
                    : t('txReview.identifyingToken')}
                </div>
                <div>
                  {t('wc.tokenCategory')}: {shortTokenCategory(token.category)}
                </div>
                <div className="break-all font-mono">{token.category}</div>
              </div>
            </details>
          );
        })()
      )}

      <p className="text-xs wallet-muted">
        {t('txReview.matchedWalletEffect', {
          inputs: effect.ownedInputCount,
          outputs: effect.ownedOutputCount,
        })}
      </p>
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link } from 'react-router-dom';
import Popup from '../../components/transaction/Popup';
import StatusChip from '../../components/ui/StatusChip';
import type {
  BcmrTokenMetadata,
  Token,
  TransactionDetails,
  TransactionDetailParticipant,
} from '../../types/types';
import ElectrumService from '../../services/ElectrumService';
import BcmrService from '../../services/BcmrService';
import { normalizeHexId } from '../../services/bcmr';
import TransactionManager from '../../apis/TransactionManager/TransactionManager';
import { addTransactions } from '../../state/slices/transactionSlice';
import { selectWalletId } from '../../state/slices/walletSlice';
import { isTxConfirmed } from '../../utils/txConfirmation';
import { useI18n } from '../../i18n/useI18n';
import { formatDate, formatNumber } from '../../i18n/format';
import type { SupportedLocale } from '../../i18n/types';
import { handleExternalLinkClick } from '../../utils/openExternalLink';
import { isDesktopPlatform } from '../../utils/platform';
import { deriveWalletTransactionEffect } from './transactionEffect';
import MaskedValue from '../../components/ui/MaskedValue';
import InfoButton from '../../components/ui/InfoButton';
import { logError } from '../../utils/errorHandling';

type Props = {
  txid: string;
  txHeight: number;
  // `null` only when the selected explorer template cannot produce a URL.
  explorerUrl: string | null;
  explorerReason?: string | null;
  walletAddresses: Set<string>;
  onClose: () => void;
};

const SATS_PER_BCH = 100_000_000;

function formatSats(
  amountSats: number | undefined,
  locale: SupportedLocale,
  unknown: string
): string {
  if (amountSats == null || !Number.isFinite(amountSats)) return unknown;
  return `${formatNumber(amountSats / SATS_PER_BCH, locale, {
    maximumFractionDigits: 8,
  })} BCH`;
}

function formatFeeRate(
  feeSats: number | undefined,
  sizeBytes: number | undefined,
  locale: SupportedLocale,
  unknown: string
): string {
  if (
    feeSats == null ||
    sizeBytes == null ||
    !Number.isFinite(feeSats) ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0
  ) {
    return unknown;
  }
  return `${formatNumber(feeSats / sizeBytes, locale, {
    maximumFractionDigits: 2,
  })} sat/byte`;
}

function formatTimestamp(
  locale: SupportedLocale,
  timestamp: string | undefined,
  unavailable: string
): string {
  if (!timestamp) return unavailable;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return unavailable;
  return formatDate(date, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatTokenAmount(amount: Token['amount']): string {
  return typeof amount === 'bigint' ? amount.toString() : String(amount);
}

function formatTokenAmountWithDecimals(
  amount: Token['amount'],
  decimals: number
): string {
  const raw = formatTokenAmount(amount);
  const places = Number.isInteger(decimals) && decimals > 0 ? decimals : 0;
  if (places === 0 || !/^-?\d+$/.test(raw)) return raw;

  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).padStart(places + 1, '0');
  const integer = digits.slice(0, -places) || '0';
  const fraction = digits.slice(-places);
  return `${negative ? '-' : ''}${integer}.${fraction}`;
}

type TokenMetadataByCategory = Record<string, BcmrTokenMetadata | null>;

function markWalletParticipants(
  rows: TransactionDetailParticipant[],
  walletAddresses: Set<string>
): TransactionDetailParticipant[] {
  return rows.map((row) => ({
    ...row,
    isWalletAddress: walletAddresses.has(row.address),
  }));
}

function Section({
  title,
  rows,
  tokenMetadataByCategory,
}: {
  title: string;
  rows: TransactionDetailParticipant[];
  tokenMetadataByCategory: TokenMetadataByCategory;
}) {
  const { locale, t } = useI18n();
  return (
    <section className="wallet-card p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold wallet-text-strong">{title}</h3>
        <span className="text-xs wallet-muted">{rows.length}</span>
      </div>

      <div className="space-y-3">
        {rows.length === 0 ? (
          <div className="text-sm wallet-muted">{t('history.noData')}</div>
        ) : (
          rows.map((row, index) => {
            const tokenCategory = row.token
              ? normalizeHexId(row.token.category)
              : '';
            const tokenMetadata = tokenCategory
              ? tokenMetadataByCategory[tokenCategory]
              : null;

            return (
              <div
                key={`${title}-${row.address}-${row.outputIndex ?? 'na'}-${index}`}
                className="rounded-2xl border border-[var(--wallet-border)] p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <MaskedValue
                      value={row.address}
                      label={t('send.address')}
                      copySuccessMessageKey="receive.addressCopied"
                      preserveCashAddressPrefix
                      prefixLength={5}
                      suffixLength={5}
                      className="block max-w-full break-all text-xs"
                    />
                    {typeof row.outputIndex === 'number' ? (
                      <div className="text-xs wallet-muted mt-1">
                        {t('history.output')} #{row.outputIndex}
                      </div>
                    ) : null}
                  </div>
                  {row.isWalletAddress ? (
                    <StatusChip tone="neutral">
                      {t('history.yourWallet')}
                    </StatusChip>
                  ) : null}
                </div>
                <div className="text-sm mt-2 wallet-text-strong">
                  {formatSats(row.amountSats, locale, t('history.unknown'))}
                </div>
                {row.token ? (
                  <div className="mt-3 space-y-2 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] p-3 text-xs">
                    {tokenMetadata ? (
                      <div className="text-sm font-semibold wallet-text-strong">
                        {tokenMetadata.name}
                        {tokenMetadata.token.symbol
                          ? ` (${tokenMetadata.token.symbol})`
                          : ''}
                      </div>
                    ) : null}
                    <div>
                      <div className="wallet-muted">
                        {t('send.tokenCategory')}
                      </div>
                      <MaskedValue
                        value={row.token.category}
                        label={t('send.tokenCategory')}
                        copySuccessMessageKey="receive.addressCopied"
                        prefixLength={5}
                        suffixLength={5}
                        className="block max-w-full text-xs"
                      />
                    </div>
                    <div className="font-mono text-right wallet-text-strong">
                      {tokenMetadata
                        ? `${formatTokenAmountWithDecimals(
                            row.token.amount,
                            tokenMetadata.token.decimals
                          )}${
                            tokenMetadata.token.symbol
                              ? ` ${tokenMetadata.token.symbol}`
                              : ''
                          }`
                        : formatTokenAmount(row.token.amount)}
                    </div>
                    {row.token.nft ? (
                      <>
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="wallet-muted">
                            {t('builder.capability')}
                          </span>
                          <span className="wallet-text-strong">
                            {row.token.nft.capability}
                          </span>
                        </div>
                        <div>
                          <div className="wallet-muted">
                            {t('send.nftCommitment')}
                          </div>
                          <MaskedValue
                            value={row.token.nft.commitment}
                            label={t('send.nftCommitment')}
                            copySuccessMessageKey="receive.addressCopied"
                            prefixLength={5}
                            suffixLength={5}
                            className="block max-w-full text-xs"
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export default function TransactionDetailPopup({
  txid,
  txHeight,
  explorerUrl,
  explorerReason,
  walletAddresses,
  onClose,
}: Props) {
  const { locale, t } = useI18n();
  const walletId = useSelector(selectWalletId);
  const dispatch = useDispatch();
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [tokenMetadataByCategory, setTokenMetadataByCategory] =
    useState<TokenMetadataByCategory>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const next = await ElectrumService.getTransactionDetails(txid, {
          forceRefresh: true,
        });
        if (!cancelled) {
          setDetails(next);
          if (!next) setError(t('history.detailsUnavailable'));
          // Write confirmed height back so Home/list stop showing Unconfirmed
          // for fusion rows that were inserted with height 0 at broadcast.
          // Verbose Electrum often has confs without height — derive via tip.
          if (next && walletId > 0 && isTxConfirmed(next)) {
            const { resolveConfirmedBlockHeight } = await import(
              '../../services/historyHeightBackfill'
            );
            const height = await resolveConfirmedBlockHeight(next);
            if (height != null && height > 0) {
              dispatch(
                addTransactions({
                  wallet_id: walletId,
                  transactions: [
                    {
                      tx_hash: txid,
                      height,
                      timestamp: next.timestamp,
                    },
                  ],
                })
              );
              void TransactionManager()
                .applyConfirmedHeight(walletId, txid, height, next.timestamp)
                .catch(() => undefined);
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          logError('TransactionDetailPopup.loadDetails', err, { txid });
          setError(t('history.loadDetailsFailed'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [txid, walletId, dispatch, t, retryCount]);

  useEffect(() => {
    const categories = Array.from(
      new Set(
        [...(details?.inputs ?? []), ...(details?.outputs ?? [])]
          .map((row) => (row.token ? normalizeHexId(row.token.category) : ''))
          .filter(Boolean)
      )
    );

    setTokenMetadataByCategory({});
    if (categories.length === 0) return;

    let cancelled = false;
    const bcmr = new BcmrService();

    void Promise.all(
      categories.map(async (category) => {
        const metadata = await bcmr.resolveSnapshot(category);
        return [category, metadata] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      setTokenMetadataByCategory(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [details]);

  const markedInputs = useMemo(
    () => markWalletParticipants(details?.inputs ?? [], walletAddresses),
    [details?.inputs, walletAddresses]
  );
  const markedOutputs = useMemo(
    () => markWalletParticipants(details?.outputs ?? [], walletAddresses),
    [details?.outputs, walletAddresses]
  );
  const walletEffect = details
    ? deriveWalletTransactionEffect(details, walletAddresses)
    : null;

  return (
    <Popup closePopups={onClose} closeButtonText={t('history.closeDetails')}>
      <div className="space-y-4 p-1">
        <div>
          <div className="text-xs wallet-muted mb-1">
            {t('history.transactionId')}
          </div>
          <MaskedValue
            value={txid}
            label={t('history.transactionId')}
            ariaLabel={t('history.copyTransaction')}
            copySuccessMessageKey="history.transactionCopied"
            prefixLength={5}
            suffixLength={5}
            className="block w-full text-sm"
          />
        </div>

        <section className="wallet-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-1 text-xs wallet-muted mb-1">
                <span>{t('history.status')}</span>
                <InfoButton
                  id="transaction-status-help"
                  ariaLabel={t('history.statusHelpLabel')}
                  content={t('history.statusHelp')}
                  popoverSide="center"
                />
              </div>
              <div className="text-sm wallet-text-strong">
                {loading
                  ? t('history.loadingDetails')
                  : isTxConfirmed({
                        confirmations: details?.confirmations,
                        height: details?.height ?? txHeight,
                      })
                    ? `${details?.confirmations ?? 1} confirmation${
                        (details?.confirmations ?? 1) === 1 ? '' : 's'
                      }`
                    : t('history.unconfirmed')}
              </div>
            </div>
            {loading ? (
              <StatusChip tone="neutral">
                {t('history.loadingDetails')}
              </StatusChip>
            ) : isTxConfirmed({
                confirmations: details?.confirmations,
                height: details?.height ?? txHeight,
              }) ? (
              <StatusChip tone="success">{t('history.confirmed')}</StatusChip>
            ) : (
              <StatusChip tone="warning">{t('history.unconfirmed')}</StatusChip>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
            <div>
              <div className="text-xs wallet-muted">{t('history.block')}</div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : details?.height ??
                    (txHeight > 0 ? txHeight : t('history.unconfirmed'))}
              </div>
            </div>
            <div>
              <div className="text-xs wallet-muted">{t('history.fee')}</div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : formatSats(details?.feeSats, locale, t('history.unknown'))}
              </div>
            </div>
            <div>
              <div className="text-xs wallet-muted">
                {t('history.walletEffect')}
              </div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : formatSats(
                      walletEffect?.bchDeltaSats,
                      locale,
                      t('history.unknown')
                    )}
              </div>
            </div>
            <div>
              <div className="text-xs wallet-muted">{t('history.feeRate')}</div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : formatFeeRate(
                      details?.feeSats,
                      details?.sizeBytes,
                      locale,
                      t('history.unknown')
                    )}
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs wallet-muted">
                {t('history.timestamp')}
              </div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : formatTimestamp(
                      locale,
                      details?.timestamp,
                      t('history.unavailable')
                    )}
              </div>
            </div>
            <div className="col-span-2">
              {explorerUrl ? (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline wallet-text-strong"
                  onClick={(event) =>
                    handleExternalLinkClick(
                      event,
                      t('history.openExplorerFailed')
                    )
                  }
                >
                  {t('history.openExplorer')}
                </a>
              ) : explorerReason ? (
                <p className="text-sm wallet-muted" role="status">
                  {explorerReason}{' '}
                  <Link
                    to={
                      isDesktopPlatform()
                        ? '/settings?panel=server'
                        : '/settings?panel=explorer'
                    }
                    className="underline wallet-text-strong"
                  >
                    {isDesktopPlatform()
                      ? t('history.openNetworkSettings')
                      : t('history.openExplorerSettings')}
                  </Link>
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {loading ? (
          <div className="wallet-card p-4 text-sm wallet-muted">
            {t('history.loadingDetails')}
          </div>
        ) : error ? (
          <div className="wallet-card p-4" role="alert">
            <p className="text-sm wallet-danger-text">{error}</p>
            <button
              type="button"
              className="wallet-btn-secondary mt-3 min-h-[44px] px-4 py-2 text-sm"
              onClick={() => setRetryCount((count) => count + 1)}
            >
              {t('builder.tryAgain')}
            </button>
          </div>
        ) : (
          <>
            <Section
              title={t('history.senders')}
              rows={markedInputs}
              tokenMetadataByCategory={tokenMetadataByCategory}
            />
            <Section
              title={t('history.recipients')}
              rows={markedOutputs}
              tokenMetadataByCategory={tokenMetadataByCategory}
            />
          </>
        )}
      </div>
    </Popup>
  );
}

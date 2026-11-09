import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import Draggable from 'react-draggable';
import { AssetType, ReviewState, SimpleSendInput, TokenMetaMap } from './types';
import { formatFtAmount } from './utils';
import { resolveTokenPresentation } from '../../utils/tokenPresentation';
import { coinDepth } from '../../platform/desktop/fusionCoinDepth';
import { outpointKey } from '../../platform/desktop/CoinLabelService';
import { FusionBadge } from '../../components/FusionBadge';
import { StealthBadge } from '../../components/StealthBadge';
import { selectWalletId } from '../../state/slices/walletSlice';
import type { RootState } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import NetworkContextBanner from '../../components/ui/NetworkContextBanner';
import MaskedValue from '../../components/ui/MaskedValue';

type ReviewCardProps = {
  open: boolean;
  review: ReviewState;
  recipient: string;
  networkLabel?: string;
  assetType: AssetType;
  amountBch: string;
  fiatSummary: { amountUsd: number; feeUsd: number; totalUsd: number };
  selectedCategory: string;
  tokenMeta: TokenMetaMap;
  displayNameFor: (category: string) => string;
  selectedForTx: SimpleSendInput[];
  rawHexLen: number;
  isSending: boolean;
  /** Optional live status (hardware: "Confirm on Ledger…"). */
  sendStatus?: string;
  isHardwareWallet?: boolean;
  /** Optional policy context shown by isolated transaction surfaces. */
  reviewContext?: string;
  onClose: () => void;
  onConfirmSend: () => void;
};

export function ReviewCard({
  open,
  review,
  recipient,
  networkLabel,
  assetType,
  amountBch,
  fiatSummary,
  selectedCategory,
  tokenMeta,
  displayNameFor,
  selectedForTx,
  rawHexLen,
  isSending,
  sendStatus = '',
  isHardwareWallet = false,
  reviewContext,
  onClose,
  onConfirmSend,
}: ReviewCardProps) {
  const { t } = useI18n();
  const walletId = useSelector(selectWalletId);
  const rpaRecord = useSelector((state: RootState) =>
    walletId > 0
      ? state.walletSpecialActivity.byWallet[walletId]?.rpa ?? null
      : null
  );
  const stealthKeys = useMemo(() => {
    const keys = new Set<string>();
    if (rpaRecord && 'unspentOutputs' in rpaRecord.payload) {
      for (const output of rpaRecord.payload.unspentOutputs) {
        keys.add(outpointKey(output.txHash, output.outputIndex));
      }
    }
    return keys;
  }, [rpaRecord]);
  const HANDLE_SIZE = 56;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const isSendingRef = useRef(isSending);
  const trackRef = useRef<HTMLDivElement>(null);
  const confirmedRef = useRef(false);
  const [dragX, setDragX] = useState(0);
  const [maxX, setMaxX] = useState(0);
  const [slideCompleted, setSlideCompleted] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  onCloseRef.current = onClose;
  isSendingRef.current = isSending;

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const getFocusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter(
        (element) =>
          !element.closest('[hidden]') &&
          element.getAttribute('aria-hidden') !== 'true'
      );

    if (closeButtonRef.current && !closeButtonRef.current.disabled) {
      closeButtonRef.current.focus();
    } else {
      getFocusable()[0]?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!isSendingRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setDragX(0);
      setSlideCompleted(false);
      confirmedRef.current = false;
      setMaxX(0);
      setShowTechnicalDetails(false);
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const updateMaxX = () => {
      const width = trackRef.current?.offsetWidth ?? 0;
      setMaxX(Math.max(0, width - HANDLE_SIZE));
    };

    updateMaxX();
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;

    const resizeObserver = new ResizeObserver(() => updateMaxX());
    resizeObserver.observe(track);
    window.addEventListener('resize', updateMaxX);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateMaxX);
    };
  }, [open]);

  const technicalInputs = useMemo(
    () =>
      selectedForTx.map((u) => {
        const key = outpointKey(u.tx_hash, u.tx_pos);
        return {
          key,
          address: u.address ?? '',
          sats: Number(u.amount ?? u.value ?? 0),
          pending: typeof u.height === 'number' ? u.height <= 0 : false,
          depth: walletId > 0 ? coinDepth(walletId, key) : 0,
          stealth: stealthKeys.has(key),
        };
      }),
    [selectedForTx, stealthKeys, walletId]
  );

  const technicalOutputs = useMemo(
    () =>
      review.finalOutputs.map((out, i) => {
        if ('opReturn' in out && out.opReturn) {
          return {
            key: `opreturn-${i}`,
            label: 'OP_RETURN',
            value: out.opReturn.join(' | '),
            sats: 0,
          };
        }

        const rawAddress = out.recipientAddress || '';
        const tokenLabel = out.token
          ? out.token.nft
            ? `${displayNameFor(out.token.category)} NFT`
            : `${displayNameFor(out.token.category)} · ${String(out.token.amount ?? 0)}`
          : 'BCH';

        return {
          key: `${rawAddress}-${i}`,
          label: rawAddress,
          value: tokenLabel,
          sats: Number(out.amount || 0),
        };
      }),
    [displayNameFor, review.finalOutputs]
  );

  const technicalSummary = useMemo(() => {
    const inputCount = selectedForTx.length;
    const unconfirmedCount = selectedForTx.filter(
      (u) => typeof u.height === 'number' && u.height <= 0
    ).length;
    const contractCount = selectedForTx.filter(
      (u) => !!u.abi || !!u.contractName
    ).length;
    const tokenInputCount = selectedForTx.filter((u) => !!u.token).length;

    return {
      inputCount,
      unconfirmedCount,
      contractCount,
      tokenInputCount,
      txBytes: Math.ceil(rawHexLen / 2),
    };
  }, [rawHexLen, selectedForTx]);

  const tokenOutputSats = useMemo(() => {
    const tokenOutput = review.finalOutputs.find(
      (output) => !('opReturn' in output) && !!output.token
    );
    return tokenOutput && !('opReturn' in tokenOutput)
      ? Number(tokenOutput.amount ?? 0)
      : 0;
  }, [review.finalOutputs]);

  const reviewedTokenOutput = useMemo(() => {
    if (assetType === 'bch' || !selectedCategory) return null;
    const category = selectedCategory.toLowerCase();
    return (
      review.finalOutputs.find(
        (output) =>
          !('opReturn' in output) &&
          output.token?.category.toLowerCase() === category &&
          (assetType === 'nft' ? !!output.token.nft : !output.token.nft)
      ) ?? null
    );
  }, [assetType, review.finalOutputs, selectedCategory]);

  const reviewedToken =
    reviewedTokenOutput && !('opReturn' in reviewedTokenOutput)
      ? reviewedTokenOutput.token
      : undefined;
  const reviewedTokenRecipient =
    reviewedTokenOutput && !('opReturn' in reviewedTokenOutput)
      ? reviewedTokenOutput.recipientAddress
      : '';
  const reviewTokenIssue =
    assetType !== 'bch' && !reviewedToken
      ? 'The built transaction does not contain the selected CashToken output. Close this review and prepare it again.'
      : '';
  const canConfirmReview = !reviewTokenIssue;
  const reviewedTokenPresentation = selectedCategory
    ? resolveTokenPresentation(selectedCategory, tokenMeta[selectedCategory])
    : null;
  const reviewedFtAmount =
    assetType === 'ft' && reviewedToken && reviewedTokenPresentation
      ? formatFtAmount(
          BigInt(reviewedToken.amount ?? 0),
          reviewedTokenPresentation.decimals
        )
      : '';
  const reviewedNft = assetType === 'nft' ? reviewedToken?.nft : undefined;
  const reviewedNftCapabilityLabel = reviewedNft
    ? reviewedNft.capability === 'minting'
      ? t('assets.mintingNfts')
      : reviewedNft.capability === 'mutable'
        ? t('assets.mutableNfts')
        : t('assets.plainNfts')
    : '';
  const reviewedNftCapabilityDescription = reviewedNft
    ? reviewedNft.capability === 'minting'
      ? t('assets.mintingNftsDescription')
      : reviewedNft.capability === 'mutable'
        ? t('assets.mutableNftsDescription')
        : t('assets.plainNftsDescription')
    : '';

  if (!open) return null;

  const threshold = Math.max(0, maxX - 1);
  const progressRatio = Math.min(1, Math.max(0, dragX / Math.max(1, maxX)));
  const nearingSend =
    canConfirmReview &&
    !isSending &&
    !slideCompleted &&
    maxX > 0 &&
    progressRatio >= 0.9;
  const progressHue = Math.round(progressRatio * 120);
  const pendingTrackBg = `hsl(${progressHue} 80% 95%)`;
  const pendingTrackBorder = `hsl(${progressHue} 65% 80%)`;
  const pendingFill = `hsla(${progressHue}, 80%, 42%, 0.24)`;
  const pendingText = `hsl(${progressHue} 72% 35%)`;
  const pendingHandle = `hsl(${progressHue} 82% 44%)`;
  const pendingHandleShadow = `0 8px 24px hsla(${progressHue}, 82%, 44%, 0.35)`;

  const confirm = () => {
    if (
      !canConfirmReview ||
      slideCompleted ||
      isSending ||
      confirmedRef.current
    )
      return;
    confirmedRef.current = true;
    setDragX(maxX);
    setSlideCompleted(true);
    onConfirmSend();
  };

  const handleStop = (_: unknown, data: { x: number }) => {
    if (slideCompleted || isSending || maxX <= 0) return;

    const finalX = Math.min(Math.max(0, data.x), maxX);
    if (finalX >= threshold) {
      confirm();
      return;
    }

    setDragX(0);
    setSlideCompleted(false);
  };

  const progress = Math.min(100, (dragX / Math.max(1, maxX)) * 100);

  return (
    <div
      ref={dialogRef}
      className="wallet-popup-backdrop z-[1100] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="send-review-title"
      aria-describedby="send-review-guidance"
      tabIndex={-1}
    >
      <div className="wallet-popup-panel w-full max-w-xl p-0 overflow-hidden">
        <div className="px-5 pt-4 pb-4 wallet-surface border-b border-[var(--wallet-border)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2
                id="send-review-title"
                className="text-xl font-bold wallet-text-strong"
              >
                {t('send.reviewTitle')}
              </h2>
              <p
                id="send-review-guidance"
                className="text-sm wallet-muted mt-1"
              >
                {t('send.verifySlide')}
              </p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              disabled={isSending}
              className="wallet-btn-secondary min-h-[44px] px-3 py-1.5 text-xs"
            >
              {t('receive.close')}
            </button>
          </div>
          {reviewContext && (
            <div className="mt-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] px-3 py-2 text-xs wallet-muted">
              {reviewContext}
            </div>
          )}
          {networkLabel ? (
            <NetworkContextBanner network={networkLabel} className="mt-3" />
          ) : null}
        </div>

        <div className="p-4 space-y-4 max-h-[56vh] overflow-y-auto">
          <div className="rounded-2xl border wallet-keyline wallet-signature-panel p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="wallet-kicker">{t('send.summary')}</div>
            </div>
            <div className="text-sm space-y-2">
              <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] px-3 py-2.5">
                <div className="text-xs font-semibold wallet-text-strong">
                  {t('send.walletEffect')}
                </div>
                <div className="mt-1 text-xs wallet-muted">
                  {t('send.walletEffectDescription')}
                </div>
              </div>
              {networkLabel ? (
                <div className="wallet-stat-row">
                  <span className="font-medium">{t('send.network')}</span>
                  <span className="wallet-text-strong">{networkLabel}</span>
                </div>
              ) : null}
              <div className="wallet-stat-row">
                <span className="font-medium">{t('send.to')}</span>
                <MaskedValue
                  value={recipient}
                  label={t('send.to')}
                  ariaLabel={t('receive.copyAddress')}
                  copySuccessMessageKey="receive.addressCopied"
                  className="max-w-[60%] truncate wallet-text-strong"
                />
              </div>
              {review.rpaStealthAddress && (
                <div className="wallet-stat-row">
                  <span className="font-medium">
                    {t('send.stealthAddress')}
                  </span>
                  <MaskedValue
                    value={review.rpaStealthAddress}
                    label={t('send.stealthAddress')}
                    ariaLabel={t('receive.copyAddress')}
                    copySuccessMessageKey="receive.addressCopied"
                    className="max-w-[70%] break-all text-right wallet-text-strong"
                  />
                </div>
              )}

              {assetType === 'bch' && (
                <div className="wallet-stat-row">
                  <span className="font-medium">{t('send.amount')}</span>
                  <span className="wallet-text-strong">
                    {(Number.parseFloat(amountBch) || 0).toFixed(8)} BCH
                    {!!fiatSummary.amountUsd && (
                      <span className="opacity-70">
                        {' '}
                        · ${fiatSummary.amountUsd.toFixed(2)} USD
                      </span>
                    )}
                  </span>
                </div>
              )}

              {assetType !== 'bch' && reviewedToken && (
                <div className="wallet-stat-row">
                  <span className="font-medium">{t('send.asset')}</span>
                  <span className="font-mono wallet-text-strong">
                    {assetType.toUpperCase()} ·{' '}
                    {selectedCategory ? displayNameFor(selectedCategory) : '—'}
                    {assetType === 'ft' && reviewedFtAmount
                      ? ` · ${reviewedFtAmount}`
                      : ''}
                  </span>
                </div>
              )}

              {assetType !== 'bch' && reviewedToken && (
                <div className="space-y-2 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] p-3">
                  <div>
                    <div className="text-xs font-medium wallet-muted">
                      {t('send.tokenCategory')}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs wallet-text-strong">
                      {reviewedToken.category}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium wallet-muted">
                      {t('send.to')}
                    </div>
                    <div className="mt-1 font-mono text-xs wallet-text-strong">
                      <MaskedValue
                        value={reviewedTokenRecipient}
                        label={t('send.to')}
                        ariaLabel={t('receive.copyAddress')}
                        copySuccessMessageKey="receive.addressCopied"
                        className="max-w-full break-all text-xs"
                      />
                    </div>
                  </div>
                  {reviewedNft && (
                    <>
                      <div className="wallet-stat-row items-start">
                        <span className="font-medium">
                          {t('builder.nftCapability')}
                        </span>
                        <span className="text-right wallet-text-strong">
                          {reviewedNftCapabilityLabel}
                        </span>
                      </div>
                      <div className="text-xs wallet-muted">
                        {reviewedNftCapabilityDescription}
                      </div>
                      <div>
                        <div className="text-xs font-medium wallet-muted">
                          {t('send.nftCommitment')}
                        </div>
                        <div className="mt-1 break-all font-mono text-xs wallet-text-strong">
                          {reviewedNft.commitment || '—'}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {reviewTokenIssue && (
                <div
                  role="alert"
                  className="rounded-xl border border-[var(--wallet-danger-border)] bg-[var(--wallet-danger-bg)] p-3 text-sm text-[var(--wallet-danger-text)]"
                >
                  {reviewTokenIssue}
                </div>
              )}

              {assetType !== 'bch' && tokenOutputSats > 0 && (
                <div className="wallet-stat-row">
                  <span className="font-medium">{t('send.attachedBch')}</span>
                  <span className="wallet-text-strong">
                    {(tokenOutputSats / 100_000_000).toFixed(8)} BCH
                  </span>
                </div>
              )}

              {review.tokenChange && (
                <div className="wallet-stat-row">
                  <span className="font-medium">{t('send.tokenChange')}</span>
                  <span
                    className="font-mono wallet-text-strong"
                    title={review.tokenChange.amount.toString()}
                  >
                    {(() => {
                      const presentation = resolveTokenPresentation(
                        review.tokenChange!.category,
                        tokenMeta[review.tokenChange!.category]
                      );
                      const pretty = formatFtAmount(
                        review.tokenChange!.amount,
                        presentation.decimals
                      );
                      return `${pretty} ${presentation.primaryLabel}`;
                    })()}
                  </span>
                </div>
              )}
              <div className="wallet-stat-row">
                <span className="font-medium">{t('send.fee')}</span>
                <span className="wallet-text-strong">
                  {(review.feeSats / 100_000_000).toFixed(8)} BCH
                  {!!fiatSummary.feeUsd && (
                    <span className="opacity-70">
                      {' '}
                      · ${fiatSummary.feeUsd.toFixed(2)} USD
                    </span>
                  )}
                </span>
              </div>
              <div className="wallet-stat-row">
                <span className="font-medium">{t('send.totalBch')}</span>
                <span className="wallet-text-strong">
                  {(review.totalSats / 100_000_000).toFixed(8)} BCH
                  {!!fiatSummary.totalUsd && (
                    <span className="opacity-70">
                      {' '}
                      · ${fiatSummary.totalUsd.toFixed(2)} USD
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--wallet-border)] wallet-surface-strong p-3 text-sm">
            <button
              type="button"
              className="flex min-h-[44px] w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] px-3 py-2.5 text-left shadow-sm"
              onClick={() => setShowTechnicalDetails((prev) => !prev)}
            >
              <span className="font-semibold wallet-text-strong">
                {t('send.technicalDetails')}
              </span>
              <span className="text-xs wallet-muted">
                {showTechnicalDetails ? t('send.hide') : t('send.show')}
              </span>
            </button>

            {showTechnicalDetails && (
              <div className="mt-3 space-y-3">
                <div className="space-y-1 text-xs">
                  <div className="wallet-stat-row">
                    <span className="wallet-muted">{t('send.inputs')}</span>
                    <span className="font-mono wallet-text-strong">
                      {technicalSummary.inputCount}
                    </span>
                  </div>
                  <div className="wallet-stat-row">
                    <span className="wallet-muted">
                      {t('send.transactionSize')}
                    </span>
                    <span className="font-mono wallet-text-strong">
                      {technicalSummary.txBytes} {t('send.bytes')}
                    </span>
                  </div>
                  <div className="wallet-stat-row">
                    <span className="wallet-muted">
                      {t('send.tokenInputs')}
                    </span>
                    <span className="font-mono wallet-text-strong">
                      {technicalSummary.tokenInputCount}
                    </span>
                  </div>
                  <div className="wallet-stat-row">
                    <span className="wallet-muted">
                      {t('send.unconfirmedInputs')}
                    </span>
                    <span className="font-mono wallet-text-strong">
                      {technicalSummary.unconfirmedCount}
                    </span>
                  </div>
                  {technicalSummary.contractCount > 0 && (
                    <div className="wallet-stat-row">
                      <span className="wallet-muted">
                        {t('send.contractInputs')}
                      </span>
                      <span className="font-mono wallet-text-strong">
                        {technicalSummary.contractCount}
                      </span>
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface px-3 py-2.5">
                  <div className="mb-2 text-xs font-semibold wallet-muted">
                    {t('send.inputsUsed')}
                  </div>
                  <div className="space-y-1.5">
                    {technicalInputs.map((input) => (
                      <div
                        key={input.key}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-mono wallet-text-strong truncate">
                            {input.address ? (
                              <MaskedValue
                                value={input.address}
                                label={t('receive.copyAddress')}
                                ariaLabel={t('receive.copyAddress')}
                                copySuccessMessageKey="receive.addressCopied"
                                className="max-w-[14rem] truncate align-middle"
                              />
                            ) : (
                              '—'
                            )}
                            {input.depth > 0 && (
                              <FusionBadge
                                depth={input.depth}
                                className="ml-1.5"
                              />
                            )}
                            {input.stealth && (
                              <StealthBadge className="ml-1.5" />
                            )}
                          </div>
                          {input.pending && (
                            <div className="wallet-muted">
                              {t('send.pending')}
                            </div>
                          )}
                        </div>
                        <div className="font-mono wallet-text-strong shrink-0">
                          {input.sats} sats
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface px-3 py-2.5">
                  <div className="mb-2 text-xs font-semibold wallet-muted">
                    {t('send.outputsCreated')}
                  </div>
                  <div className="space-y-1.5">
                    {technicalOutputs.map((output) => (
                      <div
                        key={output.key}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-mono wallet-text-strong truncate">
                            {output.label === 'OP_RETURN' || !output.label ? (
                              output.label || '—'
                            ) : (
                              <MaskedValue
                                value={output.label}
                                label={t('receive.copyAddress')}
                                ariaLabel={t('receive.copyAddress')}
                                copySuccessMessageKey="receive.addressCopied"
                                className="max-w-[14rem] truncate align-middle"
                              />
                            )}
                          </div>
                          <div className="wallet-muted truncate">
                            {output.value}
                          </div>
                        </div>
                        <div className="font-mono wallet-text-strong shrink-0">
                          {output.sats} sats
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="px-4 pb-4 pt-3 wallet-surface border-t border-[var(--wallet-border)]">
          <div
            role="status"
            aria-live="polite"
            className="text-[14px] wallet-muted mb-2.5 px-1"
          >
            {isSending
              ? sendStatus || t('send.sending')
              : slideCompleted
                ? t('send.confirmed')
                : nearingSend
                  ? t('send.releaseToSend')
                  : t('send.slideToConfirm')}
          </div>
          {isSending && isHardwareWallet && (
            <div
              className="text-[12px] mb-2.5 px-1"
              style={{ color: 'var(--wallet-warning-text, #d97706)' }}
            >
              Look at the Ledger screen and approve the amount/address with both
              buttons. Finalization waits on the device (not the computer).
            </div>
          )}

          <div
            ref={trackRef}
            className="relative w-full h-14 rounded-[18px] border overflow-hidden transition-colors"
            style={
              slideCompleted
                ? {
                    backgroundColor: 'var(--wallet-success-bg)',
                    borderColor: 'var(--wallet-success-border)',
                  }
                : {
                    backgroundColor: pendingTrackBg,
                    borderColor: pendingTrackBorder,
                  }
            }
          >
            <div
              className="absolute right-0 top-0 h-14 w-[18%] border-l pointer-events-none"
              style={{
                backgroundColor: 'var(--wallet-warning-bg)',
                borderColor: 'var(--wallet-warning-border)',
              }}
            />
            <div
              className="absolute left-0 top-0 h-14 pointer-events-none"
              style={{
                width: `${progress}%`,
                backgroundColor: slideCompleted
                  ? 'rgba(16,185,129,0.2)'
                  : pendingFill,
              }}
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
              <span
                className="text-[10px] font-bold tracking-wide"
                style={{
                  color: slideCompleted
                    ? 'var(--wallet-success-text)'
                    : pendingText,
                }}
              >
                {t('send.send')}
              </span>
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span
                className="text-[20px] leading-none tracking-[0.02em] font-semibold transition-colors"
                style={{
                  color: slideCompleted
                    ? 'var(--wallet-success-text)'
                    : pendingText,
                }}
              >
                {isSending
                  ? t('send.sending')
                  : slideCompleted
                    ? t('send.confirmed')
                    : nearingSend
                      ? t('send.releaseToSend')
                      : t('send.slideToConfirm')}
              </span>
            </div>
            <Draggable
              axis="x"
              bounds={{ left: 0, right: maxX }}
              position={{ x: dragX, y: 0 }}
              onDrag={(_, data) =>
                setDragX(Math.min(Math.max(0, data.x), maxX))
              }
              onStop={handleStop}
              disabled={
                !canConfirmReview || isSending || slideCompleted || maxX <= 0
              }
            >
              <div
                className="absolute left-0 top-0 h-14 w-14 rounded-[18px] flex items-center justify-center text-xl select-none transition-colors"
                style={
                  slideCompleted
                    ? {
                        backgroundColor: 'var(--wallet-accent-strong)',
                        color: 'var(--wallet-nav-text)',
                        boxShadow: 'var(--wallet-shadow-btn)',
                      }
                    : {
                        backgroundColor: pendingHandle,
                        color: 'var(--wallet-nav-text)',
                        boxShadow: pendingHandleShadow,
                      }
                }
              >
                {slideCompleted ? '✓' : '→'}
              </div>
            </Draggable>
          </div>
          <button
            type="button"
            className="sr-only focus:not-sr-only focus:mt-3 focus:block focus:w-full wallet-btn-primary"
            disabled={!canConfirmReview || isSending || slideCompleted}
            onClick={confirm}
          >
            {t('send.slideToConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

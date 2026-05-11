import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Draggable from 'react-draggable';
import { AssetType, ReviewState, SimpleSendInput, TokenMetaMap } from './types';
import { formatFtAmount } from './utils';

type ReviewCardProps = {
  open: boolean;
  review: ReviewState;
  recipient: string;
  assetType: AssetType;
  amountBch: string;
  fiatSummary: { amountUsd: number; feeUsd: number; totalUsd: number };
  selectedCategory: string;
  amountToken: string;
  tokenMeta: TokenMetaMap;
  displayNameFor: (category: string) => string;
  selectedForTx: SimpleSendInput[];
  rawHexLen: number;
  isSending: boolean;
  onClose: () => void;
  onConfirmSend: () => void;
};

export function ReviewCard({
  open,
  review,
  recipient,
  assetType,
  amountBch,
  fiatSummary,
  selectedCategory,
  amountToken,
  tokenMeta,
  displayNameFor,
  selectedForTx,
  rawHexLen,
  isSending,
  onClose,
  onConfirmSend,
}: ReviewCardProps) {
  const HANDLE_SIZE = 56;
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [maxX, setMaxX] = useState(0);
  const [slideCompleted, setSlideCompleted] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  useEffect(() => {
    if (!open) {
      setDragX(0);
      setSlideCompleted(false);
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

  const visibleRecipient = useMemo(() => {
    if (!recipient) return '';
    const colonIndex = recipient.indexOf(':');
    const prefix = colonIndex >= 0 ? recipient.slice(0, colonIndex + 1) : '';
    const body = colonIndex >= 0 ? recipient.slice(colonIndex + 1) : recipient;
    if (body.length <= 10) return `${prefix}${body}`;
    return `${prefix}${body.slice(0, 5)}…${body.slice(-5)}`;
  }, [recipient]);

  const technicalInputs = useMemo(
    () =>
      selectedForTx.map((u) => ({
        key: `${u.tx_hash}:${u.tx_pos}`,
        address: (() => {
          const raw = u.address ?? '';
          const withoutPrefix = raw.includes(':')
            ? raw.slice(raw.indexOf(':') + 1)
            : raw;
          return withoutPrefix.length > 12
            ? `${withoutPrefix.slice(0, 8)}…${withoutPrefix.slice(-6)}`
            : withoutPrefix;
        })(),
        sats: Number(u.amount ?? u.value ?? 0),
        pending: typeof u.height === 'number' ? u.height <= 0 : false,
      })),
    [selectedForTx]
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
        const withoutPrefix = rawAddress.includes(':')
          ? rawAddress.slice(rawAddress.indexOf(':') + 1)
          : rawAddress;
        const shortAddress =
          withoutPrefix.length > 12
            ? `${withoutPrefix.slice(0, 8)}…${withoutPrefix.slice(-6)}`
            : withoutPrefix;
        const tokenLabel = out.token
          ? out.token.nft
            ? `${displayNameFor(out.token.category)} NFT`
            : `${displayNameFor(out.token.category)} · ${String(out.token.amount ?? 0)}`
          : 'BCH';

        return {
          key: `${rawAddress}-${i}`,
          label: shortAddress,
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

  if (!open) return null;

  const threshold = Math.max(0, maxX - 1);
  const progressRatio = Math.min(1, Math.max(0, dragX / Math.max(1, maxX)));
  const nearingSend =
    !isSending && !slideCompleted && maxX > 0 && progressRatio >= 0.9;
  const progressHue = Math.round(progressRatio * 120);
  const pendingTrackBg = `hsl(${progressHue} 80% 95%)`;
  const pendingTrackBorder = `hsl(${progressHue} 65% 80%)`;
  const pendingFill = `hsla(${progressHue}, 80%, 42%, 0.24)`;
  const pendingText = `hsl(${progressHue} 72% 35%)`;
  const pendingHandle = `hsl(${progressHue} 82% 44%)`;
  const pendingHandleShadow = `0 8px 24px hsla(${progressHue}, 82%, 44%, 0.35)`;

  const handleStop = (_: unknown, data: { x: number }) => {
    if (slideCompleted || isSending || maxX <= 0) return;

    const finalX = Math.min(Math.max(0, data.x), maxX);
    if (finalX >= threshold) {
      setDragX(maxX);
      setSlideCompleted(true);
      onConfirmSend();
      return;
    }

    setDragX(0);
    setSlideCompleted(false);
  };

  const progress = Math.min(100, (dragX / Math.max(1, maxX)) * 100);

  return (
    <div
      className="wallet-popup-backdrop z-[1100] p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="wallet-popup-panel w-full max-w-xl p-0 overflow-hidden">
        <div className="px-5 pt-4 pb-4 wallet-surface border-b border-[var(--wallet-border)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xl font-bold wallet-text-strong">
                Review Transaction
              </div>
              <div className="text-sm wallet-muted mt-1">
                Verify details and slide to send.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isSending}
              className="wallet-btn-secondary px-3 py-1.5 text-xs"
            >
              Close
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4 max-h-[56vh] overflow-y-auto">
          <div className="rounded-2xl border wallet-keyline wallet-signature-panel p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="wallet-kicker">Summary</div>
            </div>
            <div className="text-sm space-y-2">
              <div className="wallet-stat-row">
                <span className="font-medium">To</span>
                <span
                  className="font-mono truncate max-w-[60%] wallet-text-strong"
                  title={recipient}
                >
                  {visibleRecipient}
                </span>
              </div>

              {assetType === 'bch' && (
                <div className="wallet-stat-row">
                  <span className="font-medium">Amount</span>
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

              {assetType !== 'bch' && (
                <div className="wallet-stat-row">
                  <span className="font-medium">Asset</span>
                  <span className="font-mono wallet-text-strong">
                    {assetType.toUpperCase()} ·{' '}
                    {selectedCategory ? displayNameFor(selectedCategory) : '—'}
                    {assetType === 'ft' && amountToken
                      ? ` · amount: ${amountToken}`
                      : ''}
                  </span>
                </div>
              )}

              {review.tokenChange && (
                <div className="wallet-stat-row">
                  <span className="font-medium">Token change</span>
                  <span
                    className="font-mono wallet-text-strong"
                    title={review.tokenChange.amount.toString()}
                  >
                    {(() => {
                      const dec =
                        tokenMeta[review.tokenChange!.category]?.decimals ?? 0;
                      const pretty = formatFtAmount(
                        review.tokenChange!.amount,
                        dec
                      );
                      const name = displayNameFor(review.tokenChange!.category);
                      return `${pretty} ${name}`;
                    })()}
                  </span>
                </div>
              )}
              <div className="wallet-stat-row">
                <span className="font-medium">Fee</span>
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
                <span className="font-medium">Total (BCH)</span>
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
              className="flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] px-3 py-2.5 text-left shadow-sm"
              onClick={() => setShowTechnicalDetails((prev) => !prev)}
            >
              <span className="font-semibold wallet-text-strong">
                Technical details
              </span>
              <span className="text-xs wallet-muted">
                {showTechnicalDetails ? 'Hide' : 'Show'}
              </span>
            </button>

            {showTechnicalDetails && (
              <div className="mt-3 space-y-3">
                <div className="space-y-1 text-xs">
                  <div className="wallet-stat-row">
                    <span className="wallet-muted">Inputs</span>
                    <span className="font-mono wallet-text-strong">
                      {technicalSummary.inputCount}
                    </span>
                  </div>
                  <div className="wallet-stat-row">
                    <span className="wallet-muted">Transaction size</span>
                    <span className="font-mono wallet-text-strong">
                      {technicalSummary.txBytes} bytes
                    </span>
                  </div>
                  <div className="wallet-stat-row">
                    <span className="wallet-muted">Token inputs</span>
                    <span className="font-mono wallet-text-strong">
                      {technicalSummary.tokenInputCount}
                    </span>
                  </div>
                  <div className="wallet-stat-row">
                    <span className="wallet-muted">Unconfirmed inputs</span>
                    <span className="font-mono wallet-text-strong">
                      {technicalSummary.unconfirmedCount}
                    </span>
                  </div>
                  {technicalSummary.contractCount > 0 && (
                    <div className="wallet-stat-row">
                      <span className="wallet-muted">Contract inputs</span>
                      <span className="font-mono wallet-text-strong">
                        {technicalSummary.contractCount}
                      </span>
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface px-3 py-2.5">
                  <div className="mb-2 text-xs font-semibold wallet-muted">
                    Inputs used
                  </div>
                  <div className="space-y-1.5">
                    {technicalInputs.map((input) => (
                      <div
                        key={input.key}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-mono wallet-text-strong truncate">
                            {input.address}
                          </div>
                          {input.pending && (
                            <div className="wallet-muted">Pending</div>
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
                    Outputs created
                  </div>
                  <div className="space-y-1.5">
                    {technicalOutputs.map((output) => (
                      <div
                        key={output.key}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-mono wallet-text-strong truncate">
                            {output.label}
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
          <div className="text-[14px] wallet-muted mb-2.5 px-1">
            {isSending
              ? 'Sending...'
              : slideCompleted
                ? 'Confirmed'
                : nearingSend
                  ? 'Release to send'
                  : 'Slide to confirm'}
          </div>

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
                SEND
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
                  ? 'Sending...'
                  : slideCompleted
                    ? 'Confirmed'
                    : nearingSend
                      ? 'Release to send'
                      : 'Slide to confirm'}
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
              disabled={isSending || slideCompleted || maxX <= 0}
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
        </div>
      </div>
    </div>
  );
}

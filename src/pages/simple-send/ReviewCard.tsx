import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Draggable from 'react-draggable';
import { shortenTxHash } from '../../utils/shortenHash';
import { AssetType, ReviewState, TokenMetaMap } from './types';
import { formatFtAmount } from './utils';

type ReviewCardProps = {
  open: boolean;
  review: ReviewState;
  recipient: string;
  prefixLen: number;
  assetType: AssetType;
  amountBch: string;
  fiatSummary: { amountUsd: number; feeUsd: number; totalUsd: number };
  selectedCategory: string;
  amountToken: string;
  tokenMeta: TokenMetaMap;
  displayNameFor: (category: string) => string;
  isSending: boolean;
  onClose: () => void;
  onConfirmSend: () => void;
};

export function ReviewCard({
  open,
  review,
  recipient,
  prefixLen,
  assetType,
  amountBch,
  fiatSummary,
  selectedCategory,
  amountToken,
  tokenMeta,
  displayNameFor,
  isSending,
  onClose,
  onConfirmSend,
}: ReviewCardProps) {
  const HANDLE_SIZE = 56;
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [maxX, setMaxX] = useState(0);
  const [slideCompleted, setSlideCompleted] = useState(false);

  useEffect(() => {
    if (!open) {
      setDragX(0);
      setSlideCompleted(false);
      setMaxX(0);
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

  const tokenOutputs = useMemo(
    () => {
      const rows: Array<{
        recipientAddress: string;
        token: NonNullable<
          Extract<ReviewState['finalOutputs'][number], { recipientAddress: string }>['token']
        >;
      }> = [];
      for (const out of review.finalOutputs) {
        if ('recipientAddress' in out && out.token) {
          rows.push({
            recipientAddress: out.recipientAddress,
            token: out.token,
          });
        }
      }
      return rows;
    },
    [review.finalOutputs]
  );

  if (!open) return null;

  const threshold = Math.max(0, maxX - 1);
  const progressRatio = Math.min(1, Math.max(0, dragX / Math.max(1, maxX)));
  const nearingSend = !isSending && !slideCompleted && maxX > 0 && progressRatio >= 0.9;
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
    <div className="wallet-popup-backdrop z-[1100] p-4" role="dialog" aria-modal="true">
      <div className="wallet-popup-panel w-full max-w-xl p-0 overflow-hidden">
        <div className="px-5 pt-4 pb-3 wallet-surface border-b border-[var(--wallet-border)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xl font-bold wallet-text-strong">Review Transaction</div>
              <div className="text-sm wallet-muted mt-1">Verify details and slide to send.</div>
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

        <div className="p-4 space-y-3 max-h-[56vh] overflow-y-auto">
          <div className="text-sm space-y-1">
            <div className="flex justify-between gap-3">
              <span className="font-medium">To</span>
              <span className="font-mono truncate max-w-[60%]" title={recipient}>
                {shortenTxHash(recipient, prefixLen)}
              </span>
            </div>

            {assetType === 'bch' && (
              <div className="flex justify-between">
                <span className="font-medium">Amount</span>
                <span>
                  {(Number.parseFloat(amountBch) || 0).toFixed(8)} BCH
                  {!!fiatSummary.amountUsd && (
                    <span className="opacity-70"> · ${fiatSummary.amountUsd.toFixed(2)} USD</span>
                  )}
                </span>
              </div>
            )}

            {assetType !== 'bch' && (
              <div className="flex justify-between">
                <span className="font-medium">Asset</span>
                <span className="font-mono">
                  {assetType.toUpperCase()} · {selectedCategory ? displayNameFor(selectedCategory) : '—'}
                  {assetType === 'ft' && amountToken ? ` · amount: ${amountToken}` : ''}
                </span>
              </div>
            )}

            {review.tokenChange && (
              <div className="flex justify-between">
                <span className="font-medium">Token change</span>
                <span className="font-mono" title={review.tokenChange.amount.toString()}>
                  {(() => {
                    const dec = tokenMeta[review.tokenChange!.category]?.decimals ?? 0;
                    const pretty = formatFtAmount(review.tokenChange!.amount, dec);
                    const name = displayNameFor(review.tokenChange!.category);
                    return `${pretty} ${name}`;
                  })()}
                </span>
              </div>
            )}
            {tokenOutputs.length > 0 && (
              <div className="pt-2">
                <div className="font-medium mb-1">CashToken outputs</div>
                <div className="space-y-1.5">
                  {tokenOutputs.map((row, i) => {
                    const outToken = row.token;
                    const recipientMasked = shortenTxHash(
                      row.recipientAddress,
                      prefixLen
                    );
                    const tokenName = displayNameFor(outToken.category);
                    const isNft =
                      !!outToken.nft &&
                      typeof outToken.nft.commitment === 'string';
                    const tokenAmount =
                      typeof outToken.amount === 'bigint'
                        ? outToken.amount
                        : BigInt(Math.trunc(outToken.amount || 0));
                    return (
                      <div
                        key={`${row.recipientAddress}-${outToken.category}-${i}`}
                        className="wallet-surface-strong border border-[var(--wallet-border)] rounded-lg px-2.5 py-2 text-xs"
                      >
                        <div className="font-mono wallet-text-strong">{recipientMasked}</div>
                        <div>
                          {tokenName} ({shortenTxHash(outToken.category)})
                        </div>
                        {isNft ? (
                          <div className="font-mono">
                            NFT: {outToken.nft!.capability} · {outToken.nft!.commitment || 'none'}
                          </div>
                        ) : (
                          <div className="font-mono">Amount: {tokenAmount.toString()}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex justify-between">
              <span className="font-medium">Fee</span>
              <span>
                {(review.feeSats / 100_000_000).toFixed(8)} BCH
                {!!fiatSummary.feeUsd && (
                  <span className="opacity-70"> · ${fiatSummary.feeUsd.toFixed(2)} USD</span>
                )}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="font-medium">Total (BCH)</span>
              <span>
                {(review.totalSats / 100_000_000).toFixed(8)} BCH
                {!!fiatSummary.totalUsd && (
                  <span className="opacity-70"> · ${fiatSummary.totalUsd.toFixed(2)} USD</span>
                )}
              </span>
            </div>
            <div className="flex justify-between text-xs wallet-muted">
              <span>Outputs</span>
              <span>{review.finalOutputs.length}</span>
            </div>
          </div>
        </div>

        <div className="px-4 pb-4 pt-2 wallet-surface border-t border-[var(--wallet-border)]">
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
                backgroundColor: slideCompleted ? 'rgba(16,185,129,0.2)' : pendingFill,
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
              onDrag={(_, data) => setDragX(Math.min(Math.max(0, data.x), maxX))}
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

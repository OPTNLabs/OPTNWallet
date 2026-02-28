// src/pages/SimpleSend.tsx

import React, { useEffect, useState } from 'react';
import useSimpleSend from '../hooks/useSimpleSend';
import { FaCamera } from 'react-icons/fa';
import { DebugPanel } from './simple-send/components';
import { ReviewCard } from './simple-send/ReviewCard';
import { SendHeader } from './simple-send/SendHeader';
import { ChangeAddressSection } from './simple-send/ChangeAddressSection';
import { CategorySummary } from './simple-send/types';
import { copyTextToClipboard, formatFtAmount } from './simple-send/utils';
import { useTokenMetadata } from './simple-send/useTokenMetadata';
import { useRecipientScanner } from './simple-send/useRecipientScanner';
import { useSimpleSendViewModel } from './simple-send/useSimpleSendViewModel';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-sm font-semibold wallet-text-strong">
      {children}
    </label>
  );
}

export default function SimpleSend() {
  const {
    recipient,
    setRecipient,

    // asset choice
    assetType,
    setAssetType,

    // BCH
    amountBch,
    setAmountBch,

    // token fields
    selectedCategory,
    setSelectedCategory,
    amountToken,
    setAmountToken,
    selectedNftCommitment,
    setSelectedNftCommitment,

    currentNetwork,
    addresses,
    selectedChangeAddress,
    setSelectedChangeAddress,

    // token-aware change destination (resolved)
    tokenChangeAddress,

    categories,

    mode,
    error,
    review,
    txid,

    reset,
    doReview,
    doSend,

    fiatSummary,

    selectedForTx, // debug
  } = useSimpleSend();

  const isSending = mode === 'sending';
  const [showDebug, setShowDebug] = useState(false);
  const [debugModalOpen, setDebugModalOpen] = useState(false);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [pendingReviewFlow, setPendingReviewFlow] = useState(false);

  const categorySummaries = categories as CategorySummary[];
  const tokenMeta = useTokenMetadata(categorySummaries);
  const {
    displayTokenName,
    prefixLen,
    mask,
    outputsTableRows,
    inputsTableRows,
    rawHexLen,
    ftCategories,
    nftCategories,
    canReview,
    inputClass,
    selectClass,
  } = useSimpleSendViewModel({
    currentNetwork,
    categories: categorySummaries,
    tokenMeta,
    selectedForTx,
    review,
    assetType,
    recipient,
    amountBch,
    selectedCategory,
    amountToken,
  });

  const { scanBusy, handleScanRecipient } = useRecipientScanner({
    setRecipient,
  });

  useEffect(() => {
    if (!pendingReviewFlow) return;

    if (mode === 'review' && review) {
      if (showDebug) {
        setDebugModalOpen(true);
      } else {
        setReviewModalOpen(true);
      }
      setPendingReviewFlow(false);
      return;
    }

    if (mode === 'error') {
      setPendingReviewFlow(false);
    }
  }, [pendingReviewFlow, mode, review, showDebug]);

  useEffect(() => {
    if (mode === 'sent' || mode === 'error' || mode === 'idle') {
      setDebugModalOpen(false);
      setReviewModalOpen(false);
    }
  }, [mode]);

  const handleReviewClick = async () => {
    setPendingReviewFlow(true);
    await doReview();
  };

  const handleContinueFromDebug = () => {
    setDebugModalOpen(false);
    setReviewModalOpen(true);
  };

  const handleConfirmSend = () => {
    void doSend();
  };

  return (
    <div className="container mx-auto p-4 max-w-xl">
      <SendHeader showDebug={showDebug} setShowDebug={setShowDebug} />

      {/* Network */}
      <div className="mb-3 text-xs font-medium wallet-muted">
        Network: <span className="font-mono">{currentNetwork}</span>
      </div>

      {/* Card */}
      <div className="space-y-4 wallet-card p-4">
        {/* Asset Type */}
        <div className="flex flex-col gap-1">
          <Label>Asset</Label>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className={`rounded-xl px-3 py-2 font-semibold border ${
                assetType === 'bch'
                  ? 'wallet-segment-active border-[var(--wallet-accent)]'
                  : 'wallet-segment-inactive border-[var(--wallet-border)]'
              }`}
              onClick={() => setAssetType('bch')}
            >
              BCH
            </button>
            <button
              type="button"
              className={`rounded-xl px-3 py-2 font-semibold border ${
                assetType === 'ft'
                  ? 'wallet-segment-active border-[var(--wallet-accent)]'
                  : 'wallet-segment-inactive border-[var(--wallet-border)]'
              }`}
              onClick={() => setAssetType('ft')}
            >
              Token (FT)
            </button>
            <button
              type="button"
              className={`rounded-xl px-3 py-2 font-semibold border ${
                assetType === 'nft'
                  ? 'wallet-segment-active border-[var(--wallet-accent)]'
                  : 'wallet-segment-inactive border-[var(--wallet-border)]'
              }`}
              onClick={() => setAssetType('nft')}
            >
              NFT
            </button>
          </div>
          {/* <div className="text-[11px] wallet-muted">
            Note: Token outputs carry 1,000 sats each to remain spendable.
          </div> */}
        </div>

        {/* To */}
        <div className="flex flex-col gap-1">
          <Label>To</Label>
          <div className="flex items-center gap-2">
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
              placeholder={
                assetType === 'bch'
                  ? 'bitcoincash:...'
                  : 'bitcoincash: or token-aware address'
              }
              className={inputClass}
            />
            <button
              type="button"
              onClick={handleScanRecipient}
              disabled={scanBusy}
              title="Scan QR"
              className="wallet-btn-primary shrink-0 px-3"
            >
              <FaCamera />
            </button>
          </div>
          {!!recipient && (
            <div className="text-[11px] wallet-muted">
              {mask(recipient)}
              <button
                className="ml-2 wallet-link underline"
                onClick={() => copyTextToClipboard(recipient)}
              >
                Copy
              </button>
            </div>
          )}
        </div>

        {/* Amount (BCH) */}
        {assetType === 'bch' && (
          <div className="flex flex-col gap-1">
            <Label>Amount (BCH)</Label>
            <input
              value={amountBch}
              onChange={(e) => setAmountBch(e.target.value)}
              inputMode="decimal"
              placeholder="0.00000000"
              className={inputClass}
            />
            {/* <div className="text-[11px] wallet-muted">
              Network fee is calculated at 1 sat/byte. We also keep a small
              buffer to ensure change is spendable.
            </div> */}
          </div>
        )}

        {/* FT controls */}
        {assetType === 'ft' && (
          <>
            <div className="flex flex-col gap-1">
              <Label>Token category</Label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className={selectClass}
              >
                <option value="" disabled>
                  Select category…
                </option>
                {ftCategories.map((c) => {
                  const pretty = displayTokenName(c.category);
                  const dec = tokenMeta[c.category]?.decimals ?? 0;
                  const human = formatFtAmount(c.ftAmount, dec);
                  return (
                    <option key={c.category} value={c.category}>
                      {pretty} · Balance: {human}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Token amount</Label>
              <input
                value={amountToken}
                onChange={(e) =>
                  setAmountToken(e.target.value.replace(/\D/g, ''))
                }
                inputMode="numeric"
                placeholder="e.g., 1000"
                className={inputClass}
              />
              {/* <div className="text-[11px] wallet-muted">
                BCH inputs are added only to pay network fees. Token change (if
                any) returns to your token-aware change address.
              </div> */}
            </div>
          </>
        )}

        {/* NFT controls */}
        {assetType === 'nft' && (
          <>
            <div className="flex flex-col gap-1">
              <Label>NFT category</Label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className={selectClass}
              >
                <option value="" disabled>
                  Select category…
                </option>
                {nftCategories.map((c) => {
                  const pretty = displayTokenName(c.category);
                  return (
                    <option key={c.category} value={c.category}>
                      {pretty} · NFTs: {c.nftCommitments.length}
                    </option>
                  );
                })}
              </select>
            </div>
            {/* Optional: choose specific NFT by commitment */}
            {selectedCategory && (
              <div className="flex flex-col gap-1">
                <Label>NFT commitment (optional)</Label>
                <input
                  value={selectedNftCommitment}
                  onChange={(e) =>
                    setSelectedNftCommitment(e.target.value.trim())
                  }
                  placeholder="hex commitment…"
                  className={inputClass}
                />
                <div className="text-[11px] wallet-muted">
                  Leave blank to send the first available NFT in this category.
                </div>
              </div>
            )}
          </>
        )}

        <ChangeAddressSection
          selectedChangeAddress={selectedChangeAddress}
          setSelectedChangeAddress={setSelectedChangeAddress}
          selectClass={selectClass}
          addresses={addresses}
          mask={mask}
          tokenChangeAddress={tokenChangeAddress}
        />

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleReviewClick()}
            disabled={isSending || !canReview}
            className="wallet-btn-primary w-full"
            title={!canReview ? 'Fill the required fields first' : 'Review'}
          >
            Review
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={isSending}
            className="wallet-btn-secondary w-28"
            title="Clear form"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Error */}
      {mode === 'error' && error && (
        <div className="mt-4 p-3 rounded-2xl border wallet-danger-panel text-sm shadow-sm">
          {error}
        </div>
      )}

      {debugModalOpen && (
        <div
          className="wallet-popup-backdrop z-[1090] p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="wallet-popup-panel w-full max-w-5xl p-0 overflow-hidden">
            {/* <div className="px-5 pt-4 pb-3 wallet-surface border-b border-[var(--wallet-border)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xl font-bold wallet-text-strong">
                    Debug Check
                  </div>
                  <div className="text-sm wallet-muted mt-1">
                    Validate selected inputs and outputs before final review.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDebugModalOpen(false)}
                  disabled={isSending}
                  className="wallet-btn-secondary px-3 py-1.5 text-xs"
                >
                  Close
                </button>
              </div>
            </div> */}
            <div className="max-h-[68vh] overflow-y-auto p-4">
              <DebugPanel
                review={review}
                selectedForTx={selectedForTx}
                rawHexLen={rawHexLen}
                inputsTableRows={inputsTableRows}
                outputsTableRows={outputsTableRows}
              />
            </div>
            <div className="px-4 pb-4 pt-2 wallet-surface border-t border-[var(--wallet-border)] flex justify-end gap-2">
              <button
                type="button"
                className="wallet-btn-secondary"
                onClick={() => setDebugModalOpen(false)}
              >
                Back to form
              </button>
              <button
                type="button"
                className="wallet-btn-primary"
                onClick={handleContinueFromDebug}
                disabled={!review || isSending}
              >
                Continue to review
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === 'review' && review && (
        <ReviewCard
          open={reviewModalOpen}
          review={review}
          recipient={recipient}
          prefixLen={prefixLen}
          assetType={assetType}
          amountBch={amountBch}
          fiatSummary={fiatSummary}
          selectedCategory={selectedCategory}
          amountToken={amountToken}
          tokenMeta={tokenMeta}
          displayNameFor={displayTokenName}
          isSending={isSending}
          onClose={() => setReviewModalOpen(false)}
          onConfirmSend={handleConfirmSend}
        />
      )}

      {/* Sent */}
      {mode === 'sent' && txid && (
        <div className="mt-4 p-4 rounded-2xl border wallet-success-panel text-sm shadow-sm">
          <div className="font-semibold mb-1 wallet-text-strong">
            Transaction sent ✅
          </div>
          <div className="break-all font-mono wallet-text-strong">{txid}</div>
        </div>
      )}
    </div>
  );
}

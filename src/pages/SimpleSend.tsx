// src/pages/SimpleSend.tsx

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import useSimpleSend from '../hooks/useSimpleSend';
import { FaCamera } from 'react-icons/fa';
import { ReviewCard } from './simple-send/ReviewCard';
import { ChangeAddressSection } from './simple-send/ChangeAddressSection';
import { CategorySummary } from './simple-send/types';
import { copyTextToClipboard, formatFtAmount } from './simple-send/utils';
import { useTokenMetadata } from './simple-send/useTokenMetadata';
import { useRecipientScanner } from './simple-send/useRecipientScanner';
import { useSimpleSendViewModel } from './simple-send/useSimpleSendViewModel';
import { parseBip21Uri } from '../utils/bip21';
import PageHeader from '../components/ui/PageHeader';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import { selectWalletId } from '../redux/walletSlice';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-sm font-semibold wallet-text-strong">
      {children}
    </label>
  );
}

export default function SimpleSend() {
  const walletId = useSelector(selectWalletId);
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

    categories,

    mode,
    error,
    review,
    txid,
    broadcastState,

    reset,
    doReview,
    doSend,

    fiatSummary,

    selectedForTx, // debug
	  } = useSimpleSend();
  const {
    hasUnresolved,
  } = useOutboundTransactions(walletId);

  const isSending = mode === 'sending';
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [pendingReviewFlow, setPendingReviewFlow] = useState(false);

  const categorySummaries = categories as CategorySummary[];
  const tokenMeta = useTokenMetadata(categorySummaries);
  const {
    displayTokenName,
    mask,
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
    setAmountBch,
    setAssetType,
    currentNetwork,
  });

  const normalizeRecipientInput = () => {
    const parsed = parseBip21Uri(recipient, currentNetwork);
    if (!parsed.isValidAddress) return;

    setRecipient(parsed.normalizedAddress);
    if (parsed.amountRaw) {
      setAssetType('bch');
      setAmountBch(parsed.amountRaw);
    }
  };

  useEffect(() => {
    if (!pendingReviewFlow) return;

    if (mode === 'review' && review) {
      setReviewModalOpen(true);
      setPendingReviewFlow(false);
      return;
    }

    if (mode === 'error') {
      setPendingReviewFlow(false);
    }
  }, [pendingReviewFlow, mode, review]);

  useEffect(() => {
    if (mode === 'sent' || mode === 'error' || mode === 'idle') {
      setReviewModalOpen(false);
    }
  }, [mode]);

  const handleReviewClick = async () => {
    setPendingReviewFlow(true);
    await doReview();
  };
  const handleConfirmSend = () => {
    void doSend();
  };

  const pageError = mode === 'error' ? error : null;

  return (
    <div className="container mx-auto max-w-xl h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-3 flex flex-col overflow-hidden wallet-page">
      <div className="shrink-0">
        <PageHeader
          title="Simple Send"
          compact
          titleAction={
            <Link
              to="/transaction"
              className="wallet-btn-secondary px-3 py-2 text-sm"
              title="Open advanced transaction builder"
            >
              Advanced
            </Link>
          }
        />
      </div>
      <div className="wallet-card wallet-signature-panel flex-1 min-h-0 overflow-hidden p-4">
        <div className="flex h-full flex-col">
          <div className="mb-4 wallet-section shrink-0">
            <div className="wallet-kicker mb-1">Transfer mode</div>
            <Label>Asset</Label>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <button
                type="button"
                className={`min-h-[46px] rounded-[18px] px-3 py-2 font-semibold border transition ${
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
                className={`min-h-[46px] rounded-[18px] px-3 py-2 font-semibold border transition ${
                  assetType === 'ft'
                    ? 'wallet-segment-active border-[var(--wallet-accent)]'
                    : 'wallet-segment-inactive border-[var(--wallet-border)]'
                }`}
                onClick={() => setAssetType('ft')}
              >
                Token
              </button>
              <button
                type="button"
                className={`min-h-[46px] rounded-[18px] px-3 py-2 font-semibold border transition ${
                  assetType === 'nft'
                    ? 'wallet-segment-active border-[var(--wallet-accent)]'
                    : 'wallet-segment-inactive border-[var(--wallet-border)]'
                }`}
                onClick={() => setAssetType('nft')}
              >
                NFT
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
            <div className="wallet-section">
              <div className="wallet-kicker mb-1">Destination</div>
              <Label>Recipient</Label>
              <div className="mt-3 flex items-center gap-2">
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.trim())}
                  onBlur={normalizeRecipientInput}
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
                  className="wallet-btn-primary shrink-0 min-w-[46px] px-3"
                >
                  <FaCamera />
                </button>
              </div>
              {!!recipient && (
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px] wallet-muted">
                  <span className="truncate">{mask(recipient)}</span>
                  <button
                    className="wallet-link underline shrink-0"
                    onClick={() => copyTextToClipboard(recipient)}
                  >
                    Copy
                  </button>
                </div>
              )}
            </div>

            {assetType === 'bch' && (
              <div className="wallet-section">
                <div className="wallet-kicker">Value</div>
                <Label>Amount (BCH)</Label>
                <input
                  value={amountBch}
                  onChange={(e) => setAmountBch(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00000000"
                  className={`${inputClass} mt-3`}
                />
              </div>
            )}

            {assetType === 'ft' && (
              <div className="wallet-section space-y-3">
                <div className="flex flex-col gap-1">
                  <div className="wallet-kicker">Asset control</div>
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
                </div>
              </div>
            )}

            {assetType === 'nft' && (
              <div className="wallet-section space-y-3">
                <div className="flex flex-col gap-1">
                  <div className="wallet-kicker">Asset control</div>
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
                {selectedCategory && (
                  <div className="flex flex-col gap-1">
                    <Label>NFT commitment</Label>
                    <input
                      value={selectedNftCommitment}
                      onChange={(e) =>
                        setSelectedNftCommitment(e.target.value.trim())
                      }
                      placeholder="Optional hex commitment…"
                      className={inputClass}
                    />
                    <div className="text-[11px] wallet-muted">
                      Leave blank to send the first available NFT in this category.
                    </div>
                  </div>
                )}
              </div>
            )}

            <ChangeAddressSection
              selectedChangeAddress={selectedChangeAddress}
              setSelectedChangeAddress={setSelectedChangeAddress}
              selectClass={selectClass}
              addresses={addresses}
              mask={mask}
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {pageError && (
        <div className="mt-3 p-3 rounded-2xl border wallet-danger-panel text-sm shadow-sm shrink-0">
          {pageError}
        </div>
      )}

      {mode === 'sent' && txid && (
        <div className="mt-3 p-4 rounded-2xl border wallet-success-panel text-sm shadow-sm shrink-0">
          <div className="font-semibold mb-1 wallet-text-strong">
            {broadcastState === 'submitted'
              ? 'Transaction submitted'
              : 'Transaction sent'}
          </div>
          {broadcastState === 'submitted' && (
            <div className="mb-2 wallet-muted">
              Keep this txid as your reference and avoid sending it again.
            </div>
          )}
          <div className="break-all font-mono wallet-text-strong">{txid}</div>
        </div>
      )}

      <div className="mt-3 wallet-card p-3 shrink-0">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleReviewClick()}
            disabled={isSending || !canReview || hasUnresolved}
            className="wallet-btn-primary flex-1"
            title={
              hasUnresolved
                ? 'Wait for your previous outgoing transaction to sync first'
                : !canReview
                  ? 'Fill the required fields first'
                  : 'Review'
            }
          >
            {hasUnresolved ? 'Waiting for sync' : 'Review'}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={isSending}
            className="wallet-btn-secondary px-4"
            title="Clear form"
          >
            Reset
          </button>
        </div>
      </div>

      {mode === 'review' && review && (
        <ReviewCard
          open={reviewModalOpen}
          review={review}
          recipient={recipient}
          assetType={assetType}
          amountBch={amountBch}
          fiatSummary={fiatSummary}
          selectedCategory={selectedCategory}
          amountToken={amountToken}
          tokenMeta={tokenMeta}
          displayNameFor={displayTokenName}
          selectedForTx={selectedForTx}
          rawHexLen={rawHexLen}
          isSending={isSending}
          onClose={() => setReviewModalOpen(false)}
          onConfirmSend={handleConfirmSend}
        />
      )}
    </div>
  );
}

// src/pages/SimpleSend.tsx

import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import useSimpleSend from '../../hooks/useSimpleSend';
import { FaCamera, FaQrcode, FaShieldAlt } from 'react-icons/fa';
import { ReviewCard } from './ReviewCard';
import { ChangeAddressSection } from './ChangeAddressSection';
import { CategorySummary } from './types';
import { copyTextToClipboard, formatFtAmount } from './utils';
import { useTokenMetadata } from './useTokenMetadata';
import { useRecipientScanner } from './useRecipientScanner';
import { useSimpleSendViewModel } from './useSimpleSendViewModel';
import { parseBip21Uri } from '../../utils/bip21';
import PageHeader from '../../components/ui/PageHeader';
import useOutboundTransactions from '../../hooks/useOutboundTransactions';
import { selectWalletId } from '../../state/slices/walletSlice';
import WalletScreen from '../../components/ui/WalletScreen';
import { getReturnPath } from '../../utils/navigation';

type SimpleSendLocationState = {
  amountBch?: string;
  amountToken?: string;
  assetType?: 'bch' | 'ft' | 'nft';
  quantumrootFlow?: 'approval-token' | 'receive-coin';
  recipient?: string;
  returnTo?: string;
  selectedCategory?: string;
  selectedNftCommitment?: string;
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-sm font-semibold wallet-text-strong">
      {children}
    </label>
  );
}

export default function SimpleSend() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state as SimpleSendLocationState | null) ?? null;
  const backTarget = getReturnPath(location, '/actions');
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
    amountUsd,
    setAmountUsd,
    amountDisplayMode,
    setAmountDisplayMode,
    bchUsdPrice,

    // token fields
    selectedCategory,
    setSelectedCategory,
    amountToken,
    setAmountToken,
    selectedTokenDecimals,
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
  const [deferOutboundWork, setDeferOutboundWork] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setDeferOutboundWork(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  const { hasUnresolved } = useOutboundTransactions(walletId, deferOutboundWork);

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
    selectedTokenDecimals,
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
    navigator.vibrate?.(50); // Haptic feedback
    setPendingReviewFlow(true);
    await doReview();
  };
  const handleConfirmSend = () => {
    navigator.vibrate?.(50); // Haptic feedback
    void doSend();
  };

  const enhanceErrorMessage = (err: string) => {
    if (err.toLowerCase().includes('invalid address')) {
      return 'Invalid address—double-check for typos or try scanning a QR code.';
    }
    if (err.toLowerCase().includes('insufficient funds')) {
      return 'Not enough funds. Check your balance or reduce the amount.';
    }
    if (err.toLowerCase().includes('network')) {
      return 'Network error. Check your connection and try again.';
    }
    // Default to original
    return err;
  };

  const pageError = mode === 'error' ? error : null;
  const enhancedError = pageError ? enhanceErrorMessage(pageError) : null;
  useEffect(() => {
    if (!locationState) return;

    reset();

    if (locationState.recipient !== undefined) {
      setRecipient(locationState.recipient);
    }
    if (locationState.assetType !== undefined) {
      setAssetType(locationState.assetType);
    }
    if (locationState.selectedCategory !== undefined) {
      setSelectedCategory(locationState.selectedCategory);
    }
    if (locationState.amountBch !== undefined) {
      setAmountBch(locationState.amountBch);
    }
    if (locationState.amountToken !== undefined) {
      setAmountToken(locationState.amountToken);
    }
    if (locationState.selectedNftCommitment !== undefined) {
      setSelectedNftCommitment(locationState.selectedNftCommitment);
    }
  }, [
    location.key,
    locationState,
    reset,
    setAmountBch,
    setAmountToken,
    setAssetType,
    setRecipient,
    setSelectedCategory,
    setSelectedNftCommitment,
  ]);

  const quantumrootPrefillLabel =
    locationState?.quantumrootFlow === 'approval-token'
      ? 'approval key to Quantum Lock'
      : locationState?.quantumrootFlow === 'receive-coin'
        ? 'matching receive coin to the vault receive address'
        : null;
  const quantumrootPrefillHint =
    locationState?.assetType === 'nft'
      ? 'If there are multiple NFT entries, choose the one that matches the approval key.'
      : 'Review the recipient and token category, then tap Review to build the transaction.';

  const renderTokenModeToggle = () => (
    <div className="mt-2 grid grid-cols-2 gap-2">
      <button
        type="button"
        className={`min-h-[42px] rounded-[16px] px-3 py-2 text-sm font-semibold border transition ${
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
        className={`min-h-[42px] rounded-[16px] px-3 py-2 text-sm font-semibold border transition ${
          assetType === 'nft'
            ? 'wallet-segment-active border-[var(--wallet-accent)]'
            : 'wallet-segment-inactive border-[var(--wallet-border)]'
        }`}
        onClick={() => setAssetType('nft')}
      >
        NFT
      </button>
    </div>
  );

  return (
    <WalletScreen maxWidthClassName="max-w-xl" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader title="Simple Send" compact />
        {quantumrootPrefillLabel ? (
          <div className="wallet-surface-strong rounded-[18px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_26%,transparent)] p-3">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)]">
                {locationState?.quantumrootFlow === 'approval-token' ? (
                  <FaShieldAlt />
                ) : (
                  <FaQrcode />
                )}
              </div>
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-[0.16em] wallet-muted">
                  Quantumroot shortcut
                </div>
                <div className="mt-1 text-sm font-semibold wallet-text-strong">
                  Prefilled to send the {quantumrootPrefillLabel}
                </div>
                <div className="text-[11px] wallet-muted">
                  {quantumrootPrefillHint}
                </div>
              </div>
            </div>
          </div>
        ) : null}
        <div className="wallet-card wallet-signature-panel flex-1 min-h-0 overflow-hidden p-3">
          <div className="flex h-full flex-col">
            <div className="mb-3 wallet-section shrink-0">
              <div className="mb-1 wallet-kicker">Transfer mode</div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <button
                  type="button"
                  className={`min-h-[42px] rounded-[16px] px-3 py-2 text-sm font-semibold border transition ${
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
                  className={`min-h-[42px] rounded-[16px] px-3 py-2 text-sm font-semibold border transition ${
                    assetType === 'bch'
                      ? 'wallet-segment-inactive border-[var(--wallet-border)]'
                      : 'wallet-segment-active border-[var(--wallet-accent)]'
                  }`}
                  onClick={() => setAssetType('ft')}
                >
                  Token
                </button>
                <Link
                  to="/apps/optn.builtin.events:airdropsApp"
                  state={{ returnTo: '/send' }}
                  className="wallet-btn-secondary flex min-h-[42px] items-center justify-center rounded-[16px] px-3 py-2 text-sm font-semibold"
                  title="Open Airdrops"
                >
                  Airdrops
                </Link>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
              <div className="wallet-section">
                <Label>Recipient</Label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value.trim())}
                    onBlur={normalizeRecipientInput}
                    placeholder={
                      assetType === 'bch'
                        ? 'bitcoincash:...'
                        : 'bitcoincash:z...'
                    }
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={handleScanRecipient}
                    disabled={scanBusy}
                    title="Scan QR"
                    className="wallet-btn-primary shrink-0 min-w-[42px] px-3"
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
                  <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                    <div className="min-w-0">
                      <Label>
                        {amountDisplayMode === 'bch'
                          ? 'Amount (BCH)'
                          : 'Amount (USD)'}
                      </Label>
                      <input
                        value={amountDisplayMode === 'bch' ? amountBch : amountUsd}
                        onChange={(e) =>
                          amountDisplayMode === 'bch'
                            ? setAmountBch(e.target.value)
                            : setAmountUsd(e.target.value)
                        }
                        inputMode="decimal"
                        placeholder={
                          amountDisplayMode === 'bch'
                            ? '0.00000000 BCH'
                            : '0.00 USD'
                        }
                        className={`${inputClass} mt-2`}
                      />
                    </div>
                    <button
                      type="button"
                      className={`min-h-[42px] self-end rounded-[16px] border px-3 py-2 text-sm font-semibold transition ${
                        amountDisplayMode === 'bch'
                          ? 'wallet-segment-active border-[var(--wallet-accent)]'
                          : 'wallet-segment-inactive border-[var(--wallet-border)]'
                      }`}
                      onClick={() =>
                        setAmountDisplayMode(
                          amountDisplayMode === 'bch' ? 'usd' : 'bch'
                        )
                      }
                      aria-label={
                        amountDisplayMode === 'bch'
                          ? 'Switch amount input to USD'
                          : 'Switch amount input to BCH'
                      }
                    >
                      {amountDisplayMode === 'bch' ? 'USD' : 'BCH'}
                    </button>
                  </div>
                  <div className="mt-2 text-xs wallet-muted">
                    {bchUsdPrice > 0
                      ? amountDisplayMode === 'bch'
                        ? amountBch
                          ? `~$${amountUsd || '0.00'} USD`
                          : 'Enter a BCH amount to see the USD equivalent.'
                        : amountUsd
                          ? `~${amountBch || '0.00000000'} BCH`
                          : 'Enter a USD amount to see the BCH equivalent.'
                      : 'USD conversion is unavailable right now.'}
                  </div>
                </div>
              )}

              {assetType === 'ft' && (
                <div className="wallet-section space-y-3">
                  <div className="flex flex-col gap-1">
                    <div className="wallet-kicker">Asset control</div>
                    {renderTokenModeToggle()}
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
                    <Label>
                      Token amount
                      {selectedTokenDecimals > 0
                        ? ` (${selectedTokenDecimals} decimal${selectedTokenDecimals === 1 ? '' : 's'})`
                        : ' (integer)'}
                    </Label>
                    <input
                      value={amountToken}
                      onChange={(e) => setAmountToken(e.target.value)}
                      inputMode="decimal"
                      placeholder={
                        selectedTokenDecimals > 0
                          ? `0.${'0'.repeat(selectedTokenDecimals)}`
                          : '0'
                      }
                      className={inputClass}
                    />
                    <div className="text-[11px] wallet-muted">
                      Parsed using BCMR metadata from the selected category.
                    </div>
                  </div>
                </div>
              )}

              {assetType === 'nft' && (
                <div className="wallet-section space-y-3">
                  <div className="flex flex-col gap-1">
                    <div className="wallet-kicker">Asset control</div>
                    {renderTokenModeToggle()}
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
                        Leave blank to send the first available NFT in this
                        category.
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
        {enhancedError && (
          <div className="mt-3 p-3 rounded-2xl border wallet-danger-panel text-sm shadow-sm shrink-0">
            {enhancedError}
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

        <div className="wallet-card mt-3 shrink-0 p-3 pb-[calc(var(--safe-bottom)+1rem)]">
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

        <button
          type="button"
          onClick={() => navigate(backTarget)}
          className="wallet-btn-danger w-full py-3 font-semibold"
        >
          Back
        </button>

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
    </WalletScreen>
  );
}

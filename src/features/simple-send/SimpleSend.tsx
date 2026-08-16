// src/pages/SimpleSend.tsx

import React, { useEffect, useMemo, useState } from 'react';
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
import { CoinControlSection } from '../../components/CoinControlSection';
import { getReturnPath } from '../../utils/navigation';
import { SATSINBITCOIN } from '../../utils/constants';
import { useI18n } from '../../i18n/useI18n';

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
  const { t } = useI18n();
  const locationState =
    (location.state as SimpleSendLocationState | null) ?? null;
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
    maxBusy,
    reviewBusy,
    sendStatus,
    isHardwareWallet,

    reset,
    doReview,
    doSend,
    doMax,

    fiatSummary,

    dbUtxos,
    coinControlEnabled,
    setCoinControlEnabled,
    selectedCoinKeys,
    setSelectedCoinKeys,

    selectedForTx, // debug
  } = useSimpleSend();
  const [deferOutboundWork, setDeferOutboundWork] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setDeferOutboundWork(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  const {
    hasUnresolved,
    outboundTransactions,
    reconciling: outboundReconciling,
    refresh: refreshOutbound,
    release: releaseOutbound,
    canClear: canClearOutbound,
  } = useOutboundTransactions(walletId, deferOutboundWork);

  const isSending = mode === 'sending';
  const spendableSummary = useMemo(() => {
    const spendableSats = dbUtxos.reduce((sum, utxo) => {
      const raw = utxo.amount ?? utxo.value ?? 0;
      return sum + (typeof raw === 'bigint' ? Number(raw) : Number(raw) || 0);
    }, 0);
    const spendableBch = (spendableSats / SATSINBITCOIN)
      .toFixed(8)
      .replace(/\.?0+$/, '');
    const coinLabel = t(dbUtxos.length === 1 ? 'send.coin' : 'send.coins');
    return t('send.spendableSummary', {
      amount: spendableBch,
      count: dbUtxos.length,
      coins: coinLabel,
    });
  }, [dbUtxos, t]);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [pendingReviewFlow, setPendingReviewFlow] = useState(false);
  const isReviewBusy = reviewBusy || pendingReviewFlow;

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
    if (reviewBusy || isSending) return;
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
      return t('send.invalidAddress');
    }
    if (err.toLowerCase().includes('insufficient funds')) {
      return t('send.insufficientFunds');
    }
    if (
      /\b(connection|timeout|econnrefused|offline|unreachable)\b/i.test(err) ||
      /^network error\b/i.test(err)
    ) {
      return t('send.networkError');
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
      ? t('send.quantumrootApproval')
      : locationState?.quantumrootFlow === 'receive-coin'
        ? t('send.quantumrootReceive')
        : null;
  const quantumrootPrefillHint =
    locationState?.assetType === 'nft'
      ? t('send.quantumrootNftHint')
      : t('send.quantumrootHint');

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
        <PageHeader title={t('send.title')} compact />
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
                  {t('send.quantumrootShortcut')}
                </div>
                <div className="mt-1 text-sm font-semibold wallet-text-strong">
                  {t('send.quantumrootPrefilled', {
                    label: quantumrootPrefillLabel,
                  })}
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
              <div className="mb-1 wallet-kicker">{t('send.transferMode')}</div>
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
                  {t('send.token')}
                </button>
                <Link
                  to="/apps/optn.builtin.events:airdropsApp"
                  state={{ returnTo: '/send' }}
                  className="wallet-btn-secondary flex min-h-[42px] items-center justify-center rounded-[16px] px-3 py-2 text-sm font-semibold"
                  title={t('send.openAirdrops')}
                >
                  {t('send.airdrops')}
                </Link>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
              <div className="wallet-section">
                <Label>{t('send.recipient')}</Label>
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
                    title={t('send.scanQr')}
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
                      {t('send.copy')}
                    </button>
                  </div>
                )}
              </div>

              {assetType === 'bch' && (
                <div className="wallet-section">
                  <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2">
                    <div className="min-w-0">
                      <Label>
                        {amountDisplayMode === 'bch'
                          ? t('send.amountBch')
                          : t('send.amountUsd')}
                      </Label>
                      <input
                        value={
                          amountDisplayMode === 'bch' ? amountBch : amountUsd
                        }
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
                      className="wallet-segment-inactive min-h-[42px] self-end rounded-[16px] border border-[var(--wallet-border)] px-3 py-2 text-sm font-semibold transition"
                      onClick={() => void doMax()}
                      disabled={isSending || maxBusy}
                      aria-label={t('send.fillMax')}
                    >
                      {maxBusy ? '…' : t('send.max')}
                    </button>
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
                          ? t('send.switchToUsd')
                          : t('send.switchToBch')
                      }
                    >
                      {amountDisplayMode === 'bch' ? 'USD' : 'BCH'}
                    </button>
                  </div>
                  <div className="mt-2 text-xs wallet-muted">
                    {spendableSummary}
                  </div>
                  <div className="mt-1 text-xs wallet-muted">
                    {bchUsdPrice > 0
                      ? amountDisplayMode === 'bch'
                        ? amountBch
                          ? `~$${amountUsd || '0.00'} USD`
                          : t('send.enterBchForUsd')
                        : amountUsd
                          ? `~${amountBch || '0.00000000'} BCH`
                          : t('send.enterUsdForBch')
                      : t('send.usdUnavailable')}
                  </div>
                </div>
              )}

              {assetType === 'ft' && (
                <div className="wallet-section space-y-3">
                  <div className="flex flex-col gap-1">
                    <div className="wallet-kicker">
                      {t('send.assetControl')}
                    </div>
                    {renderTokenModeToggle()}
                    <Label>{t('send.tokenCategory')}</Label>
                    <select
                      value={selectedCategory}
                      onChange={(e) => setSelectedCategory(e.target.value)}
                      className={selectClass}
                    >
                      <option value="" disabled>
                        {t('send.selectCategory')}
                      </option>
                      {ftCategories.map((c) => {
                        const pretty = displayTokenName(c.category);
                        const dec = tokenMeta[c.category]?.decimals ?? 0;
                        const human = formatFtAmount(c.ftAmount, dec);
                        return (
                          <option key={c.category} value={c.category}>
                            {pretty} · {t('send.balance')}: {human}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>
                      {t('send.tokenAmount')}
                      {selectedTokenDecimals > 0
                        ? ` (${t('send.decimals', { count: selectedTokenDecimals })})`
                        : ` (${t('send.integer')})`}
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
                      {t('send.bcmrMetadata')}
                    </div>
                  </div>
                </div>
              )}

              {assetType === 'nft' && (
                <div className="wallet-section space-y-3">
                  <div className="flex flex-col gap-1">
                    <div className="wallet-kicker">
                      {t('send.assetControl')}
                    </div>
                    {renderTokenModeToggle()}
                    <Label>{t('send.nftCategory')}</Label>
                    <select
                      value={selectedCategory}
                      onChange={(e) => setSelectedCategory(e.target.value)}
                      className={selectClass}
                    >
                      <option value="" disabled>
                        {t('send.selectCategory')}
                      </option>
                      {nftCategories.map((c) => {
                        const pretty = displayTokenName(c.category);
                        return (
                          <option key={c.category} value={c.category}>
                            {pretty} · {t('send.nfts')}:{' '}
                            {c.nftCommitments.length}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  {selectedCategory && (
                    <div className="flex flex-col gap-1">
                      <Label>{t('send.nftCommitment')}</Label>
                      <input
                        value={selectedNftCommitment}
                        onChange={(e) =>
                          setSelectedNftCommitment(e.target.value.trim())
                        }
                        placeholder={t('send.optionalHexCommitment')}
                        className={inputClass}
                      />
                      <div className="text-[11px] wallet-muted">
                        {t('send.leaveBlankNft')}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <CoinControlSection
                walletId={walletId}
                utxos={dbUtxos}
                enabled={coinControlEnabled}
                onEnabledChange={setCoinControlEnabled}
                selectedKeys={selectedCoinKeys}
                onSelectedKeysChange={setSelectedCoinKeys}
                disabled={isSending || maxBusy}
              />

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
                ? t('send.submitted')
                : t('send.sent')}
            </div>
            {broadcastState === 'submitted' && (
              <div className="mb-2 wallet-muted">{t('send.keepTxid')}</div>
            )}
            <div className="break-all font-mono wallet-text-strong">{txid}</div>
          </div>
        )}

        {hasUnresolved && (
          <div className="wallet-card mt-3 shrink-0 p-3 border border-[var(--wallet-warning-border,rgba(217,119,6,0.4))]">
            <div className="text-sm font-semibold wallet-text-strong">
              {t('outbox.pendingOutgoing')}
            </div>
            <div className="text-xs wallet-muted mt-1">
              {t('outbox.description')}
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                type="button"
                className="wallet-btn-secondary px-3 py-1.5 text-sm"
                disabled={outboundReconciling}
                onClick={() => void refreshOutbound()}
              >
                {outboundReconciling
                  ? t('history.loadingDetails')
                  : t('outbox.releaseStale')}
              </button>
              {outboundTransactions.some((r) => canClearOutbound(r.txid)) && (
                <button
                  type="button"
                  className="wallet-btn-secondary px-3 py-1.5 text-sm"
                  onClick={() => {
                    void (async () => {
                      for (const r of outboundTransactions) {
                        if (canClearOutbound(r.txid)) {
                          await releaseOutbound(r.txid);
                        }
                      }
                    })();
                  }}
                >
                  {t('outbox.clearPending')}
                </button>
              )}
              <button
                type="button"
                className="wallet-btn-secondary px-3 py-1.5 text-sm"
                onClick={() => navigate('/outbox')}
              >
                {t('outbox.title')}
              </button>
            </div>
          </div>
        )}

        <div className="wallet-card mt-3 shrink-0 p-3 pb-[calc(var(--safe-bottom)+1rem)]">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleReviewClick()}
              disabled={
                isSending || isReviewBusy || !canReview || hasUnresolved
              }
              className="wallet-btn-primary flex-1"
              title={
                hasUnresolved
                  ? t('send.waitPrevious')
                  : isReviewBusy
                    ? t('send.sending')
                    : !canReview
                      ? t('send.fillRequired')
                      : t('send.review')
              }
            >
              {hasUnresolved
                ? t('send.pending')
                : isReviewBusy
                  ? t('send.sending')
                  : t('send.review')}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={isSending || maxBusy || isReviewBusy}
              className="wallet-btn-secondary px-4"
              title={t('send.clearForm')}
            >
              {t('send.reset')}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => navigate(backTarget)}
          className="wallet-btn-danger w-full py-3 font-semibold"
        >
          {t('send.back')}
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
            sendStatus={sendStatus}
            isHardwareWallet={isHardwareWallet}
            onClose={() => setReviewModalOpen(false)}
            onConfirmSend={handleConfirmSend}
          />
        )}
      </div>
    </WalletScreen>
  );
}

// src/pages/SimpleSend.tsx

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import useSimpleSend from '../../hooks/useSimpleSend';
import { FaCamera, FaQrcode, FaShieldAlt } from 'react-icons/fa';
import { ReviewCard } from './ReviewCard';
import { ChangeAddressSection } from './ChangeAddressSection';
import { CategorySummary } from './types';
import { formatFtAmount } from './utils';
import { useTokenMetadata } from './useTokenMetadata';
import { useRecipientScanner } from './useRecipientScanner';
import { useSimpleSendViewModel } from './useSimpleSendViewModel';
import { parseBip21Uri } from '../../utils/bip21';
import PageHeader from '../../components/ui/PageHeader';
import useOutboundTransactions from '../../hooks/useOutboundTransactions';
import { selectWalletId } from '../../state/slices/walletSlice';
import WalletScreen from '../../components/ui/WalletScreen';
import RouteExitFooter from '../../components/ui/RouteExitFooter';
import { CoinControlSection } from '../../components/CoinControlSection';
import { getReturnPath } from '../../utils/navigation';
import { SATSINBITCOIN, TOKEN_OUTPUT_SATS } from '../../utils/constants';
import { useI18n } from '../../i18n/useI18n';
import { shouldShowSendReview } from './reviewVisibility';
import BchUsdControl from '../../components/ui/BchUsdControl';
import FriendlyErrorPanel from '../../components/ui/FriendlyErrorPanel';
import InfoButton from '../../components/ui/InfoButton';
import MaskedValue from '../../components/ui/MaskedValue';
import { useWalletConfirm } from '../../components/WalletConfirmDialog';
import { OUTBOUND_RELEASE_DELAY_MS } from '../../services/OutboundTransactionTracker';

type SimpleSendLocationState = {
  amountBch?: string;
  amountToken?: string;
  tokenOutputBch?: string;
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

function isInsufficientFundsError(error: string): boolean {
  const normalized = error.toLowerCase();
  return [
    'insufficient funds',
    'not enough funds',
    'unable to build bch send',
    'unable to build with non-token bch fee utxos',
    'network fee',
  ].some((marker) => normalized.includes(marker));
}

export default function SimpleSend() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();
  const confirm = useWalletConfirm();
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
    tokenOutputBch,
    setTokenOutputBch,
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
    const spendableBchValue = spendableSats / SATSINBITCOIN;
    const spendableBch = spendableBchValue.toFixed(8).replace(/\.?0+$/, '');
    const coinLabel = t(dbUtxos.length === 1 ? 'send.coin' : 'send.coins');
    if (amountDisplayMode === 'usd') {
      if (bchUsdPrice <= 0) return t('send.usdUnavailable');
      return t('send.spendableUsdSummary', {
        amount: `$${(spendableBchValue * bchUsdPrice).toFixed(2)}`,
        count: dbUtxos.length,
        coins: coinLabel,
      });
    }
    return t('send.spendableSummary', {
      amount: spendableBch,
      count: dbUtxos.length,
      coins: coinLabel,
    });
  }, [amountDisplayMode, bchUsdPrice, dbUtxos, t]);
  const spendableSats = useMemo(
    () =>
      dbUtxos.reduce((sum, utxo) => {
        const raw = utxo.amount ?? utxo.value ?? 0;
        return sum + (typeof raw === 'bigint' ? Number(raw) : Number(raw) || 0);
      }, 0),
    [dbUtxos]
  );
  const enteredAmountExceedsSpendable =
    assetType === 'bch' &&
    Number.isFinite(Number(amountBch)) &&
    Number(amountBch) > spendableSats / SATSINBITCOIN;
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const recipientInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const tokenAmountInputRef = useRef<HTMLInputElement>(null);
  const tokenOutputBchInputRef = useRef<HTMLInputElement>(null);
  const advancedOptionsRef = useRef<HTMLDivElement>(null);
  const pendingReleaseConfirmationInFlight = useRef(false);
  const [pendingReleaseBusy, setPendingReleaseBusy] = useState(false);
  const [pendingReviewFlow, setPendingReviewFlow] = useState(false);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const isReviewBusy = reviewBusy || pendingReviewFlow;

  useEffect(() => {
    if (!showAdvancedOptions) return;
    const frame = window.requestAnimationFrame(() => {
      advancedOptionsRef.current?.scrollIntoView({
        behavior: 'auto',
        block: 'start',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showAdvancedOptions]);

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
    tokenOutputBch,
  });

  const { scanBusy, handleScanRecipient } = useRecipientScanner({
    setRecipient,
    setAmountBch,
    setAssetType,
    currentNetwork,
    assetType,
  });

  const normalizeRecipientInput = () => {
    const parsed = parseBip21Uri(recipient, currentNetwork);
    if (!parsed.isValidAddress) return;

    setRecipient(parsed.normalizedAddress);
    if (parsed.amountRaw && assetType === 'bch') {
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
    if (isInsufficientFundsError(err) || enteredAmountExceedsSpendable) {
      return t('send.insufficientFunds');
    }
    if (
      /\b(connection|timeout|econnrefused|offline|unreachable)\b/i.test(err) ||
      /^network error\b/i.test(err)
    ) {
      return t('send.networkError');
    }
    return t('send.genericError');
  };

  const pageError = mode === 'error' ? error : null;
  const enhancedError = pageError ? enhanceErrorMessage(pageError) : null;
  const focusErrorField = () => {
    if (
      pageError &&
      (isInsufficientFundsError(pageError) || enteredAmountExceedsSpendable)
    ) {
      if (assetType === 'bch') amountInputRef.current?.focus();
      else if (assetType === 'ft') tokenAmountInputRef.current?.focus();
      else tokenOutputBchInputRef.current?.focus();
      return;
    }
    recipientInputRef.current?.focus();
  };

  const handleReleasePending = async () => {
    if (pendingReleaseConfirmationInFlight.current) return;
    const clearable = outboundTransactions.filter((record) =>
      canClearOutbound(record.txid)
    );
    if (clearable.length === 0) return;

    pendingReleaseConfirmationInFlight.current = true;
    setPendingReleaseBusy(true);
    const message = clearable.every((record) => record.state === 'submitted')
      ? t('outbox.clearPendingTitle')
      : t('outbox.releaseStaleTitle', {
          minutes: Math.round(OUTBOUND_RELEASE_DELAY_MS / 60000),
        });
    try {
      if (!(await confirm(message))) return;
      for (const record of clearable) {
        await releaseOutbound(record.txid);
      }
    } finally {
      pendingReleaseConfirmationInFlight.current = false;
      setPendingReleaseBusy(false);
    }
  };
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
    if (locationState.tokenOutputBch !== undefined) {
      setTokenOutputBch(locationState.tokenOutputBch);
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
    setTokenOutputBch,
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
        className={`min-h-[44px] rounded-[16px] px-3 py-2 text-sm font-semibold border transition ${
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
        className={`min-h-[44px] rounded-[16px] px-3 py-2 text-sm font-semibold border transition ${
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

  const renderTokenBchValue = () => (
    <div className="flex flex-col gap-1">
      <Label>{t('send.tokenBchAmount')}</Label>
      <input
        value={tokenOutputBch}
        onChange={(e) => setTokenOutputBch(e.target.value)}
        ref={tokenOutputBchInputRef}
        inputMode="decimal"
        placeholder={`${(TOKEN_OUTPUT_SATS / SATSINBITCOIN).toFixed(8)} BCH`}
        className={inputClass}
      />
      <div className="text-[11px] wallet-muted">
        {t('send.tokenBchMinimum', { sats: TOKEN_OUTPUT_SATS })}
      </div>
    </div>
  );

  return (
    <WalletScreen maxWidthClassName="max-w-xl" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title={t('send.send')}
          subtitle={
            currentNetwork === 'chipnet' ? t('network.chipnet') : undefined
          }
          compact
        />
        <p className="-mt-2 text-sm wallet-muted">
          {t('send.guidedDescription')}
        </p>
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
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={`min-h-[44px] rounded-[16px] px-3 py-2 text-sm font-semibold border transition ${
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
                  className={`min-h-[44px] rounded-[16px] px-3 py-2 text-sm font-semibold border transition ${
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
                  className="wallet-btn-secondary col-span-2 flex min-h-[44px] items-center justify-center rounded-[16px] px-3 py-2 text-sm font-semibold"
                  title={t('send.openAirdrops')}
                >
                  {t('send.airdrops')}
                </Link>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
              <div className="wallet-section">
                <div className="flex items-center gap-1">
                  <Label>{t('send.recipient')}</Label>
                  <InfoButton
                    id="send-recipient-help"
                    ariaLabel={t('send.recipientHelpLabel')}
                    content={t('send.recipientHelp')}
                  />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    ref={recipientInputRef}
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
                    aria-label={t('send.scanQr')}
                    title={t('send.scanQr')}
                    className="wallet-btn-primary flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center px-3"
                  >
                    <FaCamera aria-hidden="true" />
                  </button>
                </div>
                {!!recipient && (
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px] wallet-muted">
                    <MaskedValue
                      value={recipient}
                      label={t('send.recipient')}
                      ariaLabel={t('receive.copyAddress')}
                      copySuccessMessageKey="receive.addressCopied"
                      className="max-w-[75%] truncate text-[11px]"
                    />
                  </div>
                )}
              </div>

              {assetType === 'bch' && (
                <div className="wallet-section">
                  <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(112px,auto)] items-end gap-2">
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
                        ref={amountInputRef}
                        inputMode="decimal"
                        placeholder={
                          amountDisplayMode === 'bch'
                            ? '0.00000000 BCH'
                            : '0.00 USD'
                        }
                        className={`${inputClass} mt-2`}
                      />
                    </div>
                    <BchUsdControl
                      value={amountDisplayMode}
                      onChange={setAmountDisplayMode}
                      disabled={isSending}
                      className="self-end"
                    />
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
                      ref={tokenAmountInputRef}
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
                  {renderTokenBchValue()}
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
                  {renderTokenBchValue()}
                </div>
              )}

              <div
                ref={advancedOptionsRef}
                className="wallet-section flex min-h-[44px] w-full items-center gap-2 rounded-2xl px-3 py-2"
              >
                <button
                  type="button"
                  aria-expanded={showAdvancedOptions}
                  className="flex min-h-[44px] min-w-0 flex-1 items-center justify-between gap-3 text-left"
                  onClick={() => setShowAdvancedOptions((open) => !open)}
                >
                  <span>
                    <span className="block font-semibold wallet-text-strong">
                      {t('send.advanced')}
                    </span>
                    <span className="block text-xs wallet-muted">
                      {t('send.changeAddress')}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-lg font-semibold wallet-accent-icon"
                  >
                    {showAdvancedOptions ? '⌃' : '⌄'}
                  </span>
                </button>
                <InfoButton
                  id="send-advanced-help"
                  ariaLabel={t('send.advancedHelpLabel')}
                  content={t('send.advancedHelp')}
                />
              </div>

              {showAdvancedOptions ? (
                <div className="space-y-3">
                  {assetType === 'bch' ? (
                    <div className="wallet-section flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold wallet-text-strong">
                          {t('send.max')}
                        </div>
                        <div className="text-xs wallet-muted">
                          {t('send.fillMax')}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="wallet-btn-secondary min-h-[44px] shrink-0 px-4"
                        onClick={() => void doMax()}
                        disabled={isSending || maxBusy}
                        aria-label={t('send.fillMax')}
                      >
                        {maxBusy ? '…' : t('send.max')}
                      </button>
                    </div>
                  ) : null}

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
              ) : null}
            </div>
          </div>
        </div>

        {/* Error */}
        {enhancedError && (
          <FriendlyErrorPanel
            className="mt-3 shrink-0 shadow-sm"
            title={t('send.errorTitle')}
            message={enhancedError}
            action={
              <button
                type="button"
                className="wallet-btn-secondary"
                onClick={focusErrorField}
              >
                {t('send.editPayment')}
              </button>
            }
          />
        )}

        {mode === 'sent' && txid && (
          <div className="mt-3 p-4 rounded-2xl border wallet-success-panel text-sm shadow-sm shrink-0">
            <div className="mb-1 flex items-center gap-1 font-semibold wallet-text-strong">
              <span>
                {broadcastState === 'submitted'
                  ? t('send.submitted')
                  : t('send.sent')}
              </span>
              <InfoButton
                id="send-success-help"
                ariaLabel={t('send.sentHelpLabel')}
                content={t('send.sentHelp')}
              />
            </div>
            {broadcastState === 'submitted' && (
              <div className="mb-2 wallet-muted">{t('send.keepTxid')}</div>
            )}
            <MaskedValue
              value={txid}
              label={t('history.transactionId')}
              copySuccessMessageKey="history.transactionCopied"
              className="block w-full wallet-text-strong"
            />
          </div>
        )}

        {hasUnresolved && (
          <div className="wallet-card mt-3 shrink-0 p-3 border border-[var(--wallet-warning-border,rgba(217,119,6,0.4))]">
            <div className="flex items-center gap-1 text-sm font-semibold wallet-text-strong">
              <span>{t('outbox.pendingOutgoing')}</span>
              <InfoButton
                id="send-pending-help"
                ariaLabel={t('outbox.pendingHelpLabel')}
                content={t('outbox.pendingHelp')}
              />
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
                  disabled={pendingReleaseBusy}
                  onClick={() => {
                    void handleReleasePending();
                  }}
                >
                  {pendingReleaseBusy
                    ? t('outbox.releaseSendLock')
                    : t('outbox.clearPending')}
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
                    ? t('send.preparingReview')
                    : !canReview
                      ? t('send.fillRequired')
                      : t('send.review')
              }
            >
              {hasUnresolved
                ? t('send.pending')
                : isReviewBusy
                  ? t('send.preparingReview')
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
          {!canReview && !hasUnresolved && !isSending && !isReviewBusy && (
            <p className="mt-2 px-1 text-center text-xs wallet-muted">
              {t('send.fillRequired')}
            </p>
          )}
        </div>

        <RouteExitFooter
          label={t('send.back')}
          onBack={() => navigate(backTarget)}
        />

        {shouldShowSendReview(mode, review !== null) && review && (
          <ReviewCard
            open={reviewModalOpen}
            review={review}
            recipient={recipient}
            networkLabel={t(
              currentNetwork === 'chipnet'
                ? 'network.chipnet'
                : 'network.mainnet'
            )}
            assetType={assetType}
            amountBch={amountBch}
            fiatSummary={fiatSummary}
            selectedCategory={selectedCategory}
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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import type { AddonSDK } from '../../../services/AddonsSDK';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import { selectWalletId } from '../../../state/slices/walletSlice';
import type { RootState } from '../../../state/store';
import WalletScreen from '../../../components/ui/WalletScreen';
import { getReturnPath } from '../../../utils/navigation';
import {
  CAULDRON_NATIVE_BCH,
  CauldronApiClient,
  fetchNormalizedCauldronPools,
  planAggregatedTradeForTargetDemand,
  type CauldronPoolTrade,
  type CauldronPool,
} from '../../../services/cauldron';
import { parseDecimalToAtomic } from '../../../services/cauldron/amount';
import { formatAtomicTokenAmount } from '../../../utils/tokenPresentation';
import { useSmoothResetTransition } from '../shared/useSmoothResetTransition';
import { attemptMerchantAutoSettlement } from './merchantPaySettlement';
import MerchantAmountPad from './MerchantAmountPad';
import {
  buildMerchantPaymentRequest,
  type MerchantPaymentRequest,
  type MerchantQuotePreview,
} from './merchantPayRequest';
import {
  getDefaultMerchantStablecoin,
  getMerchantStablecoins,
  isMerchantStablecoin,
} from './merchantStablecoins';

type MerchantPayAppProps = {
  sdk: AddonSDK;
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

type QuoteMessageTone = 'muted' | 'warning' | 'danger';

type QuoteMessage = {
  tone: QuoteMessageTone;
  text: string;
} | null;

type Notice = {
  kind: 'success' | 'warning' | 'error';
  message: string;
} | null;

type MerchantPayScreen = 'token' | 'amount' | 'request';
type AutoSettleStatus = 'idle' | 'watching' | 'broadcasting' | 'settled' | 'error';

const REQUEST_TTL_MS = 120_000;
const QUOTE_PROTECTION_BPS = 100n;
const NOTICE_AUTO_DISMISS_MS = 4200;
const REQUEST_QR_SIZE = 176;

function formatFixedAtomicAmount(amount: bigint, decimals: number): string {
  const normalizedDecimals = Math.max(0, Math.trunc(decimals));
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;

  if (normalizedDecimals === 0) {
    return `${negative ? '-' : ''}${absolute.toString()}`;
  }

  const scale = 10n ** BigInt(normalizedDecimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale)
    .toString()
    .padStart(normalizedDecimals, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

function formatCompactBchAmount(valueSats: bigint): string {
  return `${formatAtomicTokenAmount(valueSats, 8)} BCH`;
}

function formatCountdownLabel(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return 'Expired';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function NoticeBanner({ notice }: { notice: Notice }) {
  if (!notice) return null;

  const className =
    notice.kind === 'success'
      ? 'wallet-success-panel'
      : notice.kind === 'warning'
        ? 'wallet-warning-panel'
        : 'wallet-danger-panel';

  return (
    <div className={`${className} rounded-2xl px-3 py-2 text-xs shadow-lg`}>
      {notice.message}
    </div>
  );
}

function CopyActionButton({
  label,
  onClick,
  variant = 'secondary',
  disabled = false,
  compact = false,
}: {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${
        variant === 'primary' ? 'wallet-btn-primary' : 'wallet-btn-secondary'
      } w-full ${compact ? 'px-3 py-2 text-[12px] leading-tight' : 'px-4 py-3.5'} ${
        disabled ? 'cursor-not-allowed opacity-70' : ''
      }`}
    >
      {label}
    </button>
  );
}

export default function MerchantPayApp({
  sdk,
  manifest,
  app,
}: MerchantPayAppProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const backTarget = getReturnPath(location, '/apps');
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const walletId = useSelector(selectWalletId);
  const { contentClassName } = useSmoothResetTransition();

  const apiClient = useMemo(
    () => new CauldronApiClient(currentNetwork),
    [currentNetwork]
  );
  const merchantStablecoins = useMemo(
    () => getMerchantStablecoins(currentNetwork),
    [currentNetwork]
  );

  const [selectedStablecoinId, setSelectedStablecoinId] = useState('');
  const [amount, setAmount] = useState('');
  const [stablecoinPools, setStablecoinPools] = useState<CauldronPool[]>([]);
  const [draftTrades, setDraftTrades] = useState<CauldronPoolTrade[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [poolLoadError, setPoolLoadError] = useState<string | null>(null);
  const [draftQuote, setDraftQuote] = useState<MerchantQuotePreview | null>(
    null
  );
  const [screen, setScreen] = useState<MerchantPayScreen>('token');
  const [quoteMessage, setQuoteMessage] = useState<QuoteMessage>({
    tone: 'muted',
    text: 'Enter amount.',
  });
  const [paymentRequest, setPaymentRequest] =
    useState<MerchantPaymentRequest | null>(null);
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [autoSettleEnabled, setAutoSettleEnabled] = useState(false);
  const [autoSettleStatus, setAutoSettleStatus] =
    useState<AutoSettleStatus>('idle');
  const [autoSettleNote, setAutoSettleNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const autoSettleInFlightRef = useRef(false);
  const autoSettleEnabledRef = useRef(false);

  useEffect(() => {
    autoSettleEnabledRef.current = autoSettleEnabled;
  }, [autoSettleEnabled]);

  const selectedStablecoin = useMemo(() => {
    if (!selectedStablecoinId) {
      return getDefaultMerchantStablecoin(currentNetwork);
    }
    return (
      merchantStablecoins.find(
        (stablecoin) => stablecoin.tokenId === selectedStablecoinId
      ) ?? getDefaultMerchantStablecoin(currentNetwork)
    );
  }, [currentNetwork, merchantStablecoins, selectedStablecoinId]);

  const selectedDecimals = selectedStablecoin?.decimals ?? 2;
  const selectedAmountAtomic = useMemo(
    () => parseDecimalToAtomic(amount, selectedDecimals),
    [amount, selectedDecimals]
  );

  useEffect(() => {
    const defaultStablecoin = getDefaultMerchantStablecoin(currentNetwork);
    setScreen('token');
    setSelectedStablecoinId((current) => {
      if (
        current &&
        isMerchantStablecoin(currentNetwork, current) &&
        merchantStablecoins.some((stablecoin) => stablecoin.tokenId === current)
      ) {
        return current;
      }
      return defaultStablecoin?.tokenId ?? '';
    });
    setAmount('');
    setDraftQuote(null);
    setDraftTrades([]);
    setPaymentRequest(null);
    setAutoSettleEnabled(false);
    setAutoSettleStatus('idle');
    setAutoSettleNote(null);
    setPoolLoadError(null);
    setQuoteMessage({
      tone: 'muted',
      text: 'Enter amount.',
    });
  }, [currentNetwork, merchantStablecoins]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedStablecoin?.tokenId) {
      setStablecoinPools([]);
      setPoolsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setPoolsLoading(true);
    setPoolLoadError(null);
    setStablecoinPools([]);

    void (async () => {
      try {
        const pools = await fetchNormalizedCauldronPools(
          currentNetwork,
          apiClient,
          selectedStablecoin.tokenId
        );
        if (cancelled) return;
        setStablecoinPools(pools);
      } catch (error) {
        if (cancelled) return;
        console.warn('[MerchantPay] failed to load merchant pools', error);
        setStablecoinPools([]);
        setPoolLoadError(
          'Unable to load merchant pools right now. Try again in a moment.'
        );
      } finally {
        if (!cancelled) setPoolsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiClient, currentNetwork, selectedStablecoin?.tokenId]);

  useEffect(() => {
    setPaymentRequest(null);
    setNotice(null);
    setDraftTrades([]);
    setAutoSettleEnabled(false);
    setAutoSettleStatus('idle');
    setAutoSettleNote(null);
  }, [amount, selectedStablecoinId]);

  useEffect(() => {
    if (poolLoadError) {
      setDraftQuote(null);
      setDraftTrades([]);
      setQuoteMessage({ tone: 'danger', text: poolLoadError });
      return;
    }

    if (!selectedStablecoin) {
      setDraftQuote(null);
      setDraftTrades([]);
      setQuoteMessage({
        tone: 'muted',
        text: 'Choose a settlement stablecoin.',
      });
      return;
    }

    if (!amount.trim()) {
      setDraftQuote(null);
      setDraftTrades([]);
      setQuoteMessage({
        tone: 'muted',
        text: 'Enter amount.',
      });
      return;
    }

    if (selectedAmountAtomic <= 0n) {
      setDraftQuote(null);
      setDraftTrades([]);
      setQuoteMessage({
        tone: 'warning',
        text: 'Enter a valid amount.',
      });
      return;
    }

    if (poolsLoading) {
      setDraftQuote(null);
      setDraftTrades([]);
      setQuoteMessage({
        tone: 'muted',
        text: 'Loading pools...',
      });
      return;
    }

    if (stablecoinPools.length === 0) {
      setDraftQuote(null);
      setDraftTrades([]);
      setQuoteMessage({
        tone: 'warning',
        text: 'No liquidity.',
      });
      return;
    }

    const planned = planAggregatedTradeForTargetDemand(
      stablecoinPools,
      CAULDRON_NATIVE_BCH,
      selectedStablecoin.tokenId,
      selectedAmountAtomic
    );

    if (!planned) {
      setDraftQuote(null);
      setDraftTrades([]);
      setQuoteMessage({
        tone: 'warning',
        text: 'Not enough liquidity. Try a smaller amount.',
      });
      return;
    }

    const now = Date.now();
    setDraftQuote({
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      merchantReceivesAtomic: planned.summary.demand,
      merchantReceivesDisplay: `${formatFixedAtomicAmount(
        planned.summary.demand,
        selectedStablecoin.decimals
      )} ${selectedStablecoin.symbol}`,
      customerPaysSats: planned.summary.supply,
      customerPaysDisplay: formatCompactBchAmount(planned.summary.supply),
      routePoolCount: planned.trades.length,
      quoteProtectionBps: QUOTE_PROTECTION_BPS,
    });
    setDraftTrades(planned.trades);
    setQuoteMessage(null);
  }, [
    amount,
    poolLoadError,
    poolsLoading,
    selectedAmountAtomic,
    selectedStablecoin,
    stablecoinPools,
  ]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeoutId = window.setTimeout(
      () => setNotice(null),
      NOTICE_AUTO_DISMISS_MS
    );
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const stageExpiresIn = draftQuote
    ? formatCountdownLabel(draftQuote.expiresAt - nowMs)
    : null;
  const requestExpiresIn = paymentRequest
    ? formatCountdownLabel(paymentRequest.expiresAt - nowMs)
    : null;
  const requestExpired =
    paymentRequest != null && paymentRequest.expiresAt <= nowMs;
  const draftQuoteExpired = draftQuote != null && draftQuote.expiresAt <= nowMs;
  const screenTitle =
    screen === 'token'
      ? 'Stablecoin'
      : screen === 'amount'
        ? 'Amount'
        : 'Request';

  const handleBack = () => {
    if (screen === 'request') {
      setPaymentRequest(null);
      setNotice(null);
      setAutoSettleEnabled(false);
      setAutoSettleStatus('idle');
      setAutoSettleNote(null);
      setScreen('amount');
      return;
    }

    if (screen === 'amount') {
      setNotice(null);
      setScreen('token');
      return;
    }

    navigate(backTarget);
  };

  const handleContinueFromToken = () => {
    setNotice(null);
    setScreen('amount');
  };

  const handleChangeToken = () => {
    setNotice(null);
    setScreen('token');
  };

  const handleCreatePaymentRequest = async () => {
    if (creatingRequest) return;

    try {
      setCreatingRequest(true);
      setNotice(null);
      setAutoSettleEnabled(false);
      setAutoSettleStatus('idle');
      setAutoSettleNote(null);

      if (!selectedStablecoin) {
        throw new Error('Choose a stablecoin first.');
      }

      if (!draftQuote) {
        throw new Error('Enter an amount first.');
      }

      if (draftQuoteExpired) {
        throw new Error('This quote expired. Enter the amount again.');
      }

      if (selectedAmountAtomic <= 0n) {
        throw new Error('Enter a valid amount.');
      }

      const createdRequest = await buildMerchantPaymentRequest({
        sdk,
        currentNetwork,
        draftQuote,
        selectedStablecoin,
      });

      setPaymentRequest(createdRequest);
      setScreen('request');
    } catch (error) {
      setNotice({
        kind: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to create the payment request.',
      });
    } finally {
      setCreatingRequest(false);
    }
  };

  const handleToggleAutoSettle = () => {
    if (autoSettleEnabled) {
      setAutoSettleEnabled(false);
      setAutoSettleStatus('idle');
      setAutoSettleNote(null);
      return;
    }

    if (!paymentRequest || !draftQuote || draftTrades.length === 0) {
      setNotice({
        kind: 'warning',
        message: 'Create the payment request first.',
      });
      return;
    }

    if (requestExpired) {
      setNotice({
        kind: 'warning',
        message: 'This payment request expired. Create a new one first.',
      });
      return;
    }

    setAutoSettleEnabled(true);
    setAutoSettleStatus('watching');
    setAutoSettleNote('Watching for the BCH payment to arrive.');
  };

  const handleCopyPaymentUri = async () => {
    if (!paymentRequest) return;
    try {
      await copyTextToClipboard(paymentRequest.paymentUri);
      setNotice({
        kind: 'success',
        message: 'BCH URI copied.',
      });
    } catch {
      setNotice({
        kind: 'error',
        message: 'Unable to copy the BCH URI right now.',
      });
    }
  };

  const handleCopyPaymentDetails = async () => {
    if (!paymentRequest) return;
    try {
      await copyTextToClipboard(paymentRequest.detailsText);
      setNotice({
        kind: 'success',
        message: 'Payment details copied.',
      });
    } catch {
      setNotice({
        kind: 'error',
        message: 'Unable to copy payment details right now.',
      });
    }
  };

  const handleSharePaymentRequest = async () => {
    if (!paymentRequest) return;

    const shareText = paymentRequest.paymentUri;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Merchant BCH payment request',
          text: shareText,
        });
        setNotice({
          kind: 'success',
          message: 'Share sheet opened.',
        });
        return;
      } catch (error) {
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'NotAllowedError')
        ) {
          return;
        }
      }
    }

    try {
      await copyTextToClipboard(shareText);
      setNotice({
        kind: 'warning',
        message: 'Share is unavailable here, so the BCH URI was copied.',
      });
    } catch {
      setNotice({
        kind: 'error',
        message: 'Unable to share or copy right now.',
      });
    }
  };

  const handleNewPayment = () => {
    setDraftQuote(null);
    setDraftTrades([]);
    setPaymentRequest(null);
    setNotice(null);
    setAutoSettleEnabled(false);
    setAutoSettleStatus('idle');
    setAutoSettleNote(null);
    setAmount('');
    setQuoteMessage({
      tone: 'muted',
      text: 'Enter amount.',
    });
    setScreen('amount');
  };

  useEffect(() => {
    if (!autoSettleEnabled || screen !== 'request' || !paymentRequest) {
      autoSettleInFlightRef.current = false;
      return undefined;
    }

    let cancelled = false;

    const pollForSettlement = async () => {
      if (cancelled || autoSettleInFlightRef.current) {
        return;
      }
      if (paymentRequest.expiresAt <= Date.now()) {
        setAutoSettleEnabled(false);
        setAutoSettleStatus('idle');
        setAutoSettleNote('This payment request expired.');
        return;
      }
      if (!draftQuote || draftTrades.length === 0) {
        setAutoSettleEnabled(false);
        setAutoSettleStatus('error');
        setAutoSettleNote('No settlement route is available.');
        return;
      }

      autoSettleInFlightRef.current = true;
      try {
        const result = await attemptMerchantAutoSettlement({
          sdk,
          walletId,
          paymentRequest,
          draftTrades,
          selectedStablecoin,
        });

        if (cancelled || !autoSettleEnabledRef.current) return;

        if (result.status === 'waiting') {
          setAutoSettleStatus('watching');
          setAutoSettleNote(
            `Waiting for ${paymentRequest.customerPaysDisplay} to arrive.`
          );
          return;
        }

        setAutoSettleStatus('settled');
        setAutoSettleEnabled(false);
        setAutoSettleNote(
          result.txid
            ? `Converted to stablecoins. Txid ${result.txid.slice(0, 8)}...${result.txid.slice(-6)}`
            : 'Converted to stablecoins.'
        );
        setNotice({
          kind: 'success',
          message: 'Incoming BCH was converted to stablecoins.',
        });
      } catch (error) {
        if (cancelled) return;
        autoSettleInFlightRef.current = false;
        setAutoSettleEnabled(false);
        setAutoSettleStatus('error');
        setAutoSettleNote(
          error instanceof Error
            ? error.message
            : 'Unable to auto-settle right now.'
        );
        setNotice({
          kind: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to auto-settle right now.',
        });
        return;
      } finally {
        autoSettleInFlightRef.current = false;
      }
    };

    void pollForSettlement();
    const intervalId = window.setInterval(() => {
      void pollForSettlement();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    autoSettleEnabled,
    draftQuote,
    draftTrades,
    paymentRequest,
    screen,
    sdk,
    selectedStablecoin,
    walletId,
  ]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div
        className="flex h-full min-h-0 flex-col gap-3"
        data-addon-id={manifest.id}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[16px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_20%,var(--wallet-surface-strong))] shadow-lg">
              <img
                src="/assets/images/OPTNUIkeyline2.png"
                alt="OPTN"
                className="h-7 w-7 object-contain"
              />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] wallet-muted opacity-70">
                Merchant Pay
              </div>
              <h1 className="truncate text-xl font-extrabold leading-tight wallet-text-strong tracking-[-0.02em]">
                {app.name}
              </h1>
              <p className="mt-0.5 text-[11px] leading-4 wallet-muted">
                {screenTitle}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleBack}
            className="wallet-btn-danger shrink-0 px-3 py-1.5 text-[11px]"
          >
            Back
          </button>
        </div>

        <NoticeBanner notice={notice} />

        <div className={`min-h-0 flex-1 overflow-hidden ${contentClassName}`}>
          {screen === 'token' ? (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="wallet-card shrink-0 rounded-[22px] p-3">
                <div className="text-[10px] uppercase tracking-[0.18em] wallet-muted opacity-70">
                  Stablecoin
                </div>
                <div className="mt-1 text-base font-semibold wallet-text-strong">
                  Choose stablecoin.
                </div>
              </div>

              <div className="grid min-h-0 flex-1 gap-2">
                {merchantStablecoins.map((stablecoin) => {
                  const isSelected =
                    selectedStablecoin?.tokenId === stablecoin.tokenId;
                  return (
                    <button
                      key={stablecoin.tokenId}
                      type="button"
                      onClick={() =>
                        setSelectedStablecoinId(stablecoin.tokenId)
                      }
                      className={`wallet-card flex items-center justify-between rounded-[22px] px-3 py-3 text-left transition ${
                        isSelected
                          ? 'ring-2 ring-[var(--wallet-accent)] ring-offset-0'
                          : 'hover:brightness-[0.99]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold wallet-text-strong">
                          {stablecoin.name}
                        </div>
                        <div className="mt-0.5 text-[11px] uppercase tracking-[0.18em] wallet-muted opacity-70">
                          {stablecoin.symbol}
                        </div>
                      </div>
                      <div className="shrink-0 text-[11px] font-semibold wallet-muted">
                        {isSelected ? 'Selected' : 'Tap'}
                      </div>
                    </button>
                  );
                })}
              </div>

              <CopyActionButton
                label="Continue"
                onClick={handleContinueFromToken}
                variant="primary"
                disabled={!selectedStablecoin}
              />
            </div>
          ) : screen === 'amount' ? (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="wallet-card shrink-0 rounded-[22px] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.18em] wallet-muted opacity-70">
                      Receive
                    </div>
                    <div className="truncate text-base font-semibold wallet-text-strong">
                      {selectedStablecoin?.name ?? 'Stablecoin'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleChangeToken}
                    className="wallet-btn-secondary shrink-0 px-3 py-1.5 text-[11px]"
                  >
                    Change
                  </button>
                </div>
              </div>

              <MerchantAmountPad
                amount={amount}
                decimals={selectedDecimals}
                symbol={selectedStablecoin?.symbol ?? 'USD'}
                disabled={creatingRequest}
                onChange={setAmount}
                onClear={() => setAmount('')}
                className="flex-1 min-h-0"
                showHint={false}
              />

              <div className="wallet-card shrink-0 rounded-[22px] p-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="wallet-muted">
                    {draftQuote
                      ? `Quote ready · Expires ${stageExpiresIn}`
                      : quoteMessage?.text ?? 'Enter amount.'}
                  </span>
                  {draftQuote ? (
                    <span className="font-semibold wallet-text-strong">
                      {draftQuote.customerPaysDisplay}
                    </span>
                  ) : null}
                </div>

                <CopyActionButton
                  label={creatingRequest ? 'Creating...' : 'Create request'}
                  onClick={() => void handleCreatePaymentRequest()}
                  variant="primary"
                  disabled={creatingRequest || !draftQuote || draftQuoteExpired}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="wallet-card shrink-0 rounded-[22px] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.18em] wallet-muted opacity-70">
                      Customer pays
                    </div>
                    <div className="mt-1 text-[clamp(1.7rem,5.5vw,2.4rem)] font-black leading-none tracking-tight wallet-text-strong">
                      {paymentRequest?.customerPaysDisplay}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyPaymentUri}
                    disabled={!paymentRequest}
                    className={`wallet-btn-secondary shrink-0 px-3 py-1.5 text-[11px] ${
                      !paymentRequest ? 'cursor-not-allowed opacity-70' : ''
                    }`}
                  >
                    Copy URI
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.16em] wallet-muted opacity-70">
                      Receive
                    </div>
                    <div className="mt-1 font-semibold wallet-text-strong">
                      {paymentRequest?.merchantReceivesDisplay}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.16em] wallet-muted opacity-70">
                      Expires
                    </div>
                    <div className="mt-1 font-semibold wallet-text-strong">
                      {requestExpiresIn}
                    </div>
                  </div>
                </div>
              </div>

              <div className="wallet-card flex min-h-0 flex-1 flex-col rounded-[22px] p-3">
                <div className="mb-2 text-xs wallet-muted">
                  {autoSettleStatus === 'broadcasting'
                    ? 'Converting payment to stablecoins...'
                    : autoSettleStatus === 'settled'
                      ? autoSettleNote ?? 'Converted to stablecoins.'
                      : autoSettleStatus === 'error'
                        ? autoSettleNote ?? 'Auto-settle stopped.'
                        : autoSettleEnabled
                          ? autoSettleNote ??
                            'Watching for the BCH payment to arrive.'
                          : 'Any BCH wallet can scan this request.'}
                </div>
                <div className="mx-auto flex w-full max-w-[15.5rem] flex-1 items-center justify-center rounded-[20px] border border-[rgba(0,0,0,0.08)] bg-white p-2 shadow-sm">
                  <QRCodeSVG
                    value={paymentRequest?.paymentUri ?? ''}
                    size={REQUEST_QR_SIZE}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="H"
                    marginSize={1}
                    imageSettings={{
                      src: '/assets/images/OPTNUIkeyline2.png',
                      height: 32,
                      width: 32,
                      excavate: true,
                    }}
                  />
                </div>

                {requestExpired ? (
                  <div className="mt-2 rounded-xl border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-3 py-2 text-xs wallet-text-strong">
                    This request expired.
                  </div>
                ) : null}
              </div>

              <div className="grid shrink-0 grid-cols-2 gap-2">
                <CopyActionButton
                  label="Copy details"
                  onClick={() => void handleCopyPaymentDetails()}
                  compact
                />
                <CopyActionButton
                  label="Share"
                  onClick={() => void handleSharePaymentRequest()}
                  compact
                />
                <CopyActionButton
                  label={autoSettleEnabled ? 'Stop auto-settle' : 'Auto-settle'}
                  onClick={handleToggleAutoSettle}
                  variant={autoSettleEnabled ? 'secondary' : 'primary'}
                  compact
                />
                <CopyActionButton
                  label="New"
                  onClick={handleNewPayment}
                  variant="primary"
                  compact
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </WalletScreen>
  );
}

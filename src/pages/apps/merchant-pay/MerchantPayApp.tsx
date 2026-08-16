import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import type { AddonSDK } from '../../../services/AddonsSDK';
import { useAddonI18n } from '../../../i18n/useAddonI18n';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import type { RootState } from '../../../state/store';
import WalletScreen from '../../../components/ui/WalletScreen';
import { getReturnPath } from '../../../utils/navigation';
import {
  CAULDRON_NATIVE_BCH,
  CauldronApiClient,
  fetchNormalizedCauldronPools,
  planAggregatedTradeForTargetDemand,
  type CauldronPool,
} from '../../../services/cauldron';
import { parseDecimalToAtomic } from '../../../services/cauldron/amount';
import { formatAtomicTokenAmount } from '../../../utils/tokenPresentation';
import { useSmoothResetTransition } from '../shared/useSmoothResetTransition';
import MerchantAmountPad from './MerchantAmountPad';
import { QrStreamDisplay } from '../../../components/qr/QrStreamDisplay';
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
import {
  findMerchantPaymentObservation,
  type MerchantPaymentMonitorStatus,
  type MerchantPaymentObservation,
} from './merchantPaymentMonitoring';

type MerchantPayAppProps = {
  sdk: AddonSDK;
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

type QuoteMessageTone = 'muted' | 'warning' | 'danger';

type QuoteMessage = {
  tone: QuoteMessageTone;
  key: string;
  fallback: string;
  values?: Record<string, string | number>;
} | null;

type Notice = {
  kind: 'success' | 'warning' | 'error';
  message: string;
} | null;

type MerchantPaymentMonitor = {
  status: MerchantPaymentMonitorStatus;
  txid?: string;
  height?: number;
  lastCheckedAt?: number;
  message?: string;
};

type MerchantPayScreen = 'token' | 'amount' | 'request';
const REQUEST_TTL_MS = 120_000;
const QUOTE_PROTECTION_BPS = 100n;
const NOTICE_AUTO_DISMISS_MS = 4200;
const PAYMENT_MONITOR_INTERVAL_MS = 5000;

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

function formatCountdownLabel(
  msRemaining: number,
  expiredLabel = 'Expired'
): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return expiredLabel;
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

type MerchantPayTranslator = (
  key: string,
  fallback: string,
  values?: Record<string, string | number>
) => string;

function localizeMerchantPayError(
  error: unknown,
  translate: MerchantPayTranslator
): string {
  const message = error instanceof Error ? error.message : '';
  const knownErrors: Record<string, [string, string]> = {
    'Unable to read wallet addresses.': [
      'module.createRequestError',
      'Unable to create the payment request.',
    ],
    'No wallet address is available.': [
      'module.createRequestError',
      'Unable to create the payment request.',
    ],
    'Unable to read the merchant request address.': [
      'module.createRequestError',
      'Unable to create the payment request.',
    ],
    'The merchant quote has expired. Enter the amount again.': [
      'module.quoteExpired',
      'This quote expired. Enter the amount again.',
    ],
    'No Cauldron liquidity route is available.': [
      'module.noLiquidity',
      'No liquidity.',
    ],
    'The requested amount is no longer available from the current Cauldron liquidity.': [
      'module.notEnoughLiquidity',
      'Not enough liquidity. Try a smaller amount.',
    ],
  };
  const localized = message ? knownErrors[message] : undefined;
  return localized
    ? translate(localized[0], localized[1])
    : message || translate('module.createRequestError', 'Unable to create the payment request.');
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
  const { locale, t: addonT } = useAddonI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const backTarget = getReturnPath(location, '/apps');
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
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
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [poolLoadError, setPoolLoadError] = useState<string | null>(null);
  const [draftQuote, setDraftQuote] = useState<MerchantQuotePreview | null>(
    null
  );
  const [screen, setScreen] = useState<MerchantPayScreen>('token');
  const [quoteMessage, setQuoteMessage] = useState<QuoteMessage>({
    tone: 'muted',
    key: 'module.enterAmount',
    fallback: 'Enter amount.',
  });
  const [paymentRequest, setPaymentRequest] =
    useState<MerchantPaymentRequest | null>(null);
  const [paymentMonitor, setPaymentMonitor] =
    useState<MerchantPaymentMonitor | null>(null);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

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
    setPaymentRequest(null);
    setPaymentMonitor(null);
    setQrModalOpen(false);
    setPoolLoadError(null);
    setQuoteMessage({
      tone: 'muted',
      key: 'module.enterAmount',
      fallback: 'Enter amount.',
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
    setPaymentMonitor(null);
    setNotice(null);
  }, [amount, selectedStablecoinId]);

  useEffect(() => {
    if (poolLoadError) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'danger',
        key: 'module.poolLoadError',
        fallback: 'Unable to load merchant pools right now. Try again in a moment.',
      });
      return;
    }

    if (!selectedStablecoin) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'muted',
        key: 'module.chooseStablecoin',
        fallback: 'Choose stablecoin.',
      });
      return;
    }

    if (!amount.trim()) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'muted',
        key: 'module.enterAmount',
        fallback: 'Enter amount.',
      });
      return;
    }

    if (selectedAmountAtomic == null || selectedAmountAtomic <= 0n) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'warning',
        key: 'module.invalidAmount',
        fallback: 'Enter a valid amount.',
      });
      return;
    }

    if (poolsLoading) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'muted',
        key: 'module.loadingPools',
        fallback: 'Loading pools…',
      });
      return;
    }

    if (stablecoinPools.length === 0) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'warning',
        key: 'module.noLiquidity',
        fallback: 'No liquidity.',
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
      setQuoteMessage({
        tone: 'warning',
        key: 'module.notEnoughLiquidity',
        fallback: 'Not enough liquidity. Try a smaller amount.',
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
      trades: planned.trades,
    });
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

  useEffect(() => {
    if (!paymentRequest) {
      setPaymentMonitor(null);
      return undefined;
    }

    let cancelled = false;
    let inFlight = false;
    let terminal = false;
    let lastObservation: MerchantPaymentObservation | null = null;

    const poll = async () => {
      if (cancelled || inFlight || terminal) return;

      if (!lastObservation && paymentRequest.expiresAt <= Date.now()) {
        setPaymentMonitor({ status: 'expired', lastCheckedAt: Date.now() });
        terminal = true;
        return;
      }

      inFlight = true;
      try {
        const utxos = await sdk.utxos.listForAddress(
          paymentRequest.merchantAddress
        );
        if (cancelled) return;

        const observation = findMerchantPaymentObservation({
          utxos,
          baselineOutpoints: paymentRequest.merchantAddressBaselineOutpoints,
          proposal: paymentRequest.proposal,
        });
        const checkedAt = Date.now();

        if (observation) {
          lastObservation = observation;
          setPaymentMonitor({
            status: observation.status,
            txid: observation.txid,
            height: observation.height,
            lastCheckedAt: checkedAt,
          });
          if (observation.status === 'confirmed') terminal = true;
          return;
        }

        if (lastObservation) {
          setPaymentMonitor({
            status: lastObservation.status,
            txid: lastObservation.txid,
            height: lastObservation.height,
            lastCheckedAt: checkedAt,
          });
          return;
        }

        if (paymentRequest.expiresAt <= checkedAt) {
          setPaymentMonitor({ status: 'expired', lastCheckedAt: checkedAt });
          terminal = true;
        } else {
          setPaymentMonitor({
            status: 'awaiting-buyer',
            lastCheckedAt: checkedAt,
          });
        }
      } catch (error) {
        if (cancelled) return;
        setPaymentMonitor({
          status: 'error',
          lastCheckedAt: Date.now(),
          message: addonT(
            'module.monitoringAddressError',
            'Unable to check the merchant address.'
          ),
        });
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const intervalId = window.setInterval(
      () => void poll(),
      PAYMENT_MONITOR_INTERVAL_MS
    );
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [paymentRequest, sdk]);

  useEffect(() => {
    if (!qrModalOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQrModalOpen(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [qrModalOpen]);

  const stageExpiresIn = draftQuote
    ? formatCountdownLabel(
        draftQuote.expiresAt - nowMs,
        addonT('module.expired', 'Expired')
      )
    : null;
  const requestExpiresIn = paymentRequest
    ? formatCountdownLabel(
        paymentRequest.expiresAt - nowMs,
        addonT('module.expired', 'Expired')
      )
    : null;
  const requestExpired =
    paymentRequest != null && paymentRequest.expiresAt <= nowMs;
  const draftQuoteExpired = draftQuote != null && draftQuote.expiresAt <= nowMs;
  const screenTitle =
    screen === 'token'
      ? addonT('module.stablecoin', 'Stablecoin')
      : screen === 'amount'
        ? addonT('module.amount', 'Amount')
        : addonT('module.createRequest', 'Request');
  const displayedPaymentMonitorStatus: MerchantPaymentMonitorStatus =
    paymentMonitor?.status ?? (requestExpired ? 'expired' : 'awaiting-buyer');
  const paymentMonitorCopy =
    displayedPaymentMonitorStatus === 'confirmed'
      ? {
          title: addonT('module.paymentConfirmedTitle', 'Payment confirmed'),
          message: addonT(
            'module.paymentConfirmedMessage',
            'The exact stablecoin output is confirmed at the merchant address.'
          ),
        }
      : displayedPaymentMonitorStatus === 'pending'
        ? {
            title: addonT(
              'module.paymentPendingTitle',
              'Payment seen · pending'
            ),
            message: addonT(
              'module.paymentPendingMessage',
              'The exact stablecoin output is in the mempool. Wait for confirmation before completing the sale.'
            ),
          }
        : displayedPaymentMonitorStatus === 'expired'
          ? {
              title: addonT('module.requestExpiredTitle', 'Request expired'),
              message: addonT(
                'module.requestExpiredMessage',
                'This proposal is no longer valid for a new buyer transaction.'
              ),
            }
          : displayedPaymentMonitorStatus === 'error'
            ? {
                title: addonT(
                  'module.monitoringUnavailableTitle',
                  'Monitoring unavailable'
                ),
                message: addonT(
                  'module.monitoringUnavailableMessage',
                  'OPTN will retry checking the merchant address automatically.'
                ),
              }
            : {
                title: addonT('module.waitingBuyerTitle', 'Waiting for buyer'),
                message: addonT(
                  'module.waitingBuyerMessage',
                  'No matching stablecoin output has been detected yet.'
                ),
              };

  const handleBack = () => {
    if (screen === 'request') {
      setPaymentRequest(null);
      setNotice(null);
      setQrModalOpen(false);
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

      if (!selectedStablecoin) {
        throw new Error(addonT('module.chooseStablecoinFirst', 'Choose a stablecoin first.'));
      }

      if (!draftQuote) {
        throw new Error(addonT('module.enterAmountFirst', 'Enter an amount first.'));
      }

      if (draftQuoteExpired) {
        throw new Error(
          addonT('module.quoteExpired', 'This quote expired. Enter the amount again.')
        );
      }

      if (selectedAmountAtomic == null || selectedAmountAtomic <= 0n) {
        throw new Error(addonT('module.invalidAmount', 'Enter a valid amount.'));
      }

      const createdRequest = await buildMerchantPaymentRequest({
        sdk,
        currentNetwork,
        draftQuote,
        selectedStablecoin,
        locale,
        translate: addonT,
      });

      setQrModalOpen(true);
      setPaymentRequest(createdRequest);
      setScreen('request');
    } catch (error) {
      setNotice({
        kind: 'error',
        message: localizeMerchantPayError(error, addonT),
      });
    } finally {
      setCreatingRequest(false);
    }
  };

  const handleCopyPaymentDetails = async () => {
    if (!paymentRequest) return;
    try {
      await copyTextToClipboard(paymentRequest.detailsText);
      setNotice({
        kind: 'success',
        message: addonT('module.paymentDetailsCopied', 'Payment details copied.'),
      });
    } catch {
      setNotice({
        kind: 'error',
        message: addonT(
          'module.copyError',
          'Unable to copy payment details right now.'
        ),
      });
    }
  };

  const handleSharePaymentRequest = async () => {
    if (!paymentRequest) return;

    const shareText = paymentRequest.detailsText;

    if (navigator.share) {
      try {
        await navigator.share({
          title: addonT('module.shareTitle', 'Merchant BCH payment request'),
          text: shareText,
        });
        setNotice({
          kind: 'success',
          message: addonT('module.shareSheetOpened', 'Share sheet opened.'),
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
        message: addonT(
          'module.shareUnavailableCopied',
          'Share is unavailable here, so the proposal details were copied.'
        ),
      });
    } catch {
      setNotice({
        kind: 'error',
        message: addonT(
          'module.shareCopyError',
          'Unable to share or copy right now.'
        ),
      });
    }
  };

  const handleNewPayment = () => {
    setDraftQuote(null);
    setPaymentRequest(null);
    setPaymentMonitor(null);
    setQrModalOpen(false);
    setNotice(null);
    setAmount('');
    setQuoteMessage({
      tone: 'muted',
      key: 'module.enterAmount',
      fallback: 'Enter amount.',
    });
    setScreen('amount');
  };

  return (
    <>
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
                  {addonT('module.title', 'Merchant Pay')}
                </div>
                <h1 className="truncate text-xl font-extrabold leading-tight wallet-text-strong tracking-[-0.02em]">
                  {addonT('module.title', app.name || 'Merchant Pay')}
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
              {addonT('common.back', 'Back')}
            </button>
          </div>

          <NoticeBanner notice={notice} />

          <div className={`min-h-0 flex-1 overflow-hidden ${contentClassName}`}>
            {screen === 'token' ? (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div className="wallet-card shrink-0 rounded-[22px] p-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] wallet-muted opacity-70">
                    {addonT('module.stablecoin', 'Stablecoin')}
                  </div>
                  <div className="mt-1 text-base font-semibold wallet-text-strong">
                    {addonT('module.chooseStablecoin', 'Choose stablecoin.')}
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
                          {isSelected
                            ? addonT('module.selected', 'Selected')
                            : addonT('module.tap', 'Tap')}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <CopyActionButton
                  label={addonT('module.continue', 'Continue')}
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
                        {addonT('module.receive', 'Receive')}
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
                      {addonT('module.change', 'Change')}
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
                        ? addonT('module.quoteReady', 'Quote ready · Expires {expires}', {
                            expires: stageExpiresIn ?? addonT('module.expired', 'Expired'),
                          })
                        : quoteMessage
                          ? addonT(
                              quoteMessage.key,
                              quoteMessage.fallback,
                              quoteMessage.values
                            )
                          : addonT('module.enterAmount', 'Enter amount.')}
                    </span>
                    {draftQuote ? (
                      <span className="font-semibold wallet-text-strong">
                        {draftQuote.customerPaysDisplay}
                      </span>
                    ) : null}
                  </div>

                  <CopyActionButton
                    label={
                      creatingRequest
                        ? addonT('module.creating', 'Creating…')
                        : addonT('module.createRequest', 'Create request')
                    }
                    onClick={() => void handleCreatePaymentRequest()}
                    variant="primary"
                    disabled={
                      creatingRequest || !draftQuote || draftQuoteExpired
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div className="wallet-card shrink-0 rounded-[22px] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.18em] wallet-muted opacity-70">
                        {addonT('module.customerPays', 'Customer pays')}
                      </div>
                      <div className="mt-1 text-[clamp(1.7rem,5.5vw,2.4rem)] font-black leading-none tracking-tight wallet-text-strong">
                        {paymentRequest?.customerPaysDisplay}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCopyPaymentDetails()}
                      disabled={!paymentRequest}
                      className={`wallet-btn-secondary shrink-0 px-3 py-1.5 text-[11px] ${
                        !paymentRequest ? 'cursor-not-allowed opacity-70' : ''
                      }`}
                    >
                      {addonT('module.copyDetails', 'Copy details')}
                    </button>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] wallet-muted opacity-70">
                        {addonT('module.receive', 'Receive')}
                      </div>
                      <div className="mt-1 font-semibold wallet-text-strong">
                        {paymentRequest?.merchantReceivesDisplay}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] wallet-muted opacity-70">
                        {addonT('module.expires', 'Expires')}
                      </div>
                      <div className="mt-1 font-semibold wallet-text-strong">
                        {requestExpiresIn}
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  className={`rounded-[22px] border px-3 py-2.5 text-xs ${
                    displayedPaymentMonitorStatus === 'confirmed'
                      ? 'border-emerald-400/50 bg-emerald-400/10'
                      : displayedPaymentMonitorStatus === 'pending'
                        ? 'border-sky-400/50 bg-sky-400/10'
                        : displayedPaymentMonitorStatus === 'error' ||
                            displayedPaymentMonitorStatus === 'expired'
                          ? 'border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)]'
                          : 'border-[var(--wallet-border)] bg-[var(--wallet-surface)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold wallet-text-strong">
                      {paymentMonitorCopy.title}
                    </span>
                    {paymentMonitor?.txid ? (
                      <span className="font-mono text-[10px] wallet-muted">
                        {paymentMonitor.txid.slice(0, 8)}…
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 wallet-muted">
                    {paymentMonitorCopy.message}
                  </div>
                </div>

                <div className="wallet-card shrink-0 rounded-[22px] p-3">
                  <div className="mb-2 text-xs wallet-muted">
                    {addonT(
                      'module.scanProposalDescription',
                      'Scan this transaction proposal with OPTN Wallet. The merchant has prepared the Cauldron LP inputs; the buyer adds BCH inputs and change, signs, and broadcasts one transaction that delivers {symbol} directly to the merchant.',
                      { symbol: paymentRequest?.stablecoin.symbol ?? 'PUSD' }
                    )}
                  </div>
                  <CopyActionButton
                    label={addonT('module.showQr', 'Show QR code')}
                    onClick={() => setQrModalOpen(true)}
                    variant="primary"
                    disabled={
                      !paymentRequest?.proposalPayload || requestExpired
                    }
                  />

                  {requestExpired ? (
                    <div className="mt-2 rounded-xl border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-3 py-2 text-xs wallet-text-strong">
                      {addonT('module.requestExpired', 'This request expired.')}
                    </div>
                  ) : null}
                </div>

                <div className="grid shrink-0 grid-cols-3 gap-2">
                  <CopyActionButton
                    label={addonT('module.copyDetails', 'Copy details')}
                    onClick={() => void handleCopyPaymentDetails()}
                    compact
                  />
                  <CopyActionButton
                    label={addonT('module.share', 'Share')}
                    onClick={() => void handleSharePaymentRequest()}
                    compact
                  />
                  <CopyActionButton
                    label={addonT('module.new', 'New')}
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

      {screen === 'request' &&
      qrModalOpen &&
      paymentRequest?.proposalPayload ? (
        <div
          className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="merchant-pay-qr-title"
          onClick={() => setQrModalOpen(false)}
        >
          <div
            className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[28rem] flex-col overflow-hidden rounded-[26px] bg-[var(--wallet-surface)] p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 px-1 pb-2">
              <div className="min-w-0">
                <h2
                  id="merchant-pay-qr-title"
                  className="text-base font-bold wallet-text-strong"
                >
                  {addonT(
                    'module.scanTransactionProposal',
                    'Scan transaction proposal'
                  )}
                </h2>
                <p className="mt-1 text-xs wallet-muted">
                  {addonT(
                    'module.buyerScansQr',
                    'Buyer scans this QR in OPTN Wallet.'
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setQrModalOpen(false)}
                className="wallet-btn-secondary shrink-0 px-3 py-1.5 text-[11px]"
              >
                {addonT('module.close', 'Close')}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto rounded-[20px] bg-white p-2">
              <div className="mx-auto w-full max-w-[24rem]">
                <QrStreamDisplay
                  payload={paymentRequest.proposalPayload}
                  blockLength={360}
                  framesPerSecond={18}
                />
              </div>
            </div>

            <div className="pt-2">
              <CopyActionButton
                label={addonT('module.copyDetails', 'Copy details')}
                onClick={() => void handleCopyPaymentDetails()}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { QRCodeSVG } from 'qrcode.react';
import { FaBitcoin, FaDollarSign, FaUser } from 'react-icons/fa';
import type { ReactNode } from 'react';

import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import type { AddonSDK } from '../../../services/AddonsSDK';
import { useAddonI18n } from '../../../i18n/useAddonI18n';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import { selectMerchantPayDefaultConversionBps } from '../../../state/slices/preferencesSlice';
import type { RootState } from '../../../state/store';
import WalletScreen from '../../../components/ui/WalletScreen';
import { QrStreamDisplay } from '../../../components/qr/QrStreamDisplay';
import { getReturnPath } from '../../../utils/navigation';
import {
  CauldronApiClient,
  fetchNormalizedCauldronPools,
  type CauldronPool,
} from '../../../services/cauldron';
import { fetchCurrentLiquidityPoolsFromChain } from '../cauldron/preflight';
import { parseDecimalToAtomic } from '../../../services/cauldron/amount';
import { formatAtomicTokenAmount } from '../../../utils/tokenPresentation';
import { shortenAddress } from '../../../utils/shortenHash';
import {
  buildTxUrl,
  DEFAULT_EXPLORER_ID,
} from '../../../utils/servers/explorers';
import { useSmoothResetTransition } from '../shared/useSmoothResetTransition';
import MerchantAmountPad from './MerchantAmountPad';
import {
  buildMerchantPaymentRequest,
  planMerchantTargetPayment,
  type MerchantPaymentRequest,
  type MerchantQuotePreview,
} from './merchantPayRequest';
import {
  getDefaultMerchantStablecoin,
  getMerchantStablecoins,
  isMerchantStablecoin,
  type MerchantStablecoin,
} from './merchantStablecoins';
import {
  findMerchantPaymentObservation,
  type MerchantPaymentMonitorStatus,
  type MerchantPaymentObservation,
} from './merchantPaymentMonitoring';
import { copyToClipboard } from '../../../utils/clipboard';

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

type MerchantPayScreen = 'amount' | 'request';
type SplitAmountDisplay = 'source' | 'target';
const REQUEST_TTL_MS = 120_000;
const QUOTE_PROTECTION_BPS = 100n;
const NOTICE_AUTO_DISMISS_MS = 4200;
// QRCodeSVG throws a RangeError instead of returning a renderable error when
// the payload exceeds the QR capacity. Keep the UI fail-closed until the
// versioned compressed transport is available.
const MAX_INLINE_MERCHANT_QR_CHARS = 2800;
const PAYMENT_MONITOR_INTERVAL_MS = 2000;
const PAYMENT_SUCCESS_RETURN_DELAY_MS = 2000;

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

function formatMerchantAssetAmount(
  amount: bigint,
  asset: 'bch' | 'token',
  stablecoin: MerchantStablecoin
): string {
  return asset === 'bch'
    ? formatCompactBchAmount(amount)
    : `${formatFixedAtomicAmount(amount, stablecoin.decimals)} ${stablecoin.symbol}`;
}

function formatConversionPercent(conversionBps: bigint): string {
  const whole = conversionBps / 100n;
  const fraction = (conversionBps % 100n).toString().padStart(2, '0');
  if (fraction === '00') return `${whole}%`;
  return `${whole}.${fraction.endsWith('0') ? fraction[0] : fraction}%`;
}

function merchantPaymentRequiresPools(
  merchantAsset: 'bch' | 'token',
  incomingAsset: 'bch' | 'token',
  conversionBps: bigint
): boolean {
  // BCH is the merchant-facing default customer payment asset. A PUSD
  // target needs a BCH-equivalent quote even when the merchant keeps the
  // full payment in BCH; a BCH target only needs pools when some BCH is
  // converted to PUSD.
  if (incomingAsset === 'bch') {
    return merchantAsset === 'token' || conversionBps > 0n;
  }
  return merchantAsset !== incomingAsset;
}

function MerchantAssetIcon({
  asset,
  kind = 'asset',
  compact = false,
}: {
  asset: 'bch' | 'token';
  kind?: 'asset' | 'customer';
  compact?: boolean;
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${compact ? 'h-7 w-7 text-xs' : 'h-8 w-8 text-sm'} ${
        kind === 'customer'
          ? 'bg-sky-400 text-sky-950'
          : asset === 'bch'
            ? 'bg-orange-400 text-orange-950'
            : 'bg-emerald-400 text-emerald-950'
      }`}
      aria-hidden="true"
    >
      {kind === 'customer' ? (
        <FaUser />
      ) : asset === 'bch' ? (
        <FaBitcoin />
      ) : (
        <FaDollarSign />
      )}
    </span>
  );
}

function MerchantPaymentSummaryRow({
  icon,
  label,
  value,
  onClick,
  ariaLabel,
  compact = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  onClick?: () => void;
  ariaLabel?: string;
  compact?: boolean;
}) {
  const className = `flex w-full items-center rounded-2xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] text-left ${compact ? 'gap-2 px-2.5 py-1.5' : 'gap-3 px-3 py-2'}`;
  const content = (
    <>
      {icon}
      <span
        className={`min-w-0 flex-1 wallet-text-strong ${compact ? 'text-xs' : 'text-sm'}`}
      >
        {label}
      </span>
      <span
        className={`max-w-[62%] break-words text-right font-semibold wallet-text-strong ${compact ? 'text-xs' : 'text-sm'}`}
      >
        {value}
      </span>
    </>
  );

  return onClick ? (
    <button
      type="button"
      className={`${className} transition hover:border-[var(--wallet-accent)] active:scale-[0.99]`}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
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
    'Current Cauldron liquidity is unavailable. Refresh the quote and try again.':
      [
        'module.poolLoadError',
        'Current Cauldron liquidity is unavailable. Refresh the quote and try again.',
      ],
    'The requested amount is no longer available from the current Cauldron liquidity.':
      [
        'module.notEnoughLiquidity',
        'Not enough liquidity. Try a smaller amount.',
      ],
  };
  const localized = message ? knownErrors[message] : undefined;
  return localized
    ? translate(localized[0], localized[1])
    : message ||
        translate(
          'module.createRequestError',
          'Unable to create the payment request.'
        );
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (await copyToClipboard(text)) return;

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
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
      className={`${className} rounded-2xl px-3 py-2 text-xs shadow-lg`}
    >
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
  className = '',
  testId,
}: {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`${
        variant === 'primary' ? 'wallet-btn-primary' : 'wallet-btn-secondary'
      } w-full ${compact ? 'px-3 py-2 text-[12px] leading-tight' : 'px-4 py-3.5'} ${className} ${
        disabled ? 'cursor-not-allowed opacity-70' : ''
      }`}
    >
      {label}
    </button>
  );
}

function MerchantStatusIcon({
  status,
}: {
  status: MerchantPaymentMonitorStatus;
}) {
  if (status === 'pending') {
    return (
      <span
        className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-emerald-300/40"
        aria-hidden="true"
      >
        <span className="h-6 w-6 animate-spin rounded-full border-[3px] border-emerald-300 border-t-transparent" />
      </span>
    );
  }

  if (status === 'confirmed') {
    return (
      <span
        className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400 text-xl font-black text-emerald-950"
        aria-hidden="true"
      >
        ✓
      </span>
    );
  }

  if (status === 'expired') {
    return (
      <span
        className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-slate-200/80 text-2xl text-slate-100"
        aria-hidden="true"
      >
        ◷
      </span>
    );
  }

  return (
    <span
      className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-red-400 text-2xl font-black text-red-300"
      aria-hidden="true"
    >
      !
    </span>
  );
}

function MerchantPaymentStatusCard({
  status,
  paymentRequest,
  paymentMonitor,
  copy,
  explorerUrl,
}: {
  status: MerchantPaymentMonitorStatus;
  paymentRequest: MerchantPaymentRequest;
  paymentMonitor: MerchantPaymentMonitor | null;
  copy: { title: string; message: string };
  explorerUrl: string | null;
}) {
  const isConfirmed = status === 'confirmed';
  const confirmations = isConfirmed ? 1 : 0;

  return (
    <div
      className={`rounded-[22px] border px-3 py-3 ${
        isConfirmed
          ? 'border-emerald-400/50 bg-emerald-400/10'
          : 'border-sky-400/50 bg-sky-400/10'
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center text-center">
        <MerchantStatusIcon status={status} />
        <div className="mt-3 text-sm font-bold wallet-text-strong">
          {copy.title}
        </div>
        <div className="mt-1 text-xs wallet-muted">{copy.message}</div>
      </div>
      <div className="mt-3 space-y-2 border-t border-[var(--wallet-border)] pt-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="wallet-muted">Amount received</span>
          <span className="font-semibold wallet-text-strong">
            {paymentRequest.merchantReceivesDisplay}
          </span>
        </div>
        {paymentMonitor?.txid ? (
          <div className="flex items-center justify-between gap-3">
            <span className="wallet-muted">Transaction ID</span>
            <span className="font-mono font-semibold wallet-text-strong">
              {paymentMonitor.txid.slice(0, 8)}…{paymentMonitor.txid.slice(-4)}
            </span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span className="wallet-muted">Confirmations</span>
          <span className="font-semibold wallet-text-strong">
            {confirmations}
            {isConfirmed ? '' : ' (0 pending)'}
          </span>
        </div>
      </div>
      {explorerUrl ? (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="wallet-btn-secondary mt-3 block w-full px-3 py-2 text-center text-xs"
        >
          View on explorer ↗
        </a>
      ) : null}
    </div>
  );
}

function MerchantPaymentDetails({
  paymentRequest,
  requestExpiresIn,
  onCopy,
}: {
  paymentRequest: MerchantPaymentRequest;
  requestExpiresIn: string | null;
  onCopy: () => void;
}) {
  return (
    <details className="wallet-card shrink-0 rounded-[22px] p-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold wallet-text-strong">
        <span>Payment details</span>
        <span className="text-lg font-normal wallet-muted" aria-hidden="true">
          ›
        </span>
      </summary>
      <div className="mt-3 space-y-2 border-t border-[var(--wallet-border)] pt-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="wallet-muted">Customer pays</span>
          <span className="text-right font-medium wallet-text-strong">
            {paymentRequest.customerPaysDisplay}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="wallet-muted">Conversion</span>
          <span className="font-medium wallet-text-strong">
            {formatConversionPercent(paymentRequest.conversionBps)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="wallet-muted">Merchant receives</span>
          <span className="text-right font-medium wallet-text-strong">
            {paymentRequest.merchantReceivesDisplay}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="wallet-muted">Merchant address</span>
          <span className="max-w-[64%] break-all text-right font-medium wallet-text-strong">
            {shortenAddress(paymentRequest.merchantAddress)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="wallet-muted">Exchange route</span>
          <span className="font-medium wallet-text-strong">
            {paymentRequest.routePoolCount > 0 ? 'Cauldron' : 'Direct'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="wallet-muted">LP inputs</span>
          <span className="font-medium wallet-text-strong">
            {paymentRequest.routePoolCount}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="wallet-muted">Quote expires in</span>
          <span className="font-medium wallet-text-strong">
            {requestExpiresIn ?? '—'}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="wallet-btn-secondary mt-1 w-full px-3 py-2 text-xs"
        >
          Copy payment details
        </button>
      </div>
    </details>
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
  const defaultConversionBps = useSelector((state: RootState) =>
    selectMerchantPayDefaultConversionBps(state)
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
  const [merchantAsset, setMerchantAsset] = useState<'bch' | 'token'>('token');
  const [incomingAsset, setIncomingAsset] = useState<'bch' | 'token'>('bch');
  const [conversionBps, setConversionBps] = useState<bigint>(() =>
    BigInt(defaultConversionBps)
  );
  const [splitDisplayMode, setSplitDisplayMode] = useState<{
    converted: SplitAmountDisplay;
    direct: SplitAmountDisplay;
  }>({ converted: 'target', direct: 'source' });
  const [stablecoinPools, setStablecoinPools] = useState<CauldronPool[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [poolLoadError, setPoolLoadError] = useState<string | null>(null);
  const [draftQuote, setDraftQuote] = useState<MerchantQuotePreview | null>(
    null
  );
  const [screen, setScreen] = useState<MerchantPayScreen>('amount');
  const [quoteMessage, setQuoteMessage] = useState<QuoteMessage>({
    tone: 'muted',
    key: 'module.enterAmount',
    fallback: 'Enter amount.',
  });
  const [paymentRequest, setPaymentRequest] =
    useState<MerchantPaymentRequest | null>(null);
  const [paymentMonitor, setPaymentMonitor] =
    useState<MerchantPaymentMonitor | null>(null);
  const [settlementSplitOpen, setSettlementSplitOpen] = useState(false);
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [requestPreparing, setRequestPreparing] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const preserveSuccessNoticeRef = useRef(false);
  const proposalQrText = useMemo(
    () =>
      paymentRequest?.proposalPayload
        ? new TextDecoder('utf-8', { fatal: true }).decode(
            paymentRequest.proposalPayload
          )
        : '',
    [paymentRequest?.proposalPayload]
  );

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

  const selectedDecimals =
    merchantAsset === 'bch' ? 8 : selectedStablecoin?.decimals ?? 2;
  const selectedAmountAtomic = useMemo(
    () => parseDecimalToAtomic(amount, selectedDecimals),
    [amount, selectedDecimals]
  );
  const requestAmountLabel = selectedAmountAtomic
    ? formatFixedAtomicAmount(selectedAmountAtomic, selectedDecimals)
    : formatFixedAtomicAmount(0n, selectedDecimals);

  const samePaymentAsset = incomingAsset === merchantAsset;
  const conversionTargetAsset: 'bch' | 'token' =
    incomingAsset === 'bch' ? 'token' : 'bch';
  const conversionLabel = formatConversionPercent(conversionBps);
  const conversionIsDirect = samePaymentAsset && conversionBps === 0n;
  const customerPaysDisplay = draftQuote?.customerPaysDisplay ?? '—';
  const routedSourceAtomic = draftQuote
    ? draftQuote.trades.reduce((total, trade) => total + trade.supply, 0n)
    : null;
  const routedTargetAtomic = draftQuote
    ? draftQuote.trades.reduce((total, trade) => total + trade.demand, 0n)
    : null;
  const convertedSourceAmountLabel =
    routedSourceAtomic != null && selectedStablecoin
      ? formatMerchantAssetAmount(
          routedSourceAtomic,
          incomingAsset,
          selectedStablecoin
        )
      : '—';
  const convertedTargetAmountLabel =
    routedTargetAtomic != null && selectedStablecoin
      ? formatMerchantAssetAmount(
          routedTargetAtomic,
          conversionTargetAsset,
          selectedStablecoin
        )
      : '—';
  const directSourceAmountLabel =
    draftQuote?.directIncomingAmountAtomic != null && selectedStablecoin
      ? formatMerchantAssetAmount(
          draftQuote.directIncomingAmountAtomic,
          incomingAsset,
          selectedStablecoin
        )
      : '—';
  const directTargetAmountLabel = (() => {
    if (!draftQuote || !selectedStablecoin) return '—';
    if (samePaymentAsset) {
      return formatMerchantAssetAmount(
        draftQuote.directIncomingAmountAtomic ?? 0n,
        merchantAsset,
        selectedStablecoin
      );
    }
    if (!routedSourceAtomic || !routedTargetAtomic) return '—';
    return formatMerchantAssetAmount(
      ((draftQuote.directIncomingAmountAtomic ?? 0n) * routedTargetAtomic) /
        routedSourceAtomic,
      merchantAsset,
      selectedStablecoin
    );
  })();
  const splitAssetLabel = (asset: 'bch' | 'token') =>
    asset === 'bch' ? 'BCH' : selectedStablecoin?.symbol ?? 'PUSD';
  const convertedDisplayAmount =
    splitDisplayMode.converted === 'source'
      ? convertedSourceAmountLabel
      : convertedTargetAmountLabel;
  const directDisplayAmount =
    splitDisplayMode.direct === 'source'
      ? directSourceAmountLabel
      : directTargetAmountLabel;
  const convertedSummaryLabel =
    splitDisplayMode.converted === 'target'
      ? `Converted to ${splitAssetLabel(conversionTargetAsset)}`
      : `Customer pays ${splitAssetLabel(incomingAsset)}`;
  const directSummaryLabel =
    splitDisplayMode.direct === 'source'
      ? `Paid directly as ${splitAssetLabel(incomingAsset)}`
      : `Equivalent in ${splitAssetLabel(merchantAsset)}`;

  useEffect(() => {
    const defaultStablecoin = getDefaultMerchantStablecoin(currentNetwork);
    setScreen('amount');
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
    setMerchantAsset('token');
    setIncomingAsset('bch');
    setConversionBps(BigInt(defaultConversionBps));
    setSplitDisplayMode({ converted: 'target', direct: 'source' });
    setDraftQuote(null);
    setPaymentRequest(null);
    setPaymentMonitor(null);
    setRequestPreparing(false);
    setPoolLoadError(null);
    setQuoteMessage({
      tone: 'muted',
      key: 'module.enterAmount',
      fallback: 'Enter amount.',
    });
  }, [currentNetwork, defaultConversionBps, merchantStablecoins]);

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

  // Warm the chain-derived LP outpoint cache while the merchant is entering
  // the amount. Request creation can then reuse the result instead of making
  // the merchant wait for a second index scan.
  useEffect(() => {
    if (!sdk.chain || stablecoinPools.length === 0) return;
    void fetchCurrentLiquidityPoolsFromChain({
      sdk,
      quotedPools: stablecoinPools,
    }).catch(() => undefined);
  }, [sdk, stablecoinPools]);

  useEffect(() => {
    setPaymentRequest(null);
    setPaymentMonitor(null);
    if (preserveSuccessNoticeRef.current) {
      preserveSuccessNoticeRef.current = false;
    } else {
      setNotice(null);
    }
  }, [
    amount,
    incomingAsset,
    merchantAsset,
    selectedStablecoinId,
    conversionBps,
  ]);

  useEffect(() => {
    const requiresRoute = merchantPaymentRequiresPools(
      merchantAsset,
      incomingAsset,
      conversionBps
    );

    if (poolLoadError && requiresRoute) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'danger',
        key: 'module.poolLoadError',
        fallback:
          'Unable to load merchant pools right now. Try again in a moment.',
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

    if (requiresRoute && poolsLoading) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'muted',
        key: 'module.loadingPools',
        fallback: 'Loading pools…',
      });
      return;
    }

    if (requiresRoute && stablecoinPools.length === 0) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'warning',
        key: 'module.noLiquidity',
        fallback: 'No liquidity.',
      });
      return;
    }

    const targetPlan = planMerchantTargetPayment({
      pools: stablecoinPools,
      merchantAsset,
      incomingAsset,
      merchantAmountAtomic: selectedAmountAtomic,
      conversionBps,
      stablecoinTokenId: selectedStablecoin.tokenId,
    });

    if (!targetPlan) {
      setDraftQuote(null);
      setQuoteMessage({
        tone: 'warning',
        key: 'module.notEnoughLiquidity',
        fallback: 'Not enough liquidity. Try a smaller amount.',
      });
      return;
    }

    const routeSummary = targetPlan.planned?.summary;
    const merchantBchAmount =
      incomingAsset === 'bch'
        ? targetPlan.directIncomingAmountAtomic
        : routeSummary?.demand ?? 0n;
    const merchantTokenAmount =
      incomingAsset === 'token'
        ? targetPlan.directIncomingAmountAtomic
        : routeSummary?.demand ?? 0n;
    const merchantParts = [
      merchantBchAmount > 0n ? formatCompactBchAmount(merchantBchAmount) : null,
      merchantTokenAmount > 0n
        ? `${formatFixedAtomicAmount(merchantTokenAmount, selectedStablecoin.decimals)} ${selectedStablecoin.symbol}`
        : null,
    ].filter((value): value is string => Boolean(value));
    const now = Date.now();
    setDraftQuote({
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      merchantReceivesAtomic: merchantTokenAmount,
      merchantReceivesDisplay: merchantParts.join(' + '),
      customerPaysSats:
        incomingAsset === 'bch' ? targetPlan.customerPaysAtomic : 0n,
      customerPaysDisplay: formatMerchantAssetAmount(
        targetPlan.customerPaysAtomic,
        incomingAsset,
        selectedStablecoin
      ),
      routePoolCount: targetPlan.planned?.trades.length ?? 0,
      quoteProtectionBps: QUOTE_PROTECTION_BPS,
      trades: targetPlan.planned?.trades ?? [],
      incomingAsset,
      customerPaysAtomic: targetPlan.customerPaysAtomic,
      conversionBps: targetPlan.conversionBps,
      directIncomingAmountAtomic: targetPlan.directIncomingAmountAtomic,
    });
    setQuoteMessage(null);
  }, [
    amount,
    conversionBps,
    incomingAsset,
    merchantAsset,
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
          // Merchant Pay is intentionally 0-conf for this internal launch:
          // an exact, new PUSD output at the merchant address is sufficient to
          // release the sale. Keep polling after a mempool observation so the
          // same request can visibly advance to confirmed later.
          terminal = observation.status === 'confirmed';
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
  }, [addonT, paymentRequest, sdk]);

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
    screen === 'amount'
      ? addonT('module.requestPayment', 'Request payment')
      : addonT('module.paymentRequest', 'Payment request');
  const displayedPaymentMonitorStatus: MerchantPaymentMonitorStatus =
    paymentMonitor?.status ?? (requestExpired ? 'expired' : 'awaiting-buyer');
  const merchantOutputSummary =
    paymentRequest?.merchantReceivesDisplay ?? 'the requested output';
  const paymentMonitorCopy =
    displayedPaymentMonitorStatus === 'confirmed'
      ? {
          title: addonT('module.paymentConfirmedTitle', 'Payment confirmed'),
          message: addonT(
            'module.paymentConfirmedMessage',
            'Received {amount} at the merchant address.',
            { amount: merchantOutputSummary }
          ),
        }
      : displayedPaymentMonitorStatus === 'pending'
        ? {
            title: addonT(
              'module.paymentPendingTitle',
              'Payment received · 0-conf'
            ),
            message: addonT(
              'module.paymentPendingMessage',
              'Received {amount}. Accepted at 0-conf; confirmation may follow.',
              { amount: merchantOutputSummary }
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
                  'Waiting for {amount}.',
                  { amount: merchantOutputSummary }
                ),
              };
  const paymentExplorerUrl =
    paymentMonitor?.txid &&
    (displayedPaymentMonitorStatus === 'pending' ||
      displayedPaymentMonitorStatus === 'confirmed')
      ? buildTxUrl(
          { kind: 'preset', id: DEFAULT_EXPLORER_ID },
          currentNetwork,
          paymentMonitor.txid
        )
      : null;
  const paymentDetected =
    displayedPaymentMonitorStatus === 'pending' ||
    displayedPaymentMonitorStatus === 'confirmed';
  const paymentRequestExpired =
    requestExpired || displayedPaymentMonitorStatus === 'expired';

  useEffect(() => {
    if (paymentDetected && qrOpen) setQrOpen(false);
  }, [paymentDetected, qrOpen]);

  const handleBack = () => {
    if (qrOpen) {
      setQrOpen(false);
      return;
    }

    if (screen === 'request') {
      setPaymentRequest(null);
      setPaymentMonitor(null);
      setNotice(null);
      setScreen('amount');
      return;
    }

    navigate(backTarget);
  };

  const handleNewPayment = useCallback((showSuccessNotice = false) => {
    setDraftQuote(null);
    setPaymentRequest(null);
    setPaymentMonitor(null);
    setQrOpen(false);
    setSettlementSplitOpen(false);
    setSplitDisplayMode({ converted: 'target', direct: 'source' });
    if (showSuccessNotice) {
      preserveSuccessNoticeRef.current = true;
      setNotice({
        kind: 'success',
        message: 'Payment received. Ready for a new payment.',
      });
    } else {
      setNotice(null);
    }
    setAmount('');
    setQuoteMessage({
      tone: 'muted',
      key: 'module.enterAmount',
      fallback: 'Enter amount.',
    });
    setScreen('amount');
  }, []);

  useEffect(() => {
    if (!paymentDetected || !paymentRequest) return undefined;

    // Keep the receipt visible long enough to acknowledge the payment, then
    // return the merchant to the amount keypad. The merchant app stays on its
    // own route; it must not fall through to the Cauldron composer.
    const timeoutId = window.setTimeout(() => {
      handleNewPayment(true);
    }, PAYMENT_SUCCESS_RETURN_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [handleNewPayment, paymentDetected, paymentRequest]);

  const handleCreatePaymentRequest = async () => {
    if (creatingRequest) return;

    try {
      setCreatingRequest(true);
      setRequestPreparing(true);
      setNotice(null);
      setQrOpen(false);
      setScreen('request');

      if (!selectedStablecoin) {
        throw new Error(
          addonT('module.chooseStablecoinFirst', 'Choose a stablecoin first.')
        );
      }

      if (!draftQuote) {
        throw new Error(
          addonT('module.enterAmountFirst', 'Enter an amount first.')
        );
      }

      if (draftQuoteExpired) {
        throw new Error(
          addonT(
            'module.quoteExpired',
            'This quote expired. Enter the amount again.'
          )
        );
      }

      if (selectedAmountAtomic == null || selectedAmountAtomic <= 0n) {
        throw new Error(
          addonT('module.invalidAmount', 'Enter a valid amount.')
        );
      }

      const createdRequest = await buildMerchantPaymentRequest({
        sdk,
        currentNetwork,
        draftQuote,
        selectedStablecoin,
        locale,
        translate: addonT,
      });

      setPaymentRequest(createdRequest);
      setScreen('request');
      setQrOpen(true);
    } catch (error) {
      setScreen('amount');
      setNotice({
        kind: 'error',
        message: localizeMerchantPayError(error, addonT),
      });
    } finally {
      setCreatingRequest(false);
      setRequestPreparing(false);
    }
  };

  const handleRefreshPaymentRequest = async () => {
    if (creatingRequest) return;

    try {
      setCreatingRequest(true);
      setRequestPreparing(true);
      setNotice(null);
      setQrOpen(false);
      setScreen('request');

      if (!selectedStablecoin || selectedAmountAtomic == null) {
        throw new Error(
          addonT('module.invalidAmount', 'Enter a valid amount.')
        );
      }

      const requiresRoute = merchantPaymentRequiresPools(
        merchantAsset,
        incomingAsset,
        conversionBps
      );
      const refreshedPools = requiresRoute
        ? await fetchNormalizedCauldronPools(
            currentNetwork,
            apiClient,
            selectedStablecoin.tokenId
          )
        : stablecoinPools;
      const targetPlan = planMerchantTargetPayment({
        pools: refreshedPools,
        merchantAsset,
        incomingAsset,
        merchantAmountAtomic: selectedAmountAtomic,
        conversionBps,
        stablecoinTokenId: selectedStablecoin.tokenId,
      });
      if (!targetPlan) {
        throw new Error(
          addonT(
            'module.notEnoughLiquidity',
            'Not enough liquidity. Try a smaller amount.'
          )
        );
      }

      const now = Date.now();
      const routeSummary = targetPlan.planned?.summary;
      const merchantBchAmount =
        incomingAsset === 'bch'
          ? targetPlan.directIncomingAmountAtomic
          : routeSummary?.demand ?? 0n;
      const merchantTokenAmount =
        incomingAsset === 'token'
          ? targetPlan.directIncomingAmountAtomic
          : routeSummary?.demand ?? 0n;
      const merchantParts = [
        merchantBchAmount > 0n
          ? formatCompactBchAmount(merchantBchAmount)
          : null,
        merchantTokenAmount > 0n
          ? `${formatFixedAtomicAmount(merchantTokenAmount, selectedStablecoin.decimals)} ${selectedStablecoin.symbol}`
          : null,
      ].filter((value): value is string => Boolean(value));
      const refreshedQuote: MerchantQuotePreview = {
        createdAt: now,
        expiresAt: now + REQUEST_TTL_MS,
        merchantReceivesAtomic: merchantTokenAmount,
        merchantReceivesDisplay: merchantParts.join(' + '),
        customerPaysSats:
          incomingAsset === 'bch' ? targetPlan.customerPaysAtomic : 0n,
        customerPaysDisplay: formatMerchantAssetAmount(
          targetPlan.customerPaysAtomic,
          incomingAsset,
          selectedStablecoin
        ),
        routePoolCount: targetPlan.planned?.trades.length ?? 0,
        quoteProtectionBps: QUOTE_PROTECTION_BPS,
        trades: targetPlan.planned?.trades ?? [],
        incomingAsset,
        customerPaysAtomic: targetPlan.customerPaysAtomic,
        conversionBps: targetPlan.conversionBps,
        directIncomingAmountAtomic: targetPlan.directIncomingAmountAtomic,
      };

      const refreshedRequest = await buildMerchantPaymentRequest({
        sdk,
        currentNetwork,
        draftQuote: refreshedQuote,
        selectedStablecoin,
        merchantAddress: paymentRequest?.merchantAddress,
        locale,
        translate: addonT,
      });
      setStablecoinPools(refreshedPools);
      setDraftQuote(refreshedQuote);
      setPaymentRequest(refreshedRequest);
      setPaymentMonitor(null);
      setScreen('request');
      setQrOpen(true);
    } catch (error) {
      setScreen('amount');
      setNotice({
        kind: 'error',
        message: localizeMerchantPayError(error, addonT),
      });
    } finally {
      setCreatingRequest(false);
      setRequestPreparing(false);
    }
  };

  const handleCopyPaymentDetails = async () => {
    if (!paymentRequest) return;
    try {
      await copyTextToClipboard(paymentRequest.detailsText);
      setNotice({
        kind: 'success',
        message: addonT(
          'module.paymentDetailsCopied',
          'Payment details copied.'
        ),
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

  const handleCopyProposal = async () => {
    if (!proposalQrText) return;
    try {
      await copyTextToClipboard(proposalQrText);
      setNotice({
        kind: 'success',
        message: addonT(
          'module.merchantProposalCopied',
          'Machine-readable merchant proposal copied. Paste it into OPTN Wallet.'
        ),
      });
    } catch {
      setNotice({
        kind: 'error',
        message: addonT(
          'module.copyError',
          'Unable to copy the merchant proposal right now.'
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

          <div
            className={`min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y pr-1 ${contentClassName}`}
          >
            {screen === 'amount' ? (
              <div className="flex min-h-full flex-col gap-2 pb-2">
                <div
                  className="wallet-card shrink-0 rounded-[18px] border border-emerald-400/40 p-2"
                  data-testid="merchant-receives-card"
                >
                  <div className="text-[15px] font-bold wallet-text-strong">
                    Merchant receives
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    {(['bch', 'token'] as const).map((asset) => (
                      <button
                        key={asset}
                        type="button"
                        onClick={() => {
                          setMerchantAsset(asset);
                          setAmount('');
                          setDraftQuote(null);
                          setSplitDisplayMode({
                            converted: 'target',
                            direct: 'source',
                          });
                        }}
                        className={`rounded-xl border px-3 py-1.5 text-sm font-semibold transition ${
                          merchantAsset === asset
                            ? 'border-emerald-300 bg-emerald-400 text-emerald-950'
                            : 'border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] wallet-text-strong'
                        }`}
                        data-testid={`merchant-target-asset-${asset}`}
                        disabled={creatingRequest}
                      >
                        {asset === 'bch'
                          ? 'BCH'
                          : selectedStablecoin?.symbol ?? 'PUSD'}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-1.5">
                    <div
                      className="min-w-0 break-words text-[clamp(2rem,8vw,2.75rem)] font-black leading-none tracking-tight wallet-text-strong"
                      data-testid="merchant-amount-display"
                      aria-live="polite"
                    >
                      {amount.trim() || '0'}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <span className="rounded-full border border-[var(--wallet-border)] px-2 py-0.5 text-[11px] font-semibold wallet-text-strong">
                        {merchantAsset === 'bch'
                          ? 'BCH'
                          : selectedStablecoin?.symbol ?? 'PUSD'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAmount('')}
                        className="rounded-full border border-[var(--wallet-border)] px-2 py-0.5 text-[10px] font-semibold wallet-text-strong transition"
                        disabled={creatingRequest}
                      >
                        {addonT('module.clear', 'Clear')}
                      </button>
                    </div>
                  </div>
                </div>

                <div
                  className="wallet-card shrink-0 rounded-[18px] border border-emerald-400/40 p-2"
                  data-testid="merchant-payment-options"
                >
                  <div className="text-[15px] font-bold wallet-text-strong">
                    Customer pays
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[10px] uppercase tracking-[0.14em] wallet-muted">
                        Estimated payment
                      </span>
                    </div>
                    <span
                      className="shrink-0 text-sm font-semibold wallet-text-strong"
                      data-testid="merchant-customer-payment-display"
                    >
                      {customerPaysDisplay}
                    </span>
                  </div>

                  <button
                    type="button"
                    className="mt-1.5 flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-1.5 text-left"
                    data-testid="merchant-settlement-toggle"
                    aria-expanded={settlementSplitOpen}
                    aria-controls="merchant-settlement-content"
                    onClick={() => setSettlementSplitOpen((open) => !open)}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-bold wallet-text-strong">
                        Optional conversion
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!settlementSplitOpen ? (
                        <span className="text-right text-[11px] font-semibold wallet-text-strong">
                          {conversionIsDirect
                            ? 'Direct'
                            : `${conversionLabel} ${splitAssetLabel(conversionTargetAsset)} · ${formatConversionPercent(10_000n - conversionBps)} ${splitAssetLabel(incomingAsset)}`}
                        </span>
                      ) : null}
                      <span
                        className={`text-lg leading-none wallet-text-strong transition-transform ${settlementSplitOpen ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      >
                        ⌄
                      </span>
                    </div>
                  </button>

                  {settlementSplitOpen ? (
                    <div id="merchant-settlement-content" className="mt-2.5">
                      {incomingAsset !== 'bch' && samePaymentAsset ? (
                        <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-2 text-xs wallet-muted">
                          The customer pays the merchant asset directly, so the
                          full requested amount is kept without an LP swap.
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex min-w-0 items-center gap-1.5 border-r border-[var(--wallet-border)] pr-2">
                              <MerchantAssetIcon
                                asset={conversionTargetAsset}
                                compact
                              />
                              <div className="min-w-0">
                                <div className="text-[10px] wallet-muted">
                                  Convert to{' '}
                                  {splitAssetLabel(conversionTargetAsset)}
                                </div>
                                <div className="text-base font-black wallet-text-strong">
                                  {conversionLabel}
                                </div>
                              </div>
                            </div>
                            <div className="flex min-w-0 items-center gap-1.5 pl-1">
                              <MerchantAssetIcon
                                asset={incomingAsset}
                                compact
                              />
                              <div className="min-w-0">
                                <div className="text-[10px] wallet-muted">
                                  Keep as {splitAssetLabel(incomingAsset)}
                                </div>
                                <div className="text-base font-black wallet-text-strong">
                                  {formatConversionPercent(
                                    10_000n - conversionBps
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                          <input
                            aria-label={`Percentage of customer payment converted to ${splitAssetLabel(conversionTargetAsset)}`}
                            data-testid="merchant-conversion-slider"
                            type="range"
                            min="0"
                            max="10000"
                            step="1"
                            value={conversionBps.toString()}
                            onChange={(event) =>
                              setConversionBps(BigInt(event.target.value))
                            }
                            className="mt-2 h-2 w-full cursor-pointer accent-emerald-400"
                            disabled={creatingRequest}
                          />
                          <div className="mt-1 flex justify-between text-[10px] wallet-muted">
                            <span>0%</span>
                            <span>100%</span>
                          </div>
                        </>
                      )}

                      <div className="mt-2.5 border-t border-[var(--wallet-border)] pt-2">
                        <div className="text-[13px] font-bold wallet-text-strong">
                          Payment summary
                        </div>
                        <div className="mt-1.5 space-y-1">
                          <MerchantPaymentSummaryRow
                            icon={
                              <MerchantAssetIcon
                                asset={incomingAsset}
                                kind="customer"
                                compact
                              />
                            }
                            label="Customer sends"
                            value={customerPaysDisplay}
                            compact
                          />
                          {conversionBps > 0n && !conversionIsDirect ? (
                            <MerchantPaymentSummaryRow
                              icon={
                                <MerchantAssetIcon
                                  asset={conversionTargetAsset}
                                  compact
                                />
                              }
                              label={convertedSummaryLabel}
                              value={convertedDisplayAmount}
                              onClick={() =>
                                setSplitDisplayMode((current) => ({
                                  ...current,
                                  converted:
                                    current.converted === 'source'
                                      ? 'target'
                                      : 'source',
                                }))
                              }
                              ariaLabel={`Toggle converted portion between ${splitAssetLabel(incomingAsset)} and ${splitAssetLabel(conversionTargetAsset)}`}
                              compact
                            />
                          ) : null}
                          <MerchantPaymentSummaryRow
                            icon={
                              <MerchantAssetIcon
                                asset={incomingAsset}
                                compact
                              />
                            }
                            label={directSummaryLabel}
                            value={directDisplayAmount}
                            onClick={() =>
                              setSplitDisplayMode((current) => ({
                                ...current,
                                direct:
                                  current.direct === 'source'
                                    ? 'target'
                                    : 'source',
                              }))
                            }
                            ariaLabel={`Toggle direct portion between ${splitAssetLabel(incomingAsset)} and ${splitAssetLabel(merchantAsset)}`}
                            compact
                          />
                        </div>
                        <div className="mt-1 text-[9px] leading-3 wallet-muted">
                          Tap a row to switch between source and received units.
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                <MerchantAmountPad
                  amount={amount}
                  decimals={selectedDecimals}
                  symbol={
                    merchantAsset === 'bch'
                      ? 'BCH'
                      : selectedStablecoin?.symbol ?? 'PUSD'
                  }
                  amountLabel="Amount merchant receives"
                  hint={
                    merchantAsset === 'bch'
                      ? 'Enter the BCH amount the merchant should receive.'
                      : 'Enter the PUSD amount for this request.'
                  }
                  disabled={creatingRequest}
                  onChange={setAmount}
                  onClear={() => setAmount('')}
                  className="h-[15rem] shrink-0"
                  showAmountCard={false}
                  showHint={false}
                />

                <div className="wallet-card shrink-0 rounded-[20px] p-2.5">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="wallet-muted">
                      {draftQuote
                        ? addonT(
                            'module.quoteReady',
                            'Quote ready · Expires {expires}',
                            {
                              expires:
                                stageExpiresIn ??
                                addonT('module.expired', 'Expired'),
                            }
                          )
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
                        : `${addonT('module.request', 'Request')} ${requestAmountLabel} ${merchantAsset === 'bch' ? 'BCH' : selectedStablecoin?.symbol ?? 'PUSD'}`
                    }
                    onClick={() => void handleCreatePaymentRequest()}
                    variant="primary"
                    compact
                    disabled={
                      creatingRequest || !draftQuote || draftQuoteExpired
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div className="wallet-card shrink-0 rounded-[22px] p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.18em] wallet-muted opacity-70">
                        {addonT('module.paymentRequest', 'Payment request')}
                      </div>
                      <div className="mt-1 text-[clamp(1.7rem,5.5vw,2.4rem)] font-black leading-none tracking-tight wallet-text-strong">
                        {paymentRequest?.merchantReceivesDisplay ??
                          (requestPreparing ? 'Preparing…' : '—')}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] wallet-muted opacity-70">
                        {addonT(
                          'module.estimatedCustomerPayment',
                          'Estimated payment'
                        )}
                      </div>
                      <div className="mt-1 font-semibold wallet-text-strong">
                        {paymentRequest?.customerPaysDisplay ??
                          (requestPreparing ? 'Refreshing…' : '—')}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] wallet-muted opacity-70">
                        {addonT('module.expires', 'Expires')}
                      </div>
                      <div className="mt-1 font-semibold wallet-text-strong">
                        {requestExpiresIn ??
                          (requestPreparing ? '—' : 'Expired')}
                      </div>
                    </div>
                  </div>
                </div>

                {requestPreparing ? (
                  <div
                    className="wallet-card flex min-h-0 flex-1 flex-col items-center justify-center rounded-[22px] p-5 text-center"
                    data-testid="merchant-payment-request-preparing"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-300 border-t-transparent" />
                    </div>
                    <div className="mt-4 text-lg font-bold wallet-text-strong">
                      Preparing payment request
                    </div>
                    <div className="mt-2 max-w-[19rem] text-sm leading-6 wallet-muted">
                      Refreshing liquidity and preparing the payment request.
                    </div>
                  </div>
                ) : paymentRequestExpired ? (
                  <div
                    className="wallet-card flex min-h-0 flex-1 flex-col items-center justify-center rounded-[22px] p-4 text-center"
                    data-testid="merchant-payment-expired"
                  >
                    <MerchantStatusIcon status="expired" />
                    <div className="mt-3 text-lg font-bold wallet-text-strong">
                      {addonT('module.requestExpiredTitle', 'Request expired')}
                    </div>
                    <div className="mt-2 max-w-[18rem] text-sm leading-6 wallet-muted">
                      {addonT(
                        'module.requestExpired',
                        'The exchange quote expired. The payment amount is still {amount}.',
                        {
                          amount:
                            paymentRequest?.merchantReceivesDisplay ?? 'PUSD',
                        }
                      )}
                    </div>
                    <CopyActionButton
                      label={addonT(
                        'module.refreshPaymentRequest',
                        'Refresh payment request'
                      )}
                      onClick={() => void handleRefreshPaymentRequest()}
                      variant="primary"
                      disabled={creatingRequest}
                    />
                  </div>
                ) : paymentDetected ? (
                  <>
                    <div
                      data-testid={`merchant-payment-${displayedPaymentMonitorStatus}`}
                    >
                      <MerchantPaymentStatusCard
                        status={displayedPaymentMonitorStatus}
                        paymentRequest={paymentRequest!}
                        paymentMonitor={paymentMonitor}
                        copy={paymentMonitorCopy}
                        explorerUrl={paymentExplorerUrl}
                      />
                    </div>
                    <MerchantPaymentDetails
                      paymentRequest={paymentRequest!}
                      requestExpiresIn={requestExpiresIn}
                      onCopy={() => void handleCopyPaymentDetails()}
                    />
                  </>
                ) : (
                  <>
                    <div
                      className={`rounded-[22px] border px-3 py-2.5 text-xs ${
                        displayedPaymentMonitorStatus === 'error'
                          ? 'border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)]'
                          : 'border-[var(--wallet-border)] bg-[var(--wallet-surface)]'
                      }`}
                      data-testid="merchant-payment-waiting"
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

                    <div className="wallet-card flex flex-none flex-col rounded-[22px] p-3">
                      <div className="shrink-0 text-center text-sm font-semibold wallet-text-strong">
                        Scan with OPTN Wallet
                      </div>
                      <button
                        type="button"
                        onClick={() => setQrOpen(true)}
                        className="wallet-btn-primary mt-3 w-full px-4 py-3 text-sm"
                        data-merchant-proposal-payload={proposalQrText}
                      >
                        Show QR code
                      </button>
                      <div className="mt-2 shrink-0 text-xs wallet-muted">
                        {paymentRequest?.conversionBps === 0n
                          ? `Customer pays ${paymentRequest.customerPaysDisplay}; merchant receives it directly.`
                          : paymentRequest?.incomingAsset === 'token'
                            ? 'Customer pays PUSD. The selected share is converted to BCH; the rest stays PUSD.'
                            : 'Customer pays BCH. The selected share is converted to PUSD; the rest stays BCH.'}
                      </div>
                    </div>
                    <MerchantPaymentDetails
                      paymentRequest={paymentRequest!}
                      requestExpiresIn={requestExpiresIn}
                      onCopy={() => void handleCopyPaymentDetails()}
                    />
                  </>
                )}

                <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3">
                  {!requestPreparing &&
                  !paymentRequestExpired &&
                  !paymentDetected ? (
                    <>
                      <CopyActionButton
                        label={addonT('module.copyProposal', 'Copy request')}
                        onClick={() => void handleCopyProposal()}
                        compact
                      />
                      <CopyActionButton
                        label={addonT('module.share', 'Share')}
                        onClick={() => void handleSharePaymentRequest()}
                        compact
                      />
                    </>
                  ) : null}
                  {!requestPreparing ? (
                    <CopyActionButton
                      label={
                        paymentRequestExpired
                          ? addonT('common.close', 'Close')
                          : paymentDetected
                            ? addonT('module.new', 'New payment')
                            : addonT('module.cancelRequest', 'Cancel request')
                      }
                      onClick={handleNewPayment}
                      variant={paymentDetected ? 'primary' : 'secondary'}
                      compact
                      className="col-span-2 sm:col-span-1"
                      testId="merchant-new-payment"
                    />
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      </WalletScreen>

      {qrOpen && paymentRequest && proposalQrText ? (
        <div
          className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Merchant payment QR code"
          onClick={() => setQrOpen(false)}
        >
          <div
            className="wallet-popup-panel flex w-full max-w-sm flex-col items-center rounded-[28px] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.45)]"
            style={{ background: 'var(--wallet-surface)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex w-full items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] wallet-muted">
                  Payment request
                </div>
                <div className="mt-1 text-2xl font-black wallet-text-strong">
                  {paymentRequest.merchantReceivesDisplay}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setQrOpen(false)}
                className="wallet-btn-secondary h-9 w-9 shrink-0 rounded-full p-0 text-lg"
                aria-label="Close QR code"
              >
                ×
              </button>
            </div>

            <div className="mt-3 flex w-full items-center justify-between gap-3 text-xs wallet-muted">
              <span>{paymentRequest.customerPaysDisplay}</span>
              <span>Expires {requestExpiresIn ?? '—'}</span>
            </div>

            {proposalQrText.length <= MAX_INLINE_MERCHANT_QR_CHARS ? (
              <div className="mt-3 aspect-square w-full max-w-[22rem] overflow-hidden rounded-[20px] bg-white p-3">
                <QRCodeSVG
                  value={proposalQrText}
                  size={420}
                  level="L"
                  boostLevel={false}
                  includeMargin
                  className="block h-full w-full"
                />
              </div>
            ) : (
              <div
                className="mt-3 w-full max-w-[22rem] rounded-[20px] bg-white p-3"
                data-testid="merchant-payment-stream-qr"
              >
                <QrStreamDisplay
                  payload={paymentRequest.proposalPayload}
                  blockLength={360}
                  framesPerSecond={12}
                  className="block h-auto w-full"
                />
              </div>
            )}

            <div className="mt-3 text-center text-sm wallet-muted">
              {proposalQrText.length <= MAX_INLINE_MERCHANT_QR_CHARS
                ? `Scan to pay ${paymentRequest.customerPaysDisplay}. Merchant receives ${paymentRequest.merchantReceivesDisplay}.`
                : 'Scan the changing QR frames with OPTN Wallet. Keep both wallets open until the request is received.'}
            </div>

            <div className="mt-4 grid w-full grid-cols-2 gap-2">
              <CopyActionButton
                label={addonT('module.copyProposal', 'Copy request')}
                onClick={() => void handleCopyProposal()}
                compact
              />
              <CopyActionButton
                label={addonT('common.close', 'Close')}
                onClick={() => setQrOpen(false)}
                variant="primary"
                compact
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

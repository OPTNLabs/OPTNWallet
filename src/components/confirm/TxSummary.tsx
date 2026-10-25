import { useI18n } from '../../i18n/useI18n';
import { formatNumber } from '../../i18n/format';

export type TxSummaryToken = {
  category: string;
  amount: string;
  nft?: { capability: string; commitment: string };
};

export type TxSummaryInput = {
  txid: string;
  vout: number;
  sats: number;
  token?: boolean;
  tokenDetails?: TxSummaryToken;
};

export type TxSummaryOutput = {
  index: number;
  address: string;
  sats: number;
  kind: 'bch' | 'token';
  tokenDetails?: TxSummaryToken;
};

type Props = {
  // Legacy/generic shape
  inputs?: unknown[];
  outputs?: unknown[];
  txSizeBytes?: number;
  feeSats?: number;
  feeRate?: number;

  // Wallet app shape
  bytes?: number;
  fee?: bigint;
  title?: string;
  subtitle?: string;
  inputsRaw?: unknown[];
  outputsRaw?: unknown[];
  // Backward-compatible aliases used by current app
  [k: string]: unknown;
};

function fmt(n: number, locale: Parameters<typeof formatNumber>[1]) {
  return Number.isFinite(n) ? formatNumber(n, locale) : '0';
}

function toNum(v: unknown): number {
  try {
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return v;
    return Number(v ?? 0);
  } catch {
    return 0;
  }
}

function shortRef(txid: string, vout: number) {
  const a = txid.slice(0, 8);
  const b = txid.slice(-6);
  return `${a}…${b}:${vout}`;
}

function tokenDetails(value: unknown): TxSummaryToken | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const token = value as Record<string, unknown>;
  if (typeof token.category !== 'string') return undefined;
  const nft =
    token.nft && typeof token.nft === 'object'
      ? (token.nft as Record<string, unknown>)
      : null;
  return {
    category: token.category,
    amount: String(token.amount ?? 0),
    ...(nft
      ? {
          nft: {
            capability: String(nft.capability ?? 'none'),
            commitment: String(nft.commitment ?? ''),
          },
        }
      : {}),
  };
}

function normalizeInputs(
  maybeUtxoInputs: unknown[] | undefined,
  maybeGenericInputs: unknown[] | undefined
): TxSummaryInput[] {
  if (Array.isArray(maybeGenericInputs) && maybeGenericInputs.length > 0) {
    return maybeGenericInputs.map((i) => {
      const row = (i ?? {}) as Record<string, unknown>;
      return {
        txid: String(row.txid ?? ''),
        vout: Number(row.vout ?? 0),
        sats: toNum(row.sats ?? 0),
        token: !!row.token,
        tokenDetails:
          (row.tokenDetails as TxSummaryToken | undefined) ??
          tokenDetails(row.token),
      };
    });
  }
  if (!Array.isArray(maybeUtxoInputs)) return [];
  return maybeUtxoInputs.map((u) => {
    const row = (u ?? {}) as Record<string, unknown>;
    return {
      txid: String(row.tx_hash ?? ''),
      vout: Number(row.tx_pos ?? 0),
      sats: toNum(row.value ?? row.amount ?? 0),
      token: !!row.token,
      tokenDetails:
        (row.tokenDetails as TxSummaryToken | undefined) ??
        tokenDetails(row.token),
    };
  });
}

function normalizeOutputs(
  maybeTxOutputs: unknown[] | undefined,
  maybeGenericOutputs: unknown[] | undefined
): TxSummaryOutput[] {
  if (Array.isArray(maybeGenericOutputs) && maybeGenericOutputs.length > 0) {
    return maybeGenericOutputs.map((o, idx) => {
      const row = (o ?? {}) as Record<string, unknown>;
      return {
        index: Number(row.index ?? idx),
        address: String(row.address ?? ''),
        sats: toNum(row.sats ?? 0),
        kind: row.kind === 'token' ? 'token' : 'bch',
        tokenDetails:
          (row.tokenDetails as TxSummaryToken | undefined) ??
          tokenDetails(row.token),
      };
    });
  }
  if (!Array.isArray(maybeTxOutputs)) return [];
  return maybeTxOutputs.map((o, idx: number) => {
    const row = (o ?? {}) as Record<string, unknown>;
    if (Array.isArray(row.opReturn)) {
      return {
        index: idx,
        address: 'OP_RETURN',
        sats: 0,
        kind: 'bch' as const,
      };
    }
    return {
      index: idx,
      address: String(row.recipientAddress ?? ''),
      sats: toNum(row.amount ?? 0),
      kind: row.token ? ('token' as const) : ('bch' as const),
      tokenDetails:
        (row.tokenDetails as TxSummaryToken | undefined) ??
        tokenDetails(row.token),
    };
  });
}

export default function TxSummary(props: Props) {
  const { locale, t } = useI18n();
  const genericInputs = props.inputs;
  const genericOutputs = props.outputs;
  const utxoInputs = props.inputsRaw ?? props.inputs;
  const txOutputs = props.outputsRaw ?? props.outputs;
  const inputs = normalizeInputs(utxoInputs, genericInputs);
  const outputs = normalizeOutputs(txOutputs, genericOutputs);

  const txSizeBytes = props.txSizeBytes ?? props.bytes;
  const feeSats = props.feeSats ?? toNum(props.fee ?? 0);
  const computedFeeRate =
    props.feeRate ??
    (txSizeBytes && txSizeBytes > 0
      ? Math.floor(feeSats / txSizeBytes)
      : undefined);

  const inTotal = inputs.reduce((s, i) => s + (i.sats ?? 0), 0);
  const outTotal = outputs.reduce((s, o) => s + (o.sats ?? 0), 0);

  return (
    <div className="space-y-4">
      {(props.title || props.subtitle) && (
        <div className="space-y-1">
          {props.title ? (
            <div className="text-lg font-semibold">{props.title}</div>
          ) : null}
          {props.subtitle ? (
            <div className="text-sm wallet-muted">{props.subtitle}</div>
          ) : null}
        </div>
      )}

      <div className="wallet-card overflow-hidden">
        <div className="px-4 py-3 border-b">
          <div className="text-sm wallet-muted">{t('txSummary.inputs')}</div>
          <div className="text-base sm:text-lg font-semibold wallet-text-strong">
            {inputs.length} • {fmt(inTotal, locale)} {t('txSummary.sats')}
          </div>
        </div>

        <div className="divide-y">
          {inputs.map((i) => (
            <div
              key={`${i.txid}:${i.vout}`}
              className="px-4 py-3 flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="font-mono text-sm sm:text-base truncate">
                  {shortRef(i.txid, i.vout)}
                </div>
                <div className="text-sm wallet-muted">
                  {i.token
                    ? t('txSummary.tokenInput')
                    : t('txSummary.bchInput')}
                </div>
                {i.tokenDetails && <TokenDetails token={i.tokenDetails} />}
              </div>

              <div className="text-sm sm:text-base font-semibold whitespace-nowrap">
                {fmt(i.sats, locale)} {t('txSummary.sats')}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="wallet-card overflow-hidden">
        <div className="px-4 py-3 border-b">
          <div className="text-sm wallet-muted">{t('txSummary.outputs')}</div>
          <div className="text-base sm:text-lg font-semibold wallet-text-strong">
            {outputs.length} • {fmt(outTotal, locale)} {t('txSummary.sats')}
          </div>
        </div>

        <div className="divide-y">
          {outputs.map((o) => (
            <div
              key={o.index}
              className="px-4 py-3 flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-sm sm:text-base font-semibold">
                  [{o.index}]{' '}
                  {o.kind === 'token'
                    ? t('txSummary.token')
                    : t('txSummary.bch')}
                </div>
                <div className="font-mono text-sm sm:text-base break-all">
                  {o.address}
                </div>
                {o.tokenDetails && <TokenDetails token={o.tokenDetails} />}
              </div>

              <div className="text-sm sm:text-base font-semibold whitespace-nowrap">
                {fmt(o.sats, locale)} {t('txSummary.sats')}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="wallet-card px-4 py-3">
        <div className="grid grid-cols-2 gap-y-2 text-sm sm:text-base">
          <div className="wallet-muted">{t('txSummary.txSize')}</div>
          <div className="text-right font-semibold">
            {txSizeBytes != null
              ? `${fmt(txSizeBytes, locale)} ${t('txSummary.bytes')}`
              : '—'}
          </div>

          <div className="wallet-muted">{t('txSummary.fee')}</div>
          <div className="text-right font-semibold">
            {feeSats != null
              ? `${fmt(feeSats, locale)} ${t('txSummary.sats')}`
              : '—'}
          </div>

          <div className="wallet-muted">{t('txSummary.feeRate')}</div>
          <div className="text-right font-semibold">
            {computedFeeRate != null ? `${computedFeeRate} sat/byte` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

function TokenDetails({ token }: { token: TxSummaryToken }) {
  return (
    <div className="mt-2 text-sm space-y-1 wallet-muted">
      <div className="break-all">
        Category: <span className="font-mono">{token.category}</span>
      </div>
      <div>Fungible amount: {token.amount} base units</div>
      {token.nft && (
        <>
          <div>NFT capability: {token.nft.capability}</div>
          <div className="break-all">
            NFT commitment:{' '}
            <span className="font-mono">{token.nft.commitment || 'empty'}</span>
          </div>
        </>
      )}
    </div>
  );
}

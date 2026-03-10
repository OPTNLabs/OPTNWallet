export type TxSummaryInput = {
  txid: string;
  vout: number;
  sats: number;
  token?: boolean;
};

export type TxSummaryOutput = {
  index: number;
  address: string;
  sats: number;
  kind: 'bch' | 'token';
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

function fmt(n: number) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '0';
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

function shortAddr(addr: string) {
  if (addr.length <= 24) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
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
      };
    });
  }
  if (!Array.isArray(maybeTxOutputs)) return [];
  return maybeTxOutputs
    .map((o, idx: number) => {
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
      };
    });
}

export default function TxSummary(props: Props) {
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
          {props.title ? <div className="text-lg font-semibold">{props.title}</div> : null}
          {props.subtitle ? (
            <div className="text-sm wallet-muted">{props.subtitle}</div>
          ) : null}
        </div>
      )}

      <div className="wallet-card overflow-hidden">
        <div className="px-4 py-3 border-b">
          <div className="text-sm wallet-muted">Inputs</div>
          <div className="text-base sm:text-lg font-semibold wallet-text-strong">
            {inputs.length} • {fmt(inTotal)} sats
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
                  {i.token ? 'token input' : 'bch input'}
                </div>
              </div>

              <div className="text-sm sm:text-base font-semibold whitespace-nowrap">
                {fmt(i.sats)} sats
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="wallet-card overflow-hidden">
        <div className="px-4 py-3 border-b">
          <div className="text-sm wallet-muted">Outputs</div>
          <div className="text-base sm:text-lg font-semibold wallet-text-strong">
            {outputs.length} • {fmt(outTotal)} sats
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
                  [{o.index}] {o.kind}
                </div>
                <div className="font-mono text-sm sm:text-base break-all">
                  {shortAddr(o.address)}
                </div>
              </div>

              <div className="text-sm sm:text-base font-semibold whitespace-nowrap">
                {fmt(o.sats)} sats
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="wallet-card px-4 py-3">
        <div className="grid grid-cols-2 gap-y-2 text-sm sm:text-base">
          <div className="wallet-muted">Tx size</div>
          <div className="text-right font-semibold">
            {txSizeBytes != null ? `${fmt(txSizeBytes)} bytes` : '—'}
          </div>

          <div className="wallet-muted">Fee</div>
          <div className="text-right font-semibold">
            {feeSats != null ? `${fmt(feeSats)} sats` : '—'}
          </div>

          <div className="wallet-muted">Fee rate</div>
          <div className="text-right font-semibold">
            {computedFeeRate != null ? `${computedFeeRate} sat/byte` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

// src/components/confirm/TxSummary.tsx
import type { TransactionOutput, UTXO } from '../../types/types';

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
  inputs?: TxSummaryInput[];
  outputs?: TxSummaryOutput[];
  txSizeBytes?: number;
  feeSats?: number;
  feeRate?: number;

  // Wallet app shape
  bytes?: number;
  fee?: bigint;
  title?: string;
  subtitle?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputsRaw?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputsRaw?: any[];
  // Backward-compatible aliases used by current app
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maybeUtxoInputs: any[] | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maybeGenericInputs: any[] | undefined
): TxSummaryInput[] {
  if (Array.isArray(maybeGenericInputs) && maybeGenericInputs.length > 0) {
    return maybeGenericInputs.map((i) => ({
      txid: String(i.txid ?? ''),
      vout: Number(i.vout ?? 0),
      sats: toNum(i.sats ?? 0),
      token: !!i.token,
    }));
  }
  if (!Array.isArray(maybeUtxoInputs)) return [];
  return maybeUtxoInputs.map((u) => ({
    txid: String(u.tx_hash ?? ''),
    vout: Number(u.tx_pos ?? 0),
    sats: toNum(u.value ?? u.amount ?? 0),
    token: !!u.token,
  }));
}

function normalizeOutputs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maybeTxOutputs: any[] | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maybeGenericOutputs: any[] | undefined
): TxSummaryOutput[] {
  if (Array.isArray(maybeGenericOutputs) && maybeGenericOutputs.length > 0) {
    return maybeGenericOutputs.map((o, idx) => ({
      index: Number(o.index ?? idx),
      address: String(o.address ?? ''),
      sats: toNum(o.sats ?? 0),
      kind: o.kind === 'token' ? 'token' : 'bch',
    }));
  }
  if (!Array.isArray(maybeTxOutputs)) return [];
  return maybeTxOutputs
    .map((o: TransactionOutput, idx: number) => {
      if ('opReturn' in o && o.opReturn) {
        return {
          index: idx,
          address: 'OP_RETURN',
          sats: 0,
          kind: 'bch' as const,
        };
      }
      return {
        index: idx,
        address: String(o.recipientAddress ?? ''),
        sats: toNum(o.amount ?? 0),
        kind: o.token ? 'token' as const : 'bch' as const,
      };
    });
}

export default function TxSummary(props: Props) {
  const utxoInputs = ((props.inputs as unknown as UTXO[]) ??
    props.inputsRaw) as unknown[] | undefined;
  const txOutputs = ((props.outputs as unknown as TransactionOutput[]) ??
    props.outputsRaw) as unknown[] | undefined;
  const genericInputs = props.inputs as unknown[] | undefined;
  const genericOutputs = props.outputs as unknown[] | undefined;
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
            <div className="text-sm text-gray-600">{props.subtitle}</div>
          ) : null}
        </div>
      )}

      <div className="rounded-2xl border bg-white overflow-hidden">
        <div className="px-4 py-3 border-b">
          <div className="text-sm text-gray-600">Inputs</div>
          <div className="text-base sm:text-lg font-semibold">
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
                <div className="text-sm text-gray-600">
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

      <div className="rounded-2xl border bg-white overflow-hidden">
        <div className="px-4 py-3 border-b">
          <div className="text-sm text-gray-600">Outputs</div>
          <div className="text-base sm:text-lg font-semibold">
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

      <div className="rounded-2xl border bg-white px-4 py-3">
        <div className="grid grid-cols-2 gap-y-2 text-sm sm:text-base">
          <div className="text-gray-600">Tx size</div>
          <div className="text-right font-semibold">
            {txSizeBytes != null ? `${fmt(txSizeBytes)} bytes` : '—'}
          </div>

          <div className="text-gray-600">Fee</div>
          <div className="text-right font-semibold">
            {feeSats != null ? `${fmt(feeSats)} sats` : '—'}
          </div>

          <div className="text-gray-600">Fee rate</div>
          <div className="text-right font-semibold">
            {computedFeeRate != null ? `${computedFeeRate} sat/byte` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

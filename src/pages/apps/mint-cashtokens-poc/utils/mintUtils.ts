import type { TransactionOutput } from '../../../../types/types';
import type {
  TxSummaryInput,
  TxSummaryOutput,
} from '../../../../components/confirm/TxSummary';
import type { MintAppUtxo, MintOutputDraft } from '../types';

type UtxoValueShape = {
  value?: bigint | number | string;
  amount?: bigint | number | string;
};

export function utxoKey(u: MintAppUtxo): string {
  return `${u.tx_hash}:${u.tx_pos}`;
}

export function shortHash(h: string, left = 10, right = 6): string {
  if (!h) return '';
  if (h.length <= left + right + 3) return h;
  return `${h.slice(0, left)}…${h.slice(-right)}`;
}

export function utxoValue(u: UtxoValueShape | null | undefined): bigint {
  const v = u?.value ?? u?.amount ?? 0;
  try {
    return typeof v === 'bigint' ? v : BigInt(v);
  } catch {
    return 0n;
  }
}

export function toBigIntSafe(x: string): bigint {
  try {
    const t = (x ?? '').trim();
    if (!t) return 0n;
    return BigInt(t);
  } catch {
    return 0n;
  }
}

export function sumOutputs(outputs: TransactionOutput[]): bigint {
  return outputs.reduce((sum: bigint, o: TransactionOutput) => {
    if ('opReturn' in o && o.opReturn) return sum;
    const amt = o?.amount ?? 0;
    try {
      return sum + (typeof amt === 'bigint' ? amt : BigInt(amt));
    } catch {
      return sum;
    }
  }, 0n);
}

export function mergeWalletUtxos(res: unknown): MintAppUtxo[] {
  const walletRes = (res ?? {}) as {
    allUtxos?: MintAppUtxo[];
    tokenUtxos?: MintAppUtxo[];
    cashTokenUtxos?: MintAppUtxo[];
  };

  const all: MintAppUtxo[] = Array.isArray(walletRes.allUtxos)
    ? walletRes.allUtxos
    : [];
  const tok: MintAppUtxo[] = Array.isArray(walletRes.tokenUtxos)
    ? walletRes.tokenUtxos
    : [];
  const tok2: MintAppUtxo[] = Array.isArray(walletRes.cashTokenUtxos)
    ? walletRes.cashTokenUtxos
    : [];
  const merged = [...all, ...tok, ...tok2];

  const seen = new Set<string>();
  const out: MintAppUtxo[] = [];
  for (const u of merged) {
    const k = `${u.tx_hash}:${u.tx_pos}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

export function validateCategoryReuseRules(
  drafts: MintOutputDraft[],
  sourceByKey: Map<string, MintAppUtxo>
): { ok: true } | { ok: false; message: string } {
  const byCategory = new Map<string, MintOutputDraft[]>();

  for (const d of drafts) {
    const src = sourceByKey.get(d.sourceKey);
    if (!src) continue;

    const category = String(src.tx_hash || '').trim();
    if (!category) continue;

    const list = byCategory.get(category) ?? [];
    list.push(d);
    byCategory.set(category, list);
  }

  for (const [category, list] of byCategory) {
    if (list.length <= 1) continue;

    const hasNftOutput = list.some((d) => d.config.mintType === 'NFT');
    if (!hasNftOutput) continue;

    return {
      ok: false,
      message:
        `Category ${shortHash(category, 12, 8)} is used in multiple outputs. ` +
        `When reusing a category across outputs, all outputs must be FT (NFT outputs cannot be duplicated).`,
    };
  }

  return { ok: true };
}

export function filterActiveOutputDrafts(
  drafts: MintOutputDraft[],
  selectedRecipientSet: ReadonlySet<string>,
  selectedSourceKeySet: ReadonlySet<string>
): MintOutputDraft[] {
  return drafts.filter(
    (d) =>
      selectedRecipientSet.has(d.recipientCashAddr) &&
      selectedSourceKeySet.has(d.sourceKey)
  );
}

export function asTxSummaryInputs(utxos: MintAppUtxo[]): TxSummaryInput[] {
  return utxos.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    sats: Number(utxoValue(u)),
    token: !!u.token,
  }));
}

export function asTxSummaryOutputs(
  outputs: TransactionOutput[] | undefined
): TxSummaryOutput[] {
  if (!outputs) return [];
  return outputs.map((o, index) => {
    if ('opReturn' in o && o.opReturn) {
      return {
        index,
        address: 'OP_RETURN',
        sats: 0,
        kind: 'bch' as const,
      };
    }
    return {
      index,
      address: o.recipientAddress,
      sats: Number(o.amount ?? 0),
      kind: o.token ? ('token' as const) : ('bch' as const),
    };
  });
}

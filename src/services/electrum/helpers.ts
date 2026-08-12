import {
  cashAddressToLockingBytecode,
  lockingBytecodeToCashAddress,
  sha256,
} from '@bitauth/libauth';
import { RequestResponse } from '@electrum-cash/network';
import { Network } from '../../state/slices/networkSlice';
import { store } from '../../state/store';
import { binToHex, hexToBin } from '../../utils/hex';
import { normalizeTokenField } from '../../utils/tokenNormalization';
import {
  TransactionDetailParticipant,
  TransactionHistoryItem,
  UTXO,
} from '../../types/types';

export type TransactionVisibility = {
  seen: boolean;
  confirmed: boolean;
};

export type ElectrumVin = {
  txid?: unknown;
  vout?: unknown;
  coinbase?: unknown;
};

export type ElectrumVout = {
  value?: unknown;
  n?: unknown;
  scriptPubKey?: {
    address?: unknown;
    addresses?: unknown;
    hex?: unknown;
  };
};

export type ElectrumVerboseTransaction = {
  txid?: unknown;
  confirmations?: unknown;
  blocktime?: unknown;
  time?: unknown;
  height?: unknown;
  fee?: unknown;
  vin?: ElectrumVin[];
  vout?: ElectrumVout[];
};

function currentAddressPrefix(): 'bitcoincash' | 'bchtest' {
  const network = store.getState().network.currentNetwork;
  return network === Network.CHIPNET ? 'bchtest' : 'bitcoincash';
}

export function isTransactionHistoryArray(
  response: RequestResponse
): response is TransactionHistoryItem[] {
  return (
    Array.isArray(response) &&
    response.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        'tx_hash' in item &&
        'height' in item
    )
  );
}

export function isStringResponse(response: RequestResponse): response is string {
  return typeof response === 'string';
}

export function isVerboseTransaction(
  response: RequestResponse
): response is ElectrumVerboseTransaction {
  return !!response && typeof response === 'object' && !Array.isArray(response);
}

export function toSats(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100_000_000);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100_000_000) : undefined;
  }
  return undefined;
}

export function decodeAddressFromScriptHex(scriptHex: unknown): string | null {
  if (typeof scriptHex !== 'string' || !scriptHex.trim()) return null;
  try {
    const result = lockingBytecodeToCashAddress({
      bytecode: hexToBin(scriptHex),
      prefix: currentAddressPrefix(),
    });
    return typeof result === 'string' ? result : result.address;
  } catch {
    return null;
  }
}

export function isInvalidAddressError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error)
    .toLowerCase()
    .includes('invalid address');
}

export function addressToElectrumScripthash(address: string): string {
  const lockingBytecode = cashAddressToLockingBytecode(address);
  if (typeof lockingBytecode === 'string') {
    throw new Error(`Invalid address: ${address}`);
  }

  const digest = sha256.hash(lockingBytecode.bytecode);
  return binToHex(Uint8Array.from(digest).reverse());
}

export function extractOutputAddress(vout: ElectrumVout): string {
  const script = vout.scriptPubKey;
  if (typeof script?.address === 'string' && script.address.trim()) {
    return script.address;
  }

  const addresses = Array.isArray(script?.addresses)
    ? script.addresses.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
      )
    : [];
  if (addresses.length > 0) {
    return addresses.join(', ');
  }

  return decodeAddressFromScriptHex(script?.hex) ?? 'Unknown / non-standard output';
}

export function extractTimestamp(tx: ElectrumVerboseTransaction): string | undefined {
  const candidate =
    typeof tx.blocktime === 'number'
      ? tx.blocktime
      : typeof tx.time === 'number'
        ? tx.time
        : null;
  return candidate != null ? new Date(candidate * 1000).toISOString() : undefined;
}

export function mapOutputParticipant(
  vout: ElectrumVout
): TransactionDetailParticipant {
  return {
    address: extractOutputAddress(vout),
    amountSats: toSats(vout.value),
    outputIndex:
      typeof vout.n === 'number' && Number.isFinite(vout.n)
        ? vout.n
        : undefined,
  };
}

export function sumKnownSats(rows: TransactionDetailParticipant[]): number | undefined {
  let total = 0;
  for (const row of rows) {
    if (row.amountSats == null || !Number.isFinite(row.amountSats)) {
      return undefined;
    }
    total += row.amountSats;
  }
  return total;
}

export function deriveFeeSats(
  fee: unknown,
  inputs: TransactionDetailParticipant[],
  outputs: TransactionDetailParticipant[]
): number | undefined {
  const explicitFee = toSats(fee);
  if (explicitFee != null) return explicitFee;

  const totalInput = sumKnownSats(inputs);
  const totalOutput = sumKnownSats(outputs);
  if (totalInput == null || totalOutput == null) return undefined;

  const derived = totalInput - totalOutput;
  return derived >= 0 ? derived : undefined;
}

export function normalizeParticipantRows(raw: unknown): TransactionDetailParticipant[] {
  if (!Array.isArray(raw)) return [];
  const rows: TransactionDetailParticipant[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    rows.push({
      address: typeof row.address === 'string' ? row.address : 'Unknown',
      amountSats:
        typeof row.amountSats === 'number' && Number.isFinite(row.amountSats)
          ? row.amountSats
          : undefined,
      outputIndex:
        typeof row.outputIndex === 'number' && Number.isFinite(row.outputIndex)
          ? row.outputIndex
          : undefined,
    });
  }
  return rows;
}

export function mapUtxoRows(address: string, rows: Array<Record<string, unknown>>): UTXO[] {
  return rows.map((u) => {
    const token = normalizeTokenField(u.token ?? u.token_data);

    const out: UTXO = {
      address: typeof u.address === 'string' ? u.address : address,
      height: Number(u.height ?? 0),
      tx_hash: String(u.tx_hash),
      tx_pos: Number(u.tx_pos),
      value: Number(u.value ?? 0),
      amount: Number(u.value ?? 0),
      prefix: undefined,
      token,
      token_data: undefined,
      id: `${u.tx_hash}:${u.tx_pos}`,
    };
    return out;
  });
}

export function toVisibilityFromResponse(
  response: RequestResponse
): TransactionVisibility {
  if (typeof response === 'string') {
    return {
      seen: response.length > 0,
      confirmed: false,
    };
  }

  if (response && typeof response === 'object') {
    const record = response as { confirmations?: unknown; height?: unknown };
    const confirmations = Number(record.confirmations ?? 0);
    const height = Number(record.height ?? 0);
    return {
      seen: true,
      confirmed: confirmations > 0 || height > 0,
    };
  }

  throw new Error('Invalid transaction visibility response');
}

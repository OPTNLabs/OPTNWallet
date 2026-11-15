import type { TransactionDetails } from '../../types/types';

export type WalletTokenEffect = {
  /** Normalized CashToken category. */
  category: string;
  /** Wallet-owned outputs minus wallet-owned inputs in base units. */
  amount: bigint;
};

export type WalletTransactionEffect = {
  /** Wallet-owned outputs minus wallet-owned inputs, in satoshis. */
  bchDeltaSats: number;
  walletInputSats: number;
  walletOutputSats: number;
  tokenDeltas: WalletTokenEffect[];
};

function tokenAmountToBigInt(amount: number | bigint): bigint | null {
  if (typeof amount === 'bigint') return amount;
  return Number.isSafeInteger(amount) ? BigInt(amount) : null;
}

function deriveWalletTokenEffects(
  details: TransactionDetails,
  walletAddresses: ReadonlySet<string>
): WalletTokenEffect[] {
  const deltas = new Map<string, bigint>();
  const apply = (
    rows: TransactionDetails['inputs'],
    direction: bigint
  ): void => {
    for (const row of rows) {
      if (!walletAddresses.has(row.address) || !row.token) continue;
      const category = row.token.category.trim().toLowerCase();
      const amount = tokenAmountToBigInt(row.token.amount);
      if (!category || amount === null) continue;
      deltas.set(category, (deltas.get(category) ?? 0n) + direction * amount);
    }
  };

  apply(details.inputs, -1n);
  apply(details.outputs, 1n);

  return Array.from(deltas, ([category, amount]) => ({ category, amount }))
    .filter((effect) => effect.amount !== 0n)
    .sort((left, right) => left.category.localeCompare(right.category));
}

/**
 * Derive the wallet's net BCH movement from verbose transaction participants.
 * Electrum address history only carries txid/height, so callers must treat a
 * missing result as unknown rather than displaying a misleading zero.
 */
export function deriveWalletTransactionEffect(
  details: TransactionDetails,
  walletAddresses: ReadonlySet<string>
): WalletTransactionEffect | null {
  const walletInputs = details.inputs.filter((row) =>
    walletAddresses.has(row.address)
  );
  const walletOutputs = details.outputs.filter((row) =>
    walletAddresses.has(row.address)
  );
  if (walletInputs.length === 0 && walletOutputs.length === 0) return null;

  const walletInputSats = walletInputs.reduce(
    (total, row) => total + (row.amountSats ?? 0),
    0
  );
  const walletOutputSats = walletOutputs.reduce(
    (total, row) => total + (row.amountSats ?? 0),
    0
  );
  return {
    bchDeltaSats: walletOutputSats - walletInputSats,
    walletInputSats,
    walletOutputSats,
    tokenDeltas: deriveWalletTokenEffects(details, walletAddresses),
  };
}

import type { TransactionDetails } from '../../types/types';

export type WalletTransactionEffect = {
  /** Wallet-owned outputs minus wallet-owned inputs, in satoshis. */
  bchDeltaSats: number;
  walletInputSats: number;
  walletOutputSats: number;
};

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
  };
}

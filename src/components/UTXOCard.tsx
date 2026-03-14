// src/components/UTXOCard.tsx
import React from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { shortenTxHash } from '../utils/shortenHash';
import { UTXO } from '../types/types';
import { SATSINBITCOIN } from '../utils/constants';
import useSharedTokenMetadata from '../hooks/useSharedTokenMetadata';

interface UTXOCardProps {
  utxos: UTXO[];
  loading: boolean;
}

const SATS_PER_BCH_BIGINT = BigInt(SATSINBITCOIN);

function formatBchFromSats(
  sats: number | string | bigint | undefined | null
): string {
  if (sats === null || sats === undefined) return '0';

  // bigint-safe formatting (no precision loss)
  if (typeof sats === 'bigint') {
    const whole = sats / SATS_PER_BCH_BIGINT;
    const frac = sats % SATS_PER_BCH_BIGINT;

    let fracStr = frac.toString().padStart(8, '0');
    fracStr = fracStr.replace(/0+$/, ''); // trim trailing zeros

    return fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
  }

  // number/string formatting
  const n = typeof sats === 'string' ? Number(sats) : sats;
  if (!Number.isFinite(n)) return '0';

  return (n / SATSINBITCOIN).toFixed(8).replace(/\.?0+$/, '');
}

// Function to format token amounts based on decimals
function formatTokenAmount(
  amount: number | string | bigint,
  decimals: number = 0
): string {
  if (decimals === 0) return amount.toString();

  // bigint-safe formatting for tokens too (prevents precision loss)
  if (typeof amount === 'bigint') {
    const base = 10n ** BigInt(decimals);
    const whole = amount / base;
    const frac = amount % base;

    let fracStr = frac.toString().padStart(decimals, '0');
    fracStr = fracStr.replace(/0+$/, '');

    return fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
  }

  const numAmount = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(numAmount)) return '0';

  const divisor = Math.pow(10, decimals);
  return (numAmount / divisor).toFixed(decimals).replace(/\.?0+$/, '');
}

const UTXOCard: React.FC<UTXOCardProps> = ({ utxos, loading }) => {
  const tokenMetadata = useSharedTokenMetadata(
    utxos
      .map((u) => u.token?.category)
      .filter((category): category is string => Boolean(category))
  );

  if (loading) {
    return (
      <div className="flex items-center wallet-muted">
        <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
        <span>Loading UTXOs…</span>
      </div>
    );
  }

  return (
    <div>
      {utxos.map((utxo, i) => {
        const isToken = Boolean(utxo.token);
        const tokenData = isToken ? utxo.token : null;
        const metadata = tokenData?.BcmrTokenMetadata || null;
        const category = tokenData?.category || null;
        const sharedMeta = category ? tokenMetadata[category] : null;
        const iconUri = sharedMeta?.iconUri ?? null;

        // ✅ Contract UTXOs may not have `value`, but do have `amount`
        const sats = (utxo.value ?? utxo.amount) as
          | number
          | string
          | bigint
          | undefined;

        return (
          <div
            key={i}
            className="wallet-card p-3 mb-3 grid grid-cols-[1fr_auto] gap-4"
          >
            <div className="space-y-1 text-sm">
              {isToken ? (
                <>
                  <p>
                    <strong>Amount:</strong>{' '}
                    {formatTokenAmount(
                      tokenData!.amount,
                      metadata?.token.decimals || 0
                    )}{' '}
                    {metadata?.token.symbol || 'tokens'}
                  </p>
                  <p>
                    <strong>Name:</strong> {metadata?.name || 'Unknown Token'}
                  </p>
                  <p>
                    {formatBchFromSats(sats)} <strong>BCH</strong>
                  </p>
                </>
              ) : (
                <>
                  <p>
                    {formatBchFromSats(sats)} <strong>BCH</strong>
                  </p>
                  <p>
                    <strong>Tx Hash:</strong> {shortenTxHash(utxo.tx_hash)}
                  </p>
                  <p>
                    <strong>Pos:</strong> {utxo.tx_pos}
                  </p>
                  <p>
                    <strong>Height:</strong> {utxo.height}
                  </p>
                </>
              )}
            </div>

            <div className="flex flex-col items-center space-y-2">
              {isToken && metadata ? (
                <>
                  {sharedMeta ? (
                    iconUri ? (
                      <img
                        src={iconUri}
                        alt={metadata.name || 'Token'}
                        className="w-12 h-12 rounded"
                      />
                    ) : (
                      <div className="w-12 h-12 wallet-surface-strong rounded flex items-center justify-center">
                        <span className="wallet-muted">No Icon</span>
                      </div>
                    )
                  ) : (
                    <div className="w-12 h-12 wallet-surface-strong rounded flex items-center justify-center">
                      <span className="wallet-muted">Loading...</span>
                    </div>
                  )}
                  <span className="text-base font-medium text-center">
                    {sharedMeta?.name || metadata.name || 'Unknown Token'}
                  </span>
                </>
              ) : (
                <>
                  <FaBitcoin className="wallet-accent-icon text-4xl" />
                  <span className="text-base font-medium text-center">
                    Bitcoin Cash
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}

      {!utxos.length && <p className="wallet-muted">No UTXOs to display.</p>}
    </div>
  );
};

export default UTXOCard;

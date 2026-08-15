// src/components/UTXOCard.tsx
import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { shortenTxHash } from '../utils/shortenHash';
import { UTXO } from '../types/types';
import { SATSINBITCOIN } from '../utils/constants';
import useSharedTokenMetadata from '../hooks/useSharedTokenMetadata';
import TokenIdentityBadge from './ui/TokenIdentityBadge';
import {
  formatAtomicTokenAmount,
  resolveTokenPresentation,
} from '../utils/tokenPresentation';
import { coinDepth } from '../platform/desktop/fusionCoinDepth';
import {
  getCoinLabel,
  outpointKey,
  setCoinLabel,
} from '../platform/desktop/CoinLabelService';
import { selectWalletId } from '../state/slices/walletSlice';
import { FusionBadge } from './FusionBadge';

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

const UTXOCard: React.FC<UTXOCardProps> = ({ utxos, loading }) => {
  const walletId = useSelector(selectWalletId);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const tokenMetadata = useSharedTokenMetadata(
    utxos
      .map((u) => u.token?.category)
      .filter((category): category is string => Boolean(category))
  );

  useEffect(() => {
    if (walletId <= 0 || utxos.length === 0) {
      setLabels({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        utxos.map(async (u) => {
          const key = outpointKey(u.tx_hash, u.tx_pos);
          const label = await getCoinLabel(walletId, 'outpoint', key);
          if (label) next[key] = label;
        })
      );
      if (!cancelled) setLabels(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [walletId, utxos]);

  const editLabel = useCallback(
    async (txHash: string, txPos: number, current: string | undefined) => {
      if (walletId <= 0) return;
      const key = outpointKey(txHash, txPos);
      const next = window.prompt(
        'Label this coin (empty to clear). Personal note only — not used for balance.',
        current ?? ''
      );
      if (next === null) return;
      await setCoinLabel(walletId, 'outpoint', key, next);
      setLabels((prev) => {
        const copy = { ...prev };
        const cleaned = next.trim();
        if (cleaned) copy[key] = cleaned.slice(0, 200);
        else delete copy[key];
        return copy;
      });
    },
    [walletId]
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
        const presentation = resolveTokenPresentation(category ?? '', sharedMeta, {
          name: metadata?.name ?? null,
          symbol: metadata?.token.symbol ?? null,
          decimals: metadata?.token.decimals ?? null,
          iconUri: metadata?.uris?.icon ?? null,
        });

        // ✅ Contract UTXOs may not have `value`, but do have `amount`
        const sats = (utxo.value ?? utxo.amount) as
          | number
          | string
          | bigint
          | undefined;
        const okey = outpointKey(utxo.tx_hash, utxo.tx_pos);
        const depth = walletId > 0 ? coinDepth(walletId, okey) : 0;
        const coinLabel = labels[okey];

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
                    {formatAtomicTokenAmount(
                      tokenData!.amount,
                      presentation.decimals
                    )}{' '}
                    {presentation.symbol || 'tokens'}
                  </p>
                  <p>
                    <strong>Name:</strong> {presentation.primaryLabel}
                  </p>
                  <p>
                    {formatBchFromSats(sats)} <strong>BCH</strong>
                  </p>
                </>
              ) : (
                <>
                  <p>
                    {formatBchFromSats(sats)} <strong>BCH</strong>
                    {depth > 0 && (
                      <FusionBadge depth={depth} className="ml-2" />
                    )}
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
              {walletId > 0 && (
                <p className="flex flex-wrap items-center gap-2">
                  <strong>Label:</strong>{' '}
                  <span className="wallet-text-strong">
                    {coinLabel || (
                      <span className="wallet-muted italic">none</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="text-xs underline wallet-muted hover:wallet-text-strong"
                    onClick={() =>
                      void editLabel(utxo.tx_hash, utxo.tx_pos, coinLabel)
                    }
                  >
                    Edit
                  </button>
                </p>
              )}
            </div>

            <div className="flex flex-col items-center space-y-2">
              {isToken ? (
                <TokenIdentityBadge
                  presentation={presentation}
                  className="w-full justify-center"
                  avatarClassName="h-12 w-12"
                  primaryClassName="text-center"
                  secondaryClassName="justify-center"
                  showStatus={false}
                  detail={
                    <span className="text-xs wallet-muted">
                      {utxo.token?.nft ? 'NFT' : 'FT'}
                    </span>
                  }
                />
              ) : (
                <div className="text-center">
                  <div className="text-base font-semibold wallet-text-strong">
                    Bitcoin Cash
                  </div>
                </div>
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

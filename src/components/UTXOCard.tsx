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
import {
  freezeCoin,
  holdKey,
  HOLD_REASON_LABELS,
  readCoinHolds,
  unfreezeCoin,
  type CoinHold,
} from '../platform/desktop/coinHoldsBridge';
import { isDesktopPlatform } from '../utils/platform';
import { useI18n } from '../i18n/useI18n';

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
  const { t } = useI18n();
  const walletId = useSelector(selectWalletId);
  const [labels, setLabels] = useState<Record<string, string>>({});
  // Held coins, keyed by outpoint. The record is the runtime's, and it is the
  // same one a Flipstarter pledge or an in-flight Fusion round holds a coin
  // with -- which is why the reason is shown and only a user hold offers a
  // control to lift it.
  const [holds, setHolds] = useState<Record<string, CoinHold>>({});
  const [holdError, setHoldError] = useState('');
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

  const applyHolds = useCallback((rows: CoinHold[]) => {
    setHolds(
      Object.fromEntries(rows.map((hold) => [holdKey(hold.txid, hold.vout), hold]))
    );
  }, []);

  useEffect(() => {
    if (walletId <= 0 || !isDesktopPlatform()) return;
    let cancelled = false;
    void readCoinHolds(walletId)
      .then((rows) => {
        if (!cancelled) applyHolds(rows);
      })
      .catch((error) =>
        console.error('[coins] could not read coin holds:', error)
      );
    return () => {
      cancelled = true;
    };
  }, [walletId, applyHolds]);

  const toggleHold = useCallback(
    async (txHash: string, txPos: number, held: CoinHold | undefined) => {
      if (walletId <= 0) return;
      setHoldError('');
      try {
        applyHolds(
          held
            ? await unfreezeCoin(walletId, txHash, txPos)
            : await freezeCoin(walletId, txHash, txPos)
        );
      } catch (error) {
        // The runtime refuses a release that is not the user's to make; say so
        // rather than leaving the button looking broken.
        setHoldError(error instanceof Error ? error.message : String(error));
      }
    },
    [walletId, applyHolds]
  );

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
        <span>{t('utxo.loading')}</span>
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
        const presentation = resolveTokenPresentation(
          category ?? '',
          sharedMeta,
          {
            name: metadata?.name ?? null,
            symbol: metadata?.token.symbol ?? null,
            decimals: metadata?.token.decimals ?? null,
            iconUri: metadata?.uris?.icon ?? null,
          }
        );

        // ✅ Contract UTXOs may not have `value`, but do have `amount`
        const sats = (utxo.value ?? utxo.amount) as
          | number
          | string
          | bigint
          | undefined;
        const okey = outpointKey(utxo.tx_hash, utxo.tx_pos);
        const depth = walletId > 0 ? coinDepth(walletId, okey) : 0;
        const coinLabel = labels[okey];
        const held = holds[holdKey(utxo.tx_hash, utxo.tx_pos)];

        return (
          <div
            key={i}
            className="wallet-card p-3 mb-3 grid grid-cols-[1fr_auto] gap-4"
          >
            <div className="space-y-1 text-sm">
              {isToken ? (
                <>
                  <p>
                    <strong>{t('utxo.amount')}:</strong>{' '}
                    {formatAtomicTokenAmount(
                      tokenData!.amount,
                      presentation.decimals
                    )}{' '}
                    {presentation.symbol || t('utxo.tokens')}
                  </p>
                  <p>
                    <strong>{t('utxo.name')}:</strong>{' '}
                    {presentation.primaryLabel}
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
                    <strong>{t('utxo.txHash')}:</strong>{' '}
                    {shortenTxHash(utxo.tx_hash)}
                  </p>
                  <p>
                    <strong>{t('utxo.pos')}:</strong> {utxo.tx_pos}
                  </p>
                  <p>
                    <strong>{t('utxo.height')}:</strong> {utxo.height}
                  </p>
                </>
              )}
              {held && (
                <p className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-1.5 py-px text-[10px] uppercase tracking-wide text-[var(--wallet-warning-text)]">
                    {HOLD_REASON_LABELS[held.reason]}
                  </span>
                  <span className="text-xs wallet-muted">
                    {held.user_reversible
                      ? 'Not spendable until you unfreeze it'
                      : 'Held by a pledge or fusion round — released by that, not here'}
                  </span>
                </p>
              )}
              {walletId > 0 && isDesktopPlatform() && (
                <p className="flex flex-wrap items-center gap-2">
                  <strong>Coin:</strong>{' '}
                  <button
                    type="button"
                    data-testid={`coin-hold-${okey}`}
                    disabled={Boolean(held) && !held?.user_reversible}
                    className="text-xs underline wallet-muted hover:wallet-text-strong disabled:no-underline disabled:opacity-60"
                    onClick={() =>
                      void toggleHold(utxo.tx_hash, utxo.tx_pos, held)
                    }
                  >
                    {held ? 'Unfreeze' : 'Freeze'}
                  </button>
                </p>
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
                      {utxo.token?.nft ? t('utxo.nft') : t('utxo.ft')}
                    </span>
                  }
                />
              ) : (
                <div className="text-center">
                  <div className="text-base font-semibold wallet-text-strong">
                    {t('utxo.bitcoinCash')}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {holdError && <p className="text-xs text-red-400">{holdError}</p>}

      {!utxos.length && <p className="wallet-muted">{t('utxo.none')}</p>}
    </div>
  );
};

export default UTXOCard;

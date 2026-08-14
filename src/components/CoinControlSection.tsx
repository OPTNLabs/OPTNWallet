// Global coin control for Simple Send (and any other spend surface).
// When off, the wallet auto-picks coins. When on, only checked UTXOs are used.
// Shows local CashFusion depth badges — never on-chain metadata.

import React, { useMemo } from 'react';
import type { UTXO } from '../types/types';
import { SATSINBITCOIN } from '../utils/constants';
import { shortenTxHash } from '../utils/shortenHash';
import { coinDepth } from '../platform/desktop/fusionCoinDepth';
import { useFusionDepthRevision } from '../platform/desktop/useFusionDepthRevision';
import { outpointKey } from '../platform/desktop/CoinLabelService';
import { FusionBadge } from './FusionBadge';

function utxoOutpointKey(utxo: Pick<UTXO, 'tx_hash' | 'tx_pos'>): string {
  return outpointKey(utxo.tx_hash, utxo.tx_pos);
}

function formatBch(sats: number): string {
  if (!Number.isFinite(sats) || sats <= 0) return '0';
  return (sats / SATSINBITCOIN).toFixed(8).replace(/\.?0+$/, '');
}

function utxoSats(u: UTXO): number {
  const raw = u.amount ?? u.value ?? 0;
  if (typeof raw === 'bigint') return Number(raw);
  return Number(raw) || 0;
}

export type CoinControlSectionProps = {
  walletId: number;
  utxos: UTXO[];
  /** When false, auto-select (ignore selection). */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Selected outpoint keys (`txid:pos`). */
  selectedKeys: ReadonlySet<string>;
  onSelectedKeysChange: (next: Set<string>) => void;
  disabled?: boolean;
  /** Compact title for embedding under Send amount. */
  title?: string;
};

export function CoinControlSection({
  walletId,
  utxos,
  enabled,
  onEnabledChange,
  selectedKeys,
  onSelectedKeysChange,
  disabled = false,
  title = 'Coin control',
}: CoinControlSectionProps): React.ReactElement {
  // Re-render when server/P2P fusion stamps depth so "Fused" badges appear live.
  const fusionDepthRev = useFusionDepthRevision(walletId);
  const bchUtxos = useMemo(
    () => utxos.filter((u) => !u.token && !u.token_data),
    [utxos]
  );

  const selectedSats = useMemo(() => {
    let sum = 0;
    for (const u of bchUtxos) {
      if (selectedKeys.has(utxoOutpointKey(u))) sum += utxoSats(u);
    }
    return sum;
  }, [bchUtxos, selectedKeys]);

  const allKeys = useMemo(
    () => bchUtxos.map(utxoOutpointKey),
    [bchUtxos]
  );
  const allSelected =
    allKeys.length > 0 && allKeys.every((k) => selectedKeys.has(k));

  const toggleKey = (key: string) => {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedKeysChange(next);
  };

  const selectAll = () => onSelectedKeysChange(new Set(allKeys));
  const selectNone = () => onSelectedKeysChange(new Set());

  return (
    <div className="wallet-section space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold wallet-text-strong">{title}</div>
          <p className="text-[11px] wallet-muted mt-0.5">
            Off = wallet picks coins. On = only the coins you check are spent
            (and shown with Fused depth when known).
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs wallet-text-strong">
          <span>Manual</span>
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--wallet-accent)]"
            checked={enabled}
            disabled={disabled || bchUtxos.length === 0}
            onChange={(e) => {
              const on = e.target.checked;
              onEnabledChange(on);
              if (on && selectedKeys.size === 0 && allKeys.length > 0) {
                // Start with all coins selected so Max/send still works.
                onSelectedKeysChange(new Set(allKeys));
              }
            }}
          />
        </label>
      </div>

      {enabled && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className="wallet-muted">
              {selectedKeys.size}/{bchUtxos.length} coins ·{' '}
              {formatBch(selectedSats)} BCH selected
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                className="wallet-link underline disabled:opacity-50"
                disabled={disabled || allSelected}
                onClick={selectAll}
              >
                All
              </button>
              <button
                type="button"
                className="wallet-link underline disabled:opacity-50"
                disabled={disabled || selectedKeys.size === 0}
                onClick={selectNone}
              >
                None
              </button>
            </span>
          </div>

          {bchUtxos.length === 0 ? (
            <p className="text-xs wallet-muted">No spendable BCH coins.</p>
          ) : (
            <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-[var(--wallet-border)] p-2">
              {bchUtxos.map((u) => {
                const key = utxoOutpointKey(u);
                const checked = selectedKeys.has(key);
                // fusionDepthRev: re-read after localStorage depth write
                void fusionDepthRev;
                const depth = walletId > 0 ? coinDepth(walletId, key) : 0;
                const sats = utxoSats(u);
                const pending =
                  typeof u.height === 'number' ? u.height <= 0 : false;
                return (
                  <label
                    key={key}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2 py-1.5 text-xs ${
                      checked
                        ? 'border-[var(--wallet-accent)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_35%,transparent)]'
                        : 'border-[var(--wallet-border)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--wallet-accent)]"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleKey(key)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold wallet-text-strong">
                          {formatBch(sats)} BCH
                        </span>
                        {depth > 0 && <FusionBadge depth={depth} />}
                        {pending && (
                          <span className="wallet-muted">unconfirmed</span>
                        )}
                      </span>
                      <span className="block font-mono wallet-muted truncate">
                        {shortenTxHash(u.tx_hash)}:{u.tx_pos}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default CoinControlSection;

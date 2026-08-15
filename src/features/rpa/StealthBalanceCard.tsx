// Stealth BCH balance card — shown on Assets when RPA is enabled.
// Scans a Fulcrum-RPA capable server for incoming RPA payments using the
// recipient's paycode as a prefix filter. No notification transactions —
// BCH RPA hides detectability inside the sender's signature nonce.

import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { selectRpaEnabled } from '../../state/slices/experimentalSlice';
import type { RootState } from '../../state/store';
import {
  claimRpaTransaction,
  syncWalletSpecialActivities,
  type RpaActivityPayload,
} from '../../services/WalletSpecialActivityService';
import { SATSINBITCOIN } from '../../utils/constants';
import { useI18n } from '../../i18n/useI18n';
import { formatDate, formatNumber } from '../../i18n/format';

type StealthBalanceCardProps = {
  walletId: number;
};

export const StealthBalanceCard: React.FC<StealthBalanceCardProps> = ({
  walletId,
}) => {
  const { locale, t } = useI18n();
  const rpaEnabled = useSelector(selectRpaEnabled);
  const storedActivity = useSelector(
    (state: RootState) =>
      state.walletSpecialActivity.byWallet[walletId]?.rpa ?? null
  );

  const [stealthSats, setStealthSats] = useState<number>(0);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [serverNote, setServerNote] = useState<string | null>(null);
  const [txidInput, setTxidInput] = useState('');
  const [checking, setChecking] = useState(false);

  const applyActivity = useCallback(
    (activity: RpaActivityPayload, updatedAt?: string) => {
      setStealthSats(activity.unspentSats);
      setMatchCount(activity.detectedPaymentCount);
      setLastSynced(
        updatedAt
          ? formatDate(new Date(updatedAt), locale, {
              hour: 'numeric',
              minute: '2-digit',
            })
          : null
      );
      setServerNote(
        activity.serverSupported
          ? null
          : activity.error ?? t('rpa.serverUnsupported')
      );
    },
    [locale, t]
  );

  useEffect(() => {
    if (
      storedActivity?.activityType === 'rpa' &&
      'unspentSats' in storedActivity.payload
    ) {
      applyActivity(storedActivity.payload, storedActivity.updatedAt);
    }
  }, [applyActivity, storedActivity]);

  const handleSync = useCallback(async () => {
    if (syncing) return;

    setSyncing(true);
    setSyncError(null);

    try {
      const records = await syncWalletSpecialActivities({
        walletId,
        activityTypes: ['rpa'],
      });
      const activity = records[0];
      if (
        activity?.activityType === 'rpa' &&
        'unspentSats' in activity.payload
      ) {
        applyActivity(activity.payload, activity.updatedAt);
      }
    } catch (err) {
      setSyncError(
        `Sync failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSyncing(false);
    }
  }, [applyActivity, syncing, walletId]);

  const handleCheckTxid = useCallback(async () => {
    if (checking) return;
    const txid = txidInput.trim();
    if (!txid) {
      setSyncError('Paste the sender transaction id, then tap Check.');
      return;
    }

    setChecking(true);
    setSyncError(null);
    try {
      const record = await claimRpaTransaction({ walletId, txid });
      if (record.activityType === 'rpa' && 'unspentSats' in record.payload) {
        applyActivity(record.payload, record.updatedAt);
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }, [applyActivity, checking, txidInput, walletId]);

  if (!rpaEnabled) return null;

  const stealthBch = stealthSats / SATSINBITCOIN;

  return (
    <div className="rounded-xl border border-[var(--wallet-accent)]/20 bg-[var(--wallet-surface)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold wallet-text-strong">
              {t('rpa.stealthBalance')}
            </span>
            <span className="rounded-full border border-[var(--wallet-accent)]/30 bg-[var(--wallet-accent)]/10 px-1.5 py-0.5 text-[9px] font-bold text-[var(--wallet-accent)] uppercase tracking-wide">
              RPA
            </span>
          </div>
          <div className="text-xl font-bold wallet-text-strong mt-0.5">
            {formatNumber(stealthBch, locale, { maximumFractionDigits: 8 })} BCH
          </div>
          {matchCount !== null && (
            <div className="text-xs wallet-muted mt-0.5">
              {t('rpa.confirmedPayments', { count: matchCount })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={syncing}
          className="rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--wallet-accent)] disabled:opacity-50 hover:bg-[var(--wallet-accent)]/5 transition-colors"
        >
          {syncing ? t('rpa.scanning') : t('rpa.sync')}
        </button>
      </div>

      {syncError && <p className="text-xs text-red-400">{syncError}</p>}

      {serverNote && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
          <p className="text-[10px] text-yellow-300 leading-relaxed">
            {serverNote}
          </p>
        </div>
      )}

      {lastSynced && !syncError && (
        <p className="text-[10px] wallet-muted">
          {t('rpa.lastScanned')}: {lastSynced}
        </p>
      )}

      <div className="space-y-1.5">
        <label className="block text-[10px] wallet-muted">
          Chipnet Electrum cannot find paycode payments. Paste the sender txid:
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={txidInput}
            onChange={(event) => setTxidInput(event.target.value)}
            placeholder="64-character transaction id"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-[var(--wallet-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] wallet-text-strong"
          />
          <button
            type="button"
            onClick={() => void handleCheckTxid()}
            disabled={checking || syncing}
            className="rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--wallet-accent)] disabled:opacity-50 hover:bg-[var(--wallet-accent)]/5 transition-colors"
          >
            {checking ? 'Checking…' : 'Check'}
          </button>
        </div>
      </div>

      <p className="text-[10px] wallet-muted leading-relaxed">
        Sync uses Fulcrum RPA (blockchain.rpa.get_history). On Chipnet that is
        chipnet.bch.ninja. If Sync is empty, switch Servers to that host, or
        Check the sender txid below.
      </p>
    </div>
  );
};

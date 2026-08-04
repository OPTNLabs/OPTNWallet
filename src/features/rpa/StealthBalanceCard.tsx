// Stealth BCH balance card — shown on Assets when RPA is enabled.
// Scans a Fulcrum-RPA capable server for incoming RPA payments using the
// recipient's paycode as a prefix filter. No notification transactions —
// BCH RPA hides detectability inside the sender's signature nonce.

import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { selectRpaEnabled } from '../../state/slices/experimentalSlice';
import type { RootState } from '../../state/store';
import {
  loadStoredWalletSpecialActivities,
  syncWalletSpecialActivities,
  type RpaActivityPayload,
} from '../../services/WalletSpecialActivityService';
import { SATSINBITCOIN } from '../../utils/constants';
import { useI18n } from '../../i18n/useI18n';

type StealthBalanceCardProps = {
  walletId: number;
};

export const StealthBalanceCard: React.FC<StealthBalanceCardProps> = ({
  walletId,
}) => {
  const { t } = useI18n();
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

  const applyActivity = useCallback(
    (activity: RpaActivityPayload, updatedAt?: string) => {
      setStealthSats(activity.unspentSats);
      setMatchCount(activity.detectedPaymentCount);
      setLastSynced(
        updatedAt ? new Date(updatedAt).toLocaleTimeString() : null
      );
      setServerNote(
        activity.serverSupported
          ? null
          : activity.error ?? t('rpa.serverUnsupported')
      );
    },
    [t]
  );

  useEffect(() => {
    void loadStoredWalletSpecialActivities(walletId).catch((error) => {
      console.warn('Failed to load stored RPA activity:', error);
    });
  }, [walletId]);

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
    setServerNote(null);

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
            {stealthBch.toFixed(8)} BCH
          </div>
          {matchCount !== null && (
            <div className="text-xs wallet-muted mt-0.5">
              {t('rpa.confirmedPayments', {
                count: matchCount,
                suffix: matchCount !== 1 ? 's' : '',
              })}
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

      <p className="text-[10px] wallet-muted leading-relaxed">
        {t('rpa.scanDescription')}
      </p>
    </div>
  );
};

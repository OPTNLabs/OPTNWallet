import React from 'react';
import { useSelector } from 'react-redux';

import type { RootState } from '../../state/store';
import { SATSINBITCOIN } from '../../utils/constants';
import { useI18n } from '../../i18n/useI18n';

type CauldronActivityCardProps = {
  walletId: number;
};

export const CauldronActivityCard: React.FC<CauldronActivityCardProps> = ({
  walletId,
}) => {
  const { t } = useI18n();
  const activity = useSelector(
    (state: RootState) =>
      state.walletSpecialActivity.byWallet[walletId]?.cauldron ?? null
  );

  if (
    !activity ||
    activity.status !== 'complete' ||
    activity.activityType !== 'cauldron' ||
    !('positionCount' in activity.payload) ||
    activity.payload.positionCount === 0
  ) {
    return null;
  }

  let totalSats: bigint;
  try {
    totalSats = BigInt(activity.payload.totalSats);
  } catch {
    return null;
  }
  const totalBch = Number(totalSats) / SATSINBITCOIN;
  const tokenCount = Object.keys(
    activity.payload.tokenAmountsByCategory
  ).length;

  return (
    <div className="rounded-xl border border-[var(--wallet-accent)]/20 bg-[var(--wallet-surface)] p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold wallet-text-strong">
              {t('cauldron.positions')}
            </span>
            <span className="rounded-full border border-[var(--wallet-accent)]/30 bg-[var(--wallet-accent)]/10 px-1.5 py-0.5 text-[9px] font-bold text-[var(--wallet-accent)] uppercase tracking-wide">
              DeFi
            </span>
          </div>
          <div className="text-xl font-bold wallet-text-strong mt-0.5">
            {totalBch.toFixed(8)} BCH
          </div>
        </div>
        <div className="text-right text-xs wallet-muted">
          <div>
            {activity.payload.positionCount} {t('cauldron.active')}
          </div>
          <div>
            {tokenCount} {t('cauldron.tokenCategories')}
          </div>
        </div>
      </div>
      <p className="text-[10px] wallet-muted leading-relaxed">
        {t('cauldron.description')}
      </p>
    </div>
  );
};

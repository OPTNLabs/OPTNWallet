import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectMerchantPayDefaultConversionBps,
  setMerchantPayDefaultConversionBps,
} from '../../state/slices/preferencesSlice';
import type { AppDispatch, RootState } from '../../state/store';

function formatPercentage(bps: number): string {
  const percentage = bps / 100;
  return Number.isInteger(percentage)
    ? `${percentage}%`
    : `${percentage.toFixed(2).replace(/0+$/, '')}%`;
}

export const MerchantPaySettings: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const conversionBps = useSelector((state: RootState) =>
    selectMerchantPayDefaultConversionBps(state)
  );

  return (
    <div className="space-y-3">
      <div className="wallet-card rounded-2xl p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold wallet-text-strong">
              Default conversion
            </h2>
            <p className="mt-1 text-xs wallet-muted">
              New Merchant Pay requests start with this percentage. You can
              adjust it for each request.
            </p>
          </div>
          <span className="shrink-0 text-sm font-semibold text-[var(--wallet-accent)]">
            {formatPercentage(conversionBps)}
          </span>
        </div>
        <input
          aria-label="Default Merchant Pay conversion percentage"
          data-testid="merchant-pay-default-conversion-slider"
          type="range"
          min="0"
          max="10000"
          step="1"
          value={conversionBps}
          onChange={(event) =>
            dispatch(
              setMerchantPayDefaultConversionBps(Number(event.target.value))
            )
          }
          className="mt-4 h-2 w-full cursor-pointer accent-emerald-400"
        />
        <div className="mt-1 flex justify-between text-[10px] wallet-muted">
          <span>0% · no conversion</span>
          <span>100% · convert all</span>
        </div>
      </div>
    </div>
  );
};

export default MerchantPaySettings;

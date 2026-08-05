// CashFusion as a first-class App (not a Settings panel).
// Opened from Apps → CashFusion with a normal app chrome + back to Apps.

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import PageHeader from '../components/ui/PageHeader';
import WalletScreen from '../components/ui/WalletScreen';
import { CashFusionSettings } from '../features/settings/CashFusionSettings';
import { selectWalletId } from '../state/slices/walletSlice';
import { getReturnPath } from '../utils/navigation';
import { homeRoute } from '../navigation/routes';

const CashFusionApp: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const walletId = useSelector(selectWalletId);
  const returnTarget = getReturnPath(location, homeRoute(walletId));

  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageHeader
          title="CashFusion"
          subtitle="Private CoinJoin — server or P2P"
          compact
          titleAction={
            <button
              type="button"
              onClick={() => navigate(returnTarget)}
              className="rounded-lg border border-[var(--wallet-border)] px-2.5 py-1 text-xs wallet-muted hover:wallet-text-strong"
            >
              Back
            </button>
          }
        />
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1 pb-4">
          <CashFusionSettings />
        </div>
      </div>
    </WalletScreen>
  );
};

export default CashFusionApp;

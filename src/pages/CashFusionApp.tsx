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
        />
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
          <CashFusionSettings />
        </div>
        <div className="mt-auto shrink-0 pb-2 pt-2">
          <button
            type="button"
            className="wallet-btn-danger w-full py-3 text-base font-semibold shadow-xl"
            onClick={() => navigate(returnTarget)}
          >
            Back
          </button>
        </div>
      </div>
    </WalletScreen>
  );
};

export default CashFusionApp;

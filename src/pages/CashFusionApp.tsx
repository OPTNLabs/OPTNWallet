// CashFusion as a first-class App (not a Settings panel).
// Opened from Apps → CashFusion with a normal app chrome + back to Apps.

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import PageHeader from '../components/ui/PageHeader';
import WalletScreen from '../components/ui/WalletScreen';
import { CashFusionSettings } from '../features/settings/CashFusionSettings';
import { selectWalletId } from '../state/slices/walletSlice';
import { selectCurrentNetwork } from '../state/selectors/networkSelectors';
import { Network } from '../state/slices/networkSlice';
import { getReturnPath } from '../utils/navigation';
import { homeRoute } from '../navigation/routes';
import RouteExitFooter from '../components/ui/RouteExitFooter';

const CashFusionApp: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const walletId = useSelector(selectWalletId);
  const currentNetwork = useSelector(selectCurrentNetwork);
  const returnTarget = getReturnPath(location, homeRoute(walletId));

  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageHeader
          title="CashFusion"
          subtitle={currentNetwork === Network.CHIPNET ? 'Chipnet' : undefined}
          compact
        />
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
          <CashFusionSettings />
        </div>
        <RouteExitFooter label="Back" onBack={() => navigate(returnTarget)} />
      </div>
    </WalletScreen>
  );
};

export default CashFusionApp;

// src/pages/RootHandler.tsx

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectHasWallet, selectWalletId } from '../state/slices/walletSlice';
import { homeRoute, ROUTE_PATHS } from '../navigation/routes';

const RootHandler = () => {
  const navigate = useNavigate();
  const walletId = useSelector(selectWalletId);
  const hasWallet = useSelector(selectHasWallet);

  useEffect(() => {
    if (hasWallet) {
      navigate(homeRoute(walletId), { replace: true });
      return;
    }
    navigate(ROUTE_PATHS.landing, { replace: true });
  }, [hasWallet, navigate, walletId]);

  return null; // Render nothing since navigation handles redirection
};

export default RootHandler;

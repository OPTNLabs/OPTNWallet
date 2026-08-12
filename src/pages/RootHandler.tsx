// src/pages/RootHandler.tsx

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectHasWallet, selectWalletId } from '../redux/walletSlice';

const RootHandler = () => {
  const navigate = useNavigate();
  const walletId = useSelector(selectWalletId);
  const hasWallet = useSelector(selectHasWallet);

  useEffect(() => {
    if (hasWallet) {
      navigate(`/home/${walletId}`, { replace: true });
      return;
    }
    navigate('/landing', { replace: true });
  }, [hasWallet, navigate, walletId]);

  return null; // Render nothing since navigation handles redirection
};

export default RootHandler;

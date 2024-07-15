import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { setWalletId } from '../redux/walletSlice';
import WalletManager from '../apis/WalletManager/WalletManager';
import LandingPage from './LandingPage';

const RootHandler = () => {
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const dispatch = useDispatch();

  useEffect(() => {
    const checkExistingWallet = async () => {
      console.log('Checking for existing wallet...');
      const walletManager = WalletManager();
      const walletId = await walletManager.walletExists();

      if (walletId) {
        console.log(`Wallet found with ID: ${walletId}`);
        dispatch(setWalletId(walletId));
        setLoading(false); // Wallet found, stop loading
        navigate(`/home/${walletId}`);
      } else {
        console.log('No wallet found.');
        setLoading(false); // No wallet found, stop loading
      }
    };

    checkExistingWallet();
  }, [dispatch, navigate]);

  if (loading) {
    return <div>Loading...</div>;
  }

  return <LandingPage />;
};

export default RootHandler;

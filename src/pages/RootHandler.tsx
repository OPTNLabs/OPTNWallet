import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { setWalletId } from '../redux/walletSlice';
// import WalletManager from '../apis/WalletManager/WalletManager';
import { RootState } from '../redux/store';

const RootHandler = () => {
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  useEffect(() => {
    const checkExistingWallet = async () => {
      console.log('Checking for existing wallet...');

      if (walletId === 1) {
        console.log(`Wallet found with ID: ${walletId}`);
        dispatch(setWalletId(walletId));
        navigate(`/home/${walletId}`);
      } else {
        console.log('No wallet found.');
        navigate('/landing'); // Redirect to the landing page if no wallet is found
      }

      setLoading(false); // Set loading to false after navigation
    };

    checkExistingWallet();
  }, [dispatch, navigate]);

  if (loading) {
    return <div>Loading...</div>;
  }

  return null; // Render nothing since navigation handles redirection
};

export default RootHandler;

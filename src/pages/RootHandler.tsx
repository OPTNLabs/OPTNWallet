// src/pages/RootHandler.tsx

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { setWalletId } from '../redux/walletSlice';
import { RootState } from '../redux/store';
import WalletManager from '../apis/WalletManager/WalletManager'; // Ensure correct import based on export

const RootHandler = () => {
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  useEffect(() => {
    const checkExistingWallet = async () => {
      // console.log(`Current walletId: ${walletId}`);

      try {
        if (walletId === 1) {
          // Wallet with ID 1 exists, navigate to home
          dispatch(setWalletId(walletId));
          navigate(`/home/${walletId}`);
        } else if (walletId > 1) {
          // Delete wallets with wallet_id >= 2 up to walletId
          for (let index = 2; index <= walletId + 1; index++) {
            try {
              // Adjust the following line based on WalletManager's export structure
              const success = await WalletManager().deleteWallet(index);
              // If WalletManager exports deleteWallet directly:
              // const success = await deleteWallet(index);
              if (!success) {
                console.error(`Failed to delete wallet with ID: ${index}`);
              }
            } catch (deleteError) {
              console.error(
                `Error deleting wallet with ID: ${index}`,
                deleteError
              );
            }
          }
          navigate('/landing');
        } else {
          // No wallet exists, navigate to landing
          console.error(`No valid wallet found. walletId: ${walletId}`);
          navigate('/landing'); // Redirect to the landing page if no wallet is found
        }
      } catch (error) {
        console.error(`Error during wallet check:`, error);
        navigate('/landing'); // Redirect to the landing page in case of error
      } finally {
        setLoading(false); // Set loading to false after navigation
      }
    };

    checkExistingWallet();
  }, [dispatch, navigate, walletId]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        {/* Replace this with a spinner or a better loading indicator */}
        <p>Loading...</p>
      </div>
    );
  }

  return null; // Render nothing since navigation handles redirection
};

export default RootHandler;

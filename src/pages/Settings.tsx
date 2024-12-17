// src/pages/Settings.tsx

import { useState, useEffect } from 'react';
import RecoveryPhrase from '../components/RecoveryPhrase';
import AboutView from '../components/AboutView';
import TermsOfUse from '../components/TermsOfUse';
import ContactUs from '../components/ContactUs';
import { useDispatch, useSelector } from 'react-redux';
import { resetWallet, setWalletId } from '../redux/walletSlice';
import { resetUTXOs } from '../redux/utxoSlice';
import WalletManager from '../apis/WalletManager/WalletManager';
import { useNavigate } from 'react-router-dom';
import { resetTransactions } from '../redux/transactionSlice';
import NetworkSettingsView from '../components/NetworkSettingsView';
import { resetContract } from '../redux/contractSlice';
import { Network, resetNetwork } from '../redux/networkSlice';
import { clearTransaction } from '../redux/transactionBuilderSlice';
import { RootState } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';

const Settings = () => {
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const [selectedOption, setSelectedOption] = useState('');
  const [navBarHeight, setNavBarHeight] = useState(0);
  const dispatch = useDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    const navBar = document.getElementById('bottomNavBar');
    if (navBar) {
      setNavBarHeight(navBar.offsetHeight);
    }
  }, []);

  const handleOptionClick = (option: string) => {
    setSelectedOption(option);
  };

  const handleLogout = async () => {
    const walletManager = WalletManager();
    await walletManager.deleteWallet(currentWalletId); // Clear the entire database
    await walletManager.clearAllData(); // Clear the entire database
    dispatch(setWalletId(0)); // Reset wallet ID in Redux store
    dispatch(resetUTXOs()); // Reset UTXOs in Redux store
    dispatch(resetTransactions()); // Reset transactions in Redux store
    dispatch(resetWallet());
    dispatch(resetContract());
    dispatch(resetNetwork());
    dispatch(clearTransaction());
    navigate('/');
  };

  const renderContent = () => {
    switch (selectedOption) {
      case 'recovery':
        return <RecoveryPhrase />;
      case 'about':
        return <AboutView />;
      case 'terms':
        return <TermsOfUse />;
      case 'contact':
        return <ContactUs />;
      case 'network':
        return <NetworkSettingsView />;
      default:
        return null;
    }
  };

  const renderTitle = () => {
    switch (selectedOption) {
      case 'recovery':
        return 'Recovery Phrase';
      case 'about':
        return 'About';
      case 'terms':
        return 'Terms of Use';
      case 'contact':
        return 'Contact Us';
      case 'network':
        return 'Network';
      default:
        return '';
    }
  };

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>
      <h1 className="text-2xl font-bold mb-4 text-center">Settings</h1>
      {!selectedOption ? (
        <div className="mb-4">
          <button
            onClick={() => handleOptionClick('recovery')}
            className="block w-full py-2 px-4 border rounded-lg mb-2 mx-2"
          >
            Recovery Phrase
          </button>
          <button
            onClick={() => handleOptionClick('about')}
            className="block w-full py-2 px-4 border rounded-lg mb-2 mx-2"
          >
            About
          </button>
          <button
            onClick={() => handleOptionClick('terms')}
            className="block w-full py-2 px-4 border rounded-lg mb-2 mx-2"
          >
            Terms of Use
          </button>
          <button
            onClick={() => handleOptionClick('contact')}
            className="block w-full py-2 px-4 border rounded-lg mb-2 mx-2"
          >
            Contact Us
          </button>
          {currentNetwork === Network.CHIPNET && (
            <button
              onClick={() => handleOptionClick('network')}
              className="block w-full py-2 px-4 border rounded-lg mb-2 mx-2"
            >
              Faucet
            </button>
          )}
          <button
            onClick={handleLogout}
            className="block w-full py-2 px-4 border rounded-lg mb-2 mx-2 bg-red-500 text-white text-xl font-bold"
          >
            Log Out
          </button>
        </div>
      ) : (
        <div
          className="fixed inset-0 bg-white p-4 z-50 overflow-hidden"
          style={{
            height: `calc(100vh - ${navBarHeight}px)`,
            // paddingBottom: `${navBarHeight}px`,
          }}
        >
          <div className="container mx-auto p-4">
            <h2 className="text-3xl text-center font-bold">{renderTitle()}</h2>
          </div>
          {renderContent()}
          <button
            className="block w-full text-center text-xl font-bold py-2 px-4 border rounded-lg m-2 mx-2 bg-red-500 text-white"
            onClick={() => setSelectedOption('')}
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
};

export default Settings;

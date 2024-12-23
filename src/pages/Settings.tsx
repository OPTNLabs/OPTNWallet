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
import { resetContract } from '../redux/contractSlice';
import { Network, resetNetwork } from '../redux/networkSlice';
import { clearTransaction } from '../redux/transactionBuilderSlice';
import { RootState } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import FaucetView from '../components/FaucetView';
import ContractDetails from '../components/ContractDetails';

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
        return <FaucetView />;
      case 'ContractDetails':
        return <ContractDetails />;
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
      case 'ContractDetails':
        return 'Contract Description';
      default:
        return '';
    }
  };

  return (
    <div className="container mx-auto p-4">
      {/* Welcome Image */}
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>

      {/* Settings Title */}
      <h1 className="text-2xl font-bold mb-4 text-center">Settings</h1>

      {/* Options Menu */}
      {!selectedOption ? (
        <div className="flex flex-col items-center space-y-4">
          <button
            onClick={() => handleOptionClick('recovery')}
            className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 text-white font-bold py-2 px-4 border rounded-lg"
          >
            Recovery Phrase
          </button>
          <button
            onClick={() => handleOptionClick('about')}
            className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 text-white font-bold py-2 px-4 border rounded-lg"
          >
            About
          </button>
          <button
            onClick={() => handleOptionClick('terms')}
            className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 text-white font-bold py-2 px-4 border rounded-lg"
          >
            Terms of Use
          </button>
          <button
            onClick={() => handleOptionClick('contact')}
            className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 text-white font-bold py-2 px-4 border rounded-lg"
          >
            Contact Us
          </button>
          <button
            onClick={() => handleOptionClick('ContractDetails')}
            className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 text-white font-bold py-2 px-4 border rounded-lg"
          >
            Contract Info
          </button>
          {currentNetwork === Network.CHIPNET && (
            <button
              onClick={() => handleOptionClick('network')}
              className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 text-white font-bold py-2 px-4 border rounded-lg"
            >
              Faucet
            </button>
          )}
          <button
            onClick={handleLogout}
            className="w-full max-w-md py-2 px-4 border rounded-lg bg-red-500 hover:bg-red-700 transition duration-300 text-white text-xl font-bold"
          >
            Log Out
          </button>
        </div>
      ) : (
        /* Overlay for Selected Option */
        <div
          className="fixed inset-0 bg-white p-4 z-50 overflow-auto"
          style={{
            height: `calc(100vh - ${navBarHeight}px)`,
          }}
        >
          <div className="container mx-auto p-4">
            <h2 className="text-3xl text-center font-bold">{renderTitle()}</h2>
          </div>
          {renderContent()}
          <button
            className="w-full max-w-md py-2 px-4 border rounded-lg bg-red-500 hover:bg-red-700 transition duration-300 text-white text-xl font-bold"
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

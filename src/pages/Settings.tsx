import React, { useState, useEffect, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, AppDispatch } from '../redux/store';
import { useNavigate } from 'react-router-dom';
import SessionProposalModal from '../components/walletconnect/SessionProposalModal';
import WcConnectionManager from '../components/WcConnectionManager';
import { SessionList } from '../components/walletconnect/SessionList';
import WalletManager from '../apis/WalletManager/WalletManager';
import { resetWallet, setWalletId } from '../redux/walletSlice';
import { resetUTXOs } from '../redux/utxoSlice';
import { resetTransactions } from '../redux/transactionSlice';
import { resetContract } from '../redux/contractSlice';
import { resetNetwork } from '../redux/networkSlice';
import { clearTransaction } from '../redux/transactionBuilderSlice';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import FaucetView from '../components/FaucetView';
import ContractDetails from '../components/ContractDetails';
import RecoveryPhrase from '../components/RecoveryPhrase';
import AboutView from '../components/AboutView';
import TermsOfUse from '../components/TermsOfUse';
import ContactUs    from '../components/ContactUs';
import { disconnectSession } from '../redux/walletconnectSlice';
import SessionSettingsModal from '../components/walletconnect/SessionSettingsModal';

const Settings: React.FC = () => {
  const navigate = useNavigate();
  // Use AppDispatch here so that our dispatch is properly typed.
  const dispatch = useDispatch<AppDispatch>();
  const currentWalletId = useSelector((state: RootState) => state.wallet_id.currentWalletId);
  const currentNetwork = useSelector((state: RootState) => selectCurrentNetwork(state));
  const walletconnectActiveSessions = useSelector((state: RootState) => state.walletconnect.activeSessions);

  const [selectedOption, setSelectedOption] = useState('');
  const [navBarHeight, setNavBarHeight] = useState(0);
  const [selectedSessionForSettings, setSelectedSessionForSettings] = useState<string | null>(null);

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
    await walletManager.deleteWallet(currentWalletId);
    await walletManager.clearAllData();
    dispatch(setWalletId(0));
    dispatch(resetUTXOs());
    dispatch(resetTransactions());
    dispatch(resetWallet());
    dispatch(resetContract());
    dispatch(resetNetwork());
    dispatch(clearTransaction());
    navigate('/');
  };

  const handleDeleteSession = useCallback((topic: string) => {
    dispatch(disconnectSession(topic));
  }, [dispatch]);

  const handleOpenSettings = useCallback((topic: string) => {
    setSelectedSessionForSettings(topic);
  }, []);

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
      case 'ContractDetails':
        return <ContractDetails />;
      case 'network':
        return <FaucetView />;
      case 'walletconnect':
        return (
          <div className="p-4">
            <h2 className="text-3xl text-center font-bold mb-4">WalletConnect</h2>
            <WcConnectionManager />
            <SessionProposalModal />
            <SessionList
              activeSessions={walletconnectActiveSessions}
              onDeleteSession={handleDeleteSession}
              onOpenSettings={handleOpenSettings}
            />
          </div>
        );
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
      case 'ContractDetails':
        return 'Contract Info';
      case 'network':
        return 'Network';
      case 'walletconnect':
        return 'WalletConnect';
      default:
        return '';
    }
  };

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-center mt-4">
        <img src="/assets/images/OPTNWelcome1.png" alt="Welcome" className="max-w-full h-auto" />
      </div>
      <h1 className="text-2xl font-bold mb-4 text-center">Settings</h1>
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
          {currentNetwork === "chipnet" && (
            <button
              onClick={() => handleOptionClick('network')}
              className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 text-white font-bold py-2 px-4 border rounded-lg"
            >
              Faucet
            </button>
          )}
          <button
            onClick={() => handleOptionClick('walletconnect')}
            className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 text-white font-bold py-2 px-4 border rounded-lg"
          >
            WalletConnect
          </button>
          <button
            onClick={handleLogout}
            className="w-full max-w-md py-2 px-4 border rounded-lg bg-red-500 hover:bg-red-700 transition duration-300 text-white text-xl font-bold"
          >
            Log Out
          </button>
        </div>
      ) : (
        <div
          className="fixed inset-0 bg-white p-4 z-50 overflow-auto"
          style={{ height: `calc(100vh - ${navBarHeight}px)` }}
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
      {selectedSessionForSettings && (
        <SessionSettingsModal sessionTopic={selectedSessionForSettings} onClose={() => setSelectedSessionForSettings(null)} />
      )}
    </div>
  );
};

export default Settings;

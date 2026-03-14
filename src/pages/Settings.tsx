// src/pages/Settings.tsx

import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, AppDispatch } from '../redux/store';
import { useNavigate } from 'react-router-dom';
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
import ContactUs from '../components/ContactUs';
import WalletConnectPanel from '../components/walletconnect/WalletConnectPanel';
import getElectrumAdapter from '../services/ElectrumAdapter';
import { useTheme } from '../context/useTheme';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';

const Settings: React.FC = () => {
  const navigate = useNavigate();
  const { mode, toggleMode } = useTheme();
  // Use AppDispatch to type dispatch correctly for thunks.
  const dispatch = useDispatch<AppDispatch>();
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  const [selectedOption, setSelectedOption] = useState('');

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
    // Ensure Electrum is fully disconnected before nuking state
    try {
      const electrum = getElectrumAdapter();
      await electrum.disconnect();
    } catch (e) {
      console.warn('[Settings] Electrum disconnect (on logout) warning:', e);
    }
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
      case 'ContractDetails':
        return <ContractDetails />;
      case 'network':
        return <FaucetView />;
      case 'walletconnect':
        return <WalletConnectPanel />;
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
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-3 flex flex-col overflow-hidden wallet-page">
      <PageHeader title="Settings" compact />
      {!selectedOption ? (
        <SectionCard className="flex-1 min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div className="flex flex-col items-center space-y-3">
                <button
                  onClick={toggleMode}
                  className="wallet-btn-secondary w-full max-w-md"
                >
                  Theme: {mode === 'dark' ? 'Dark' : 'Light'} (tap to switch)
                </button>
                <button
                  onClick={() => handleOptionClick('recovery')}
                  className="wallet-btn-primary w-full max-w-md"
                >
                  Recovery Phrase
                </button>
                <button
                  onClick={() => handleOptionClick('about')}
                  className="wallet-btn-primary w-full max-w-md"
                >
                  About
                </button>
                <button
                  onClick={() => handleOptionClick('terms')}
                  className="wallet-btn-primary w-full max-w-md"
                >
                  Terms of Use
                </button>
                <button
                  onClick={() => handleOptionClick('contact')}
                  className="wallet-btn-primary w-full max-w-md"
                >
                  Contact Us
                </button>
                <button
                  onClick={() => handleOptionClick('ContractDetails')}
                  className="wallet-btn-primary w-full max-w-md"
                >
                  Contract Info
                </button>
                {currentNetwork === 'chipnet' && (
                  <button
                    onClick={() => handleOptionClick('network')}
                    className="wallet-btn-primary w-full max-w-md"
                  >
                    Faucet
                  </button>
                )}
                <button
                  onClick={() => handleOptionClick('walletconnect')}
                  className="wallet-btn-primary w-full max-w-md"
                >
                  WalletConnect
                </button>
                <button
                  onClick={handleLogout}
                  className="wallet-btn-danger w-full max-w-md text-xl"
                >
                  Log Out
                </button>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : (
        <SectionCard className="flex-1 min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
            <div className="mb-4 flex justify-between items-center shrink-0">
              <h2 className="text-2xl font-bold wallet-text-strong">
                {renderTitle()}
              </h2>
              <button
                className="wallet-btn-secondary text-sm px-3 py-1.5"
                onClick={() => setSelectedOption('')}
              >
                Back
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              {renderContent()}
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  );
};

export default Settings;

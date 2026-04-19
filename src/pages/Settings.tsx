// src/pages/Settings.tsx

import React, { useRef, useState } from 'react';
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
import WizardConnectPanel from '../components/wizardconnect/WizardConnectPanel';
import { disconnectAllWizardConnections } from '../redux/wizardconnectSlice';
import getElectrumAdapter from '../services/ElectrumAdapter';
import { useTheme } from '../context/useTheme';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import { MdSunny, MdModeNight } from 'react-icons/md';
import Popup from '../components/transaction/Popup';
import Draggable from 'react-draggable';

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
  const [isLogoutPopupOpen, setIsLogoutPopupOpen] = useState(false);
  const [logoutPosition, setLogoutPosition] = useState({ x: 0, y: 0 });
  const logoutNodeRef = useRef<HTMLDivElement | null>(null);
  const logoutSliderWidth = 200;
  const logoutHandleWidth = 48;
  const logoutThreshold = logoutSliderWidth * 0.7;

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
    await dispatch(disconnectAllWizardConnections());
    // Ensure Electrum is fully disconnected before nuking state
    try {
      const electrum = getElectrumAdapter();
      await electrum.disconnect();
    } catch (e) {
      console.warn('[Settings] Electrum disconnect (on logout) warning:', e);
    }
    navigate('/');
  };

  const openLogoutPopup = () => {
    setIsLogoutPopupOpen(true);
  };

  const closeLogoutPopup = () => {
    setIsLogoutPopupOpen(false);
    setLogoutPosition({ x: 0, y: 0 });
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
      case 'wizardconnect':
        return <WizardConnectPanel />;
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
      case 'wizardconnect':
        return 'WizardConnect';
      default:
        return '';
    }
  };

  return (
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-3 flex flex-col overflow-hidden wallet-page">
      <PageHeader
        title="Settings"
        compact
        titleAction={
          <button
            onClick={toggleMode}
            className="flex items-center gap-2 rounded-full wallet-surface-strong border border-[var(--wallet-border)] px-2 py-1.5 text-sm font-semibold wallet-text-strong whitespace-nowrap"
            aria-label="Toggle theme"
          >
            <MdSunny className="text-[12px] wallet-muted" />
            <span
              className={`relative inline-flex h-5 w-10 items-center rounded-full border transition-colors ${
                mode === 'dark'
                  ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                  : 'wallet-surface border-[var(--wallet-border)]'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  mode === 'dark' ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
            <MdModeNight className="text-[12px] wallet-muted" />
          </button>
        }
      />
      {!selectedOption ? (
        <SectionCard className="flex-1 min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col gap-3">
            {currentNetwork === 'chipnet' && (
              <button
                onClick={() => handleOptionClick('network')}
                className="wallet-btn-primary wallet-btn-primary-blue w-full shadow-[0_0_0_1px_rgba(255,255,255,0.04)]"
              >
                Faucet
              </button>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-3 auto-rows-fr content-start">
                <button
                  onClick={() => handleOptionClick('recovery')}
                  className="wallet-btn-primary w-full h-full"
                >
                  Recovery Phrase
                </button>
                <button
                  onClick={() => handleOptionClick('about')}
                  className="wallet-btn-primary w-full h-full"
                >
                  About
                </button>
                <button
                  onClick={() => handleOptionClick('terms')}
                  className="wallet-btn-primary w-full h-full"
                >
                  Terms of Use
                </button>
                <button
                  onClick={() => handleOptionClick('contact')}
                  className="wallet-btn-primary w-full h-full"
                >
                  Contact Us
                </button>
                <button
                  onClick={() => handleOptionClick('ContractDetails')}
                  className="wallet-btn-primary w-full h-full"
                >
                  Contract Info
                </button>
                <button
                  onClick={() => handleOptionClick('walletconnect')}
                  className="wallet-btn-primary w-full h-full"
                >
                  WalletConnect
                </button>
                <button
                  onClick={() => handleOptionClick('wizardconnect')}
                  className="wallet-btn-primary w-full h-full"
                >
                  WizardConnect
                </button>
              </div>
            </div>
            <button
              onClick={openLogoutPopup}
              className="wallet-btn-danger w-full text-xl"
            >
              Log Out
            </button>
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
      {isLogoutPopupOpen && (
        <Popup closePopups={closeLogoutPopup} closeButtonText="Back">
          <div className="flex flex-col items-center p-4">
            <h2 className="text-2xl font-bold mb-4">Confirm Logout</h2>
            <p className="font-bold text-xl mb-6 text-center wallet-danger-text">
              ⚠️ Warning
            </p>
            <p className="font-semibold text-sm text-center mb-6 wallet-danger-text">
              You are about to log out of this wallet. This will clear the
              current session and disconnect active services.
            </p>
            <div className="relative w-[200px] h-12 wallet-surface-strong rounded-lg overflow-hidden border border-[var(--wallet-border)]">
              <div
                className={`absolute top-0 left-0 h-full transition-all duration-300 ${
                  logoutPosition.x >= logoutThreshold
                    ? 'wallet-danger-fill'
                    : logoutPosition.x > 0
                      ? 'bg-[var(--wallet-danger-bg)]'
                      : 'wallet-danger-fill'
                }`}
                style={{ width: `${logoutPosition.x}px` }}
              />
              <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold z-10 pointer-events-none">
                Drag to Confirm
              </div>
              <Draggable
                nodeRef={logoutNodeRef}
                axis="x"
                position={logoutPosition}
                onDrag={(e, data) => {
                  void e;
                  setLogoutPosition({ x: data.x, y: 0 });
                }}
                onStop={(e, data) => {
                  void e;
                  if (data.x >= logoutThreshold) {
                    closeLogoutPopup();
                    void handleLogout();
                  } else {
                    setLogoutPosition({ x: 0, y: 0 });
                  }
                }}
                bounds={{ left: 0, right: logoutSliderWidth - logoutHandleWidth }}
              >
                <div
                  ref={logoutNodeRef}
                  className="absolute top-0 left-0 z-20 flex h-12 w-12 items-center justify-center rounded-lg wallet-btn-danger cursor-grab active:cursor-grabbing"
                >
                  {logoutPosition.x >= logoutThreshold ? '✅' : '➔'}
                </div>
              </Draggable>
            </div>
          </div>
        </Popup>
      )}
    </div>
  );
};

export default Settings;

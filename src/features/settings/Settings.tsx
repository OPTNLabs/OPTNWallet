import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { MdModeNight, MdSunny } from 'react-icons/md';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { resetWallet, setWalletId } from '../../state/slices/walletSlice';
import { resetUTXOs } from '../../state/slices/utxoSlice';
import { resetTransactions } from '../../state/slices/transactionSlice';
import { resetContract } from '../../state/slices/contractSlice';
import { resetNetwork } from '../../state/slices/networkSlice';
import { clearTransaction } from '../../state/slices/transactionBuilderSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import FaucetView from '../../components/FaucetView';
import ContractDetails from '../../components/ContractDetails';
import RecoveryPhrase from '../../components/RecoveryPhrase';
import AboutView from '../../components/AboutView';
import TermsOfUse from '../../components/TermsOfUse';
import ContactUs from '../../components/ContactUs';
import WalletConnectPanel from '../../components/walletconnect/WalletConnectPanel';
import WizardConnectPanel from '../../components/wizardconnect/WizardConnectPanel';
import { disconnectAllWizardConnections } from '../../state/slices/wizardconnectSlice';
import getElectrumAdapter from '../../services/ElectrumAdapter';
import { useTheme } from '../../app/theme/useTheme';
import PageHeader from '../../components/ui/PageHeader';
import SectionCard from '../../components/ui/SectionCard';
import SectionHeader from '../../components/ui/SectionHeader';
import SettingsRow from '../../components/ui/SettingsRow';
import Popup from '../../components/transaction/Popup';
import WalletScreen from '../../components/ui/WalletScreen';
import { AppDispatch, RootState } from '../../state/store';
import { getReturnPath } from '../../utils/navigation';
import {
  ABOUT_ROWS,
  CONTRACT_ROWS,
  WALLET_ROWS,
  type SettingsRowConfig,
} from './settingsConfig';

const Settings: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { mode, toggleMode } = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  const [selectedOption, setSelectedOption] = useState(() => searchParams.get('panel') ?? '');
  const [isLogoutPopupOpen, setIsLogoutPopupOpen] = useState(false);
  const logoutNodeRef = useRef<HTMLDivElement | null>(null);
  const returnTarget = getReturnPath(location, '');

  useEffect(() => {
    setSelectedOption(searchParams.get('panel') ?? '');
  }, [searchParams]);

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
      case 'contract':
        return <ContractDetails />;
      case 'walletconnect':
        return <WalletConnectPanel />;
      case 'wizardconnect':
        return <WizardConnectPanel />;
      case 'network':
        return currentNetwork === 'chipnet' ? <FaucetView /> : null;
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
      case 'contract':
        return 'Contract Info';
      case 'walletconnect':
        return 'WalletConnect';
      case 'wizardconnect':
        return 'WizardConnect';
      case 'network':
        return 'Network';
      default:
        return '';
    }
  };

  const closeDetails = () => setSelectedOption('');
  const handleRowClick = (row: SettingsRowConfig) => {
    if (row.action === 'panel' && row.target) {
      setSelectedOption(row.target);
      return;
    }

    if (row.action === 'navigate' && row.target) {
      navigate(row.target);
    }
  };

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader title="Settings" compact />
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 -mt-8">
          <div aria-hidden="true" />
          <h1 className="justify-self-center text-[1.6rem] font-bold tracking-[-0.04em] wallet-text-strong">
            Settings
          </h1>
          <button
            onClick={toggleMode}
            className="justify-self-end flex items-center gap-2 rounded-full wallet-surface-strong border border-[var(--wallet-border)] px-2 py-1.5 text-sm font-semibold wallet-text-strong whitespace-nowrap"
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
        </div>

        <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-hidden">
          {!selectedOption ? (
            <SectionCard className="min-h-0 overflow-hidden p-3">
              <div className="flex h-full min-h-0 flex-col gap-4">
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 overflow-y-auto overscroll-contain pr-1">
                  <SectionCard className="p-0">
                    <SectionHeader title="Wallet" compact />
                    <div className="space-y-3">
                      {WALLET_ROWS.map((row) => (
                        <SettingsRow
                          key={row.key}
                          title={row.title}
                          description={row.description}
                          compact
                          right={
                            row.right ? (
                              <span className="wallet-muted">{row.right}</span>
                            ) : undefined
                          }
                          disabled={row.action === 'noop'}
                          onClick={row.action === 'noop' ? undefined : () => handleRowClick(row)}
                        />
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard className="p-0">
                    <SectionHeader title="Contract Tools" compact />
                    <div className="space-y-3">
                      {CONTRACT_ROWS.map((row) => (
                        <SettingsRow
                          key={row.key}
                          title={row.title}
                          description={row.description}
                          compact
                          onClick={row.action === 'noop' ? undefined : () => handleRowClick(row)}
                        />
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard className="p-0">
                    <SectionHeader title="About" compact />
                    <div className="space-y-3">
                      {ABOUT_ROWS.map((row) => (
                        <SettingsRow
                          key={row.key}
                          title={row.title}
                          description={row.description}
                          compact
                          onClick={row.action === 'noop' ? undefined : () => handleRowClick(row)}
                        />
                      ))}
                    </div>
                  </SectionCard>

                  {currentNetwork === 'chipnet' ? (
                    <SectionCard className="p-0">
                      <SectionHeader title="Support" compact />
                      <SettingsRow
                        title="Faucet"
                        description="Request test funds"
                        compact
                        onClick={() => setSelectedOption('network')}
                      />
                    </SectionCard>
                  ) : null}
                </div>

                <button
                  onClick={() => setIsLogoutPopupOpen(true)}
                  className="wallet-btn-danger w-full py-3 text-base"
                >
                  Log Out
                </button>
              </div>
            </SectionCard>
          ) : (
            <>
              <SectionCard className="min-h-0 overflow-hidden">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                    <div className="mb-4 flex items-center justify-between">
                      <h2 className="text-xl font-bold wallet-text-strong">{renderTitle()}</h2>
                    </div>
                    {renderContent()}
                  </div>
                </div>
              </SectionCard>
              <div className="mt-auto pb-2 pt-3">
                <button
                  className="wallet-btn-danger w-full py-3 text-base font-semibold"
                  onClick={() => {
                    if (returnTarget) {
                      navigate(returnTarget);
                      return;
                    }
                    closeDetails();
                  }}
                >
                  Back
                </button>
              </div>
            </>
          )}
        </div>

        {isLogoutPopupOpen && (
          <Popup closePopups={() => setIsLogoutPopupOpen(false)}>
            <div
              ref={logoutNodeRef}
              className="wallet-card mx-auto w-full max-w-md p-4"
            >
              <div className="mb-3 text-center text-sm wallet-muted">
                Confirm logout to remove this wallet from the device.
              </div>
              <button
                className="wallet-btn-danger mt-2 w-full"
                onClick={handleLogout}
              >
                Confirm Logout
              </button>
            </div>
          </Popup>
        )}
      </div>
    </WalletScreen>
  );
};

export default Settings;

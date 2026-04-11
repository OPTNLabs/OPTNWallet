import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '@capacitor/toast';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { setNetwork } from '../../redux/networkSlice';
import { selectCurrentNetwork } from '../../redux/selectors/networkSelectors';
import { setWalletId, setWalletNetwork, setWalletType } from '../../redux/walletSlice';
import KeyService from '../../services/KeyService';
import { WalletType } from '../../types/wallet';
import { ONBOARDING_WALLET_NAME } from './constants';
import InfoTooltipIcon from './components/InfoTooltipIcon';
import OnboardingCard from './components/OnboardingCard';
import OnboardingScreen from './components/OnboardingScreen';
import NetworkSelector from './components/NetworkSelector';

const CreateWalletPage = () => {
  const [mnemonicPhrase, setMnemonicPhrase] = useState('');
  const [passphrase] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const dbService = useMemo(() => DatabaseService(), []);
  const walletManager = useMemo(() => WalletManager(), []);
  const hasInitialized = useRef(false);

  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const dispatch = useDispatch();

  useEffect(() => {
    const initDb = async () => {
      if (hasInitialized.current) return;
      hasInitialized.current = true;

      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) throw new Error('Failed to start the database.');

        const mnemonic = await KeyService.generateMnemonic();
        setMnemonicPhrase(mnemonic);
      } catch (error) {
        console.error('Error initializing wallet creation:', error);
        await Toast.show({ text: 'Could not prepare wallet creation on this device.' });
      }
    };

    void initDb();
  }, [dbService]);

  const handleCreateAccount = async () => {
    if (!mnemonicPhrase.trim()) {
      await Toast.show({ text: 'Mnemonic is still loading. Please wait a moment.' });
      return;
    }

    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const accountExists = await walletManager.checkAccount(
        mnemonicPhrase,
        passphrase,
        { networkType: currentNetwork, walletType: WalletType.STANDARD }
      );
      if (accountExists) {
        console.error('Account already exists.');
        await Toast.show({ text: 'This wallet is already available on this device.' });
        return;
      }

      const created = await walletManager.createWallet(
        ONBOARDING_WALLET_NAME,
        mnemonicPhrase,
        passphrase,
        currentNetwork,
        WalletType.STANDARD
      );
      if (!created) throw new Error('Failed to create wallet in the database.');

      const walletID = await walletManager.setWalletId(
        mnemonicPhrase,
        passphrase,
        { networkType: currentNetwork, walletType: WalletType.STANDARD }
      );
      if (walletID == null) throw new Error('Failed to resolve created wallet ID.');

      const walletInfo = await walletManager.getWalletInfo(walletID);
      const resolvedNetwork =
        walletInfo?.networkType === currentNetwork
          ? currentNetwork
          : walletInfo?.networkType;
      if (!resolvedNetwork) {
        throw new Error('Failed to resolve wallet network.');
      }

      dispatch(setWalletId(walletID));
      dispatch(setWalletNetwork(resolvedNetwork));
      dispatch(setWalletType(walletInfo?.walletType ?? WalletType.STANDARD));
      dispatch(setNetwork(resolvedNetwork));

      navigate(`/home/${walletID}`);
    } catch (error) {
      console.error('Error creating account:', error);
      await Toast.show({ text: 'Wallet creation failed on this device.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const mnemonicWords = mnemonicPhrase ? mnemonicPhrase.split(' ') : [];
  const halfLength = Math.ceil(mnemonicWords.length / 2);

  return (
    <OnboardingScreen>
      <OnboardingCard title="Create Wallet">
        <div className="flex flex-col items-center min-h-[300px]">
          <NetworkSelector networkType={currentNetwork} />

          <div className="wallet-text-strong font-bold text-xl mb-2 flex items-center gap-2">
            <span>Generated Mnemonic:</span>
            <InfoTooltipIcon
              id="mnemonic-tooltip"
              content="Your mnemonic (seed phrase) is the master key to your wallet. Store it securely and never share it; anyone with it can access your funds."
              ariaLabel="Mnemonic information"
            />
          </div>

          {mnemonicPhrase ? (
            <div className="grid grid-cols-2 gap-4 mb-4 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)]">
              <div>
                {mnemonicWords.slice(0, halfLength).map((word, index) => (
                  <div key={index} className="flex items-center mb-2">
                    <span className="w-8 wallet-text-strong font-semibold">{index + 1}.</span>
                    <span className="wallet-text-strong font-semibold">{word}</span>
                  </div>
                ))}
              </div>
              <div>
                {mnemonicWords.slice(halfLength).map((word, index) => (
                  <div key={index + halfLength} className="flex items-center mb-2">
                    <span className="w-8 wallet-text-strong font-semibold">
                      {index + halfLength + 1}.
                    </span>
                    <span className="wallet-text-strong font-semibold">{word}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center mb-4 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong">
              Generating...
            </div>
          )}
        </div>

        <button
          onClick={handleCreateAccount}
          disabled={!mnemonicPhrase.trim() || isSubmitting}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          {isSubmitting ? 'Creating Wallet...' : 'Create Wallet'}
        </button>
        <button
          onClick={() => navigate('/')}
          className="wallet-btn-danger w-full my-2 text-xl font-bold"
        >
          Go Back
        </button>
      </OnboardingCard>
    </OnboardingScreen>
  );
};

export default CreateWalletPage;

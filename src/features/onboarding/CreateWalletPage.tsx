import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '@capacitor/toast';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { Network, setNetwork } from '../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import {
  setWalletId,
  setWalletNetwork,
  setWalletType,
  setWalletDerivationPath,
} from '../../state/slices/walletSlice';
import KeyService from '../../services/KeyService';
import { WalletType } from '../../types/wallet';
import { ONBOARDING_WALLET_NAME } from './constants';
import InfoTooltipIcon from './components/InfoTooltipIcon';
import OnboardingCard from './components/OnboardingCard';
import OnboardingScreen from './components/OnboardingScreen';
import DerivationPathField from './components/DerivationPathField';
import {
  getBchAccountPath,
  normalizeBchAccountPath,
} from '../../services/HdWalletService';
import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import { useI18n } from '../../i18n/useI18n';
import { getBip39LanguageForLocale } from '../../services/Bip39Service';

const CreateWalletPage = () => {
  const currentNetwork = useSelector(selectCurrentNetwork);
  const [mnemonicPhrase, setMnemonicPhrase] = useState('');
  const [passphrase] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [derivationPath, setDerivationPath] = useState(() =>
    getBchAccountPath(currentNetwork)
  );
  const [customDerivationPath, setCustomDerivationPath] = useState(false);

  const dbService = useMemo(() => DatabaseService(), []);
  const walletManager = useMemo(() => WalletManager(), []);
  const hasInitialized = useRef(false);

  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { locale, t } = useI18n();

  useEffect(() => {
    dispatch(setNetwork(Network.MAINNET));
  }, [dispatch]);

  useEffect(() => {
    if (!customDerivationPath)
      setDerivationPath(getBchAccountPath(currentNetwork));
  }, [currentNetwork, customDerivationPath]);

  useEffect(() => {
    const initDb = async () => {
      if (hasInitialized.current) return;
      hasInitialized.current = true;

      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) throw new Error('Failed to start the database.');

        // Warm the connection while the user reviews the recovery phrase so
        // the newly created wallet can begin discovery immediately.
        try {
          await ElectrumServer().ensureFreshConnection();
        } catch (error) {
          console.warn('[CreateWalletPage] Electrum warm-up failed:', error);
        }

        const mnemonic = await KeyService.generateMnemonic(
          getBip39LanguageForLocale(locale)
        );
        setMnemonicPhrase(mnemonic);
      } catch (error) {
        console.error('Error initializing wallet creation:', error);
        await Toast.show({
          text: t('onboarding.databasePreparationFailed'),
        });
      }
    };

    void initDb();
  }, [dbService, locale, t]);

  const handleCreateAccount = async () => {
    if (!mnemonicPhrase.trim()) {
      await Toast.show({
        text: t('onboarding.mnemonicLoading'),
      });
      return;
    }

    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const normalizedDerivationPath = normalizeBchAccountPath(derivationPath);
      const accountExists = await walletManager.checkAccount(
        mnemonicPhrase,
        passphrase,
        { networkType: currentNetwork, walletType: WalletType.STANDARD }
      );
      if (accountExists) {
        console.error('Account already exists.');
        await Toast.show({
          text: t('onboarding.walletAlreadyAvailable'),
        });
        return;
      }

      const created = await walletManager.createWallet(
        ONBOARDING_WALLET_NAME,
        mnemonicPhrase,
        passphrase,
        currentNetwork,
        WalletType.STANDARD,
        normalizedDerivationPath,
        customDerivationPath ? 'custom' : 'default'
      );
      if (!created) throw new Error('Failed to create wallet in the database.');

      const walletID = await walletManager.setWalletId(
        mnemonicPhrase,
        passphrase,
        { networkType: currentNetwork, walletType: WalletType.STANDARD }
      );
      if (walletID == null)
        throw new Error('Failed to resolve created wallet ID.');

      const walletInfo = await walletManager.getWalletInfo(walletID);
      const resolvedNetwork =
        walletInfo?.networkType === currentNetwork
          ? currentNetwork
          : walletInfo?.networkType;
      if (!resolvedNetwork) {
        throw new Error('Failed to resolve wallet network.');
      }

      // Materialize one address pair so the worker can start immediately. It
      // performs the full BIP44 discovery/gap-limit scan after navigation;
      // waiting for all 40 key rows here makes wallet creation unnecessarily slow.
      await KeyService.bootstrapInitialAddressBatch(walletID, 0, 1);

      dispatch(setWalletId(walletID));
      dispatch(setWalletNetwork(resolvedNetwork));
      dispatch(setWalletType(walletInfo?.walletType ?? WalletType.STANDARD));
      dispatch(
        setWalletDerivationPath({
          path: walletInfo?.derivation_path ?? normalizedDerivationPath,
          source:
            walletInfo?.derivation_path_source === 'custom'
              ? 'custom'
              : 'default',
        })
      );
      dispatch(setNetwork(resolvedNetwork));

      navigate(`/home/${walletID}`);
    } catch (error) {
      console.error('Error creating account:', error);
      await Toast.show({ text: t('onboarding.creationFailed') });
    } finally {
      setIsSubmitting(false);
    }
  };

  const mnemonicWords = mnemonicPhrase ? mnemonicPhrase.split(' ') : [];
  const halfLength = Math.ceil(mnemonicWords.length / 2);

  return (
    <OnboardingScreen>
      <OnboardingCard title={t('onboarding.createWallet')}>
        <div className="flex flex-col items-center min-h-[300px]">
          <DerivationPathField
            network={currentNetwork}
            value={derivationPath}
            custom={customDerivationPath}
            onChange={(path, custom) => {
              setDerivationPath(path);
              setCustomDerivationPath(custom);
            }}
          />

          <div className="wallet-text-strong font-bold text-xl mb-2 flex items-center gap-2">
            <span>{t('onboarding.generatedMnemonic')}</span>
            <InfoTooltipIcon
              id="mnemonic-tooltip"
              content={t('onboarding.mnemonicWarning')}
              ariaLabel="Mnemonic information"
            />
          </div>

          {mnemonicPhrase ? (
            <div className="grid grid-cols-2 gap-4 mb-4 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)]">
              <div>
                {mnemonicWords.slice(0, halfLength).map((word, index) => (
                  <div key={index} className="flex items-center mb-2">
                    <span className="w-8 wallet-text-strong font-semibold">
                      {index + 1}.
                    </span>
                    <span className="wallet-text-strong font-semibold">
                      {word}
                    </span>
                  </div>
                ))}
              </div>
              <div>
                {mnemonicWords.slice(halfLength).map((word, index) => (
                  <div
                    key={index + halfLength}
                    className="flex items-center mb-2"
                  >
                    <span className="w-8 wallet-text-strong font-semibold">
                      {index + halfLength + 1}.
                    </span>
                    <span className="wallet-text-strong font-semibold">
                      {word}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center mb-4 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong">
              {t('onboarding.generatingSeed')}
            </div>
          )}
        </div>

        <button
          onClick={handleCreateAccount}
          disabled={!mnemonicPhrase.trim() || isSubmitting}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          {isSubmitting
            ? t('onboarding.creating')
            : t('onboarding.createWallet')}
        </button>
        <button
          onClick={() => navigate('/')}
          className="wallet-btn-danger w-full my-2 text-xl font-bold"
        >
          {t('onboarding.back')}
        </button>
      </OnboardingCard>
    </OnboardingScreen>
  );
};

export default CreateWalletPage;

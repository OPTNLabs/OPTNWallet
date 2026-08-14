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
import { ONBOARDING_WALLET_NAME } from './constants';
import { WalletType } from '../../types/wallet';
import InfoTooltipIcon from './components/InfoTooltipIcon';
import OnboardingCard from './components/OnboardingCard';
import OnboardingScreen from './components/OnboardingScreen';
import DerivationPathField from './components/DerivationPathField';
import {
  getBchAccountPath,
  normalizeBchAccountPath,
} from '../../services/HdWalletService';
import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import {
  BIP39_WORD_COUNTS,
  DEFAULT_BIP39_WORD_COUNT,
  isValidBip39Mnemonic,
  type Bip39WordCount,
} from '../../services/Bip39Service';
import { useI18n } from '../../i18n/useI18n';

const ImportWalletPage = () => {
  const currentNetwork = useSelector(selectCurrentNetwork);
  const [wordCount, setWordCount] = useState<Bip39WordCount>(
    DEFAULT_BIP39_WORD_COUNT
  );
  const [recoveryWords, setRecoveryWords] = useState<string[]>(
    Array(DEFAULT_BIP39_WORD_COUNT).fill('')
  );
  const [passphrase] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [derivationPath, setDerivationPath] = useState(() =>
    getBchAccountPath(currentNetwork)
  );
  const [customDerivationPath, setCustomDerivationPath] = useState(false);

  const dbService = useMemo(() => DatabaseService(), []);
  const walletManager = useMemo(() => WalletManager(), []);
  const hasInitialized = useRef(false);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { t } = useI18n();

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
        // Warm the connection before import completes so the first wallet
        // discovery does not inherit a stale socket from a prior session.
        try {
          await ElectrumServer().ensureFreshConnection();
        } catch (error) {
          console.warn('[ImportWalletPage] Electrum warm-up failed:', error);
        }
      } catch (error) {
        console.error('Error initializing database:', error);
        await Toast.show({
          text: t('onboarding.databasePreparationFailed'),
        });
      }
    };

    void initDb();
  }, [dbService, t]);

  const normalize = (word: string) =>
    word.replace(/\s+/g, ' ').trim().toLowerCase();
  const focusIndex = (index: number) => inputsRef.current[index]?.focus();

  const handleWordChange = (index: number, raw: string) => {
    const parts = normalize(raw).split(' ').filter(Boolean);

    setRecoveryWords((prev) => {
      const next = [...prev];

      if (parts.length <= 1) {
        next[index] = parts[0] ?? '';
      } else {
        for (let i = 0; i < parts.length && index + i < wordCount; i++) {
          next[index + i] = parts[i];
        }
      }

      return next;
    });

    if (parts.length > 1) {
      focusIndex(Math.min(index + parts.length, wordCount - 1));
    } else if (raw.endsWith(' ') && index < wordCount - 1) {
      focusIndex(index + 1);
    }
  };

  const handleKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLInputElement>
  ) => {
    const value = recoveryWords[index];

    if (event.key === 'Enter') {
      event.preventDefault();
      if (index < wordCount - 1) {
        focusIndex(index + 1);
      } else {
        void handleImportAccount();
      }
      return;
    }

    if (event.key === 'Backspace' && value.length === 0 && index > 0) {
      event.preventDefault();
      focusIndex(index - 1);
    }

    if (
      event.key === 'ArrowLeft' &&
      (event.currentTarget.selectionStart ?? 0) === 0 &&
      index > 0
    ) {
      focusIndex(index - 1);
    }

    if (
      event.key === 'ArrowRight' &&
      (event.currentTarget.selectionStart ?? 0) ===
        event.currentTarget.value.length &&
      index < wordCount - 1
    ) {
      focusIndex(index + 1);
    }
  };

  const handleWordCountChange = (next: Bip39WordCount) => {
    setWordCount(next);
    setRecoveryWords((previous) =>
      Array.from({ length: next }, (_, index) => previous[index] ?? '')
    );
    inputsRef.current = [];
  };

  const handleImportAccount = async () => {
    if (isSubmitting) return;

    const missingWordIndex = recoveryWords.findIndex(
      (word) => !normalize(word)
    );

    if (missingWordIndex !== -1) {
      console.error(`Word #${missingWordIndex + 1} is empty.`);
      focusIndex(missingWordIndex);
      await Toast.show({
        text: t('onboarding.missingWord').replace(
          '{number}',
          String(missingWordIndex + 1)
        ),
      });
      return;
    }

    const recoveryPhrase = recoveryWords.map(normalize).join(' ');
    if (!isValidBip39Mnemonic(recoveryPhrase)) {
      await Toast.show({ text: t('onboarding.invalidMnemonic') });
      return;
    }
    setIsSubmitting(true);

    try {
      const normalizedDerivationPath = normalizeBchAccountPath(derivationPath);
      const accountExists = await walletManager.checkAccount(
        recoveryPhrase,
        passphrase,
        { networkType: currentNetwork, walletType: WalletType.STANDARD }
      );

      if (!accountExists) {
        const created = await walletManager.createWallet(
          ONBOARDING_WALLET_NAME,
          recoveryPhrase,
          passphrase,
          currentNetwork,
          WalletType.STANDARD,
          normalizedDerivationPath,
          customDerivationPath ? 'custom' : 'default'
        );
        if (!created) {
          console.error('Failed to import account.');
          await Toast.show({ text: t('onboarding.importFailed') });
          return;
        }
      }

      const walletID = await walletManager.setWalletId(
        recoveryPhrase,
        passphrase,
        { networkType: currentNetwork, walletType: WalletType.STANDARD }
      );
      if (walletID == null) {
        console.error('Failed to set wallet ID.');
        await Toast.show({
          text: t('onboarding.walletSavedIdFailed'),
        });
        return;
      }

      const walletInfo = await walletManager.getWalletInfo(walletID);
      const resolvedNetwork =
        walletInfo?.networkType === Network.MAINNET
          ? Network.MAINNET
          : walletInfo?.networkType === Network.CHIPNET
            ? Network.CHIPNET
            : currentNetwork;

      // Materialize one address pair so the worker can start immediately. It
      // performs the full BIP44 discovery/gap-limit scan after navigation;
      // waiting for all 40 key rows here makes import unnecessarily slow.
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
      console.error('Error importing account:', error);
      await Toast.show({ text: t('onboarding.importFailed') });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <OnboardingScreen>
      <OnboardingCard
        title={t('onboarding.importWallet')}
        maxWidthClassName="max-w-lg"
      >
        <div className="flex flex-col items-center min-h-[300px] w-full">
          <DerivationPathField
            network={currentNetwork}
            value={derivationPath}
            custom={customDerivationPath}
            onChange={(path, custom) => {
              setDerivationPath(path);
              setCustomDerivationPath(custom);
            }}
          />

          <div className="w-full mb-3">
            <div className="mb-2 flex items-center justify-center gap-2">
              <span className="wallet-text-strong font-bold text-xl">
                {t('onboarding.recoveryPhrase')}
              </span>
              <InfoTooltipIcon
                id="recovery-tooltip"
                content={t('onboarding.recoveryDescription')}
                ariaLabel={t('onboarding.recoveryPhrase')}
              />
            </div>

            <div className="w-full px-2">
              <label className="mb-3 flex items-center justify-center gap-2 text-sm wallet-muted">
                <span>{t('onboarding.wordCountLabel')}</span>
                <select
                  value={wordCount}
                  onChange={(event) =>
                    handleWordCountChange(
                      Number(event.target.value) as Bip39WordCount
                    )
                  }
                  className="wallet-input wallet-surface-strong rounded-md px-2 py-1 wallet-text-strong"
                  aria-label={t('onboarding.wordCountLabel')}
                >
                  {BIP39_WORD_COUNTS.map((count) => (
                    <option key={count} value={count}>
                      {count} {t('onboarding.words')}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)]">
                {Array.from({ length: wordCount }).map((_, index) => (
                  <div key={index} className="flex items-center gap-2 min-w-0">
                    <span className="w-7 shrink-0 wallet-text-strong text-right opacity-80">
                      {index + 1}.
                    </span>
                    <input
                      ref={(el) => (inputsRef.current[index] = el)}
                      type="text"
                      inputMode="text"
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={recoveryWords[index]}
                      onChange={(event) =>
                        handleWordChange(index, event.target.value)
                      }
                      onKeyDown={(event) => handleKeyDown(index, event)}
                      enterKeyHint={index < wordCount - 1 ? 'next' : 'done'}
                      className="wallet-input wallet-surface-strong flex-1 min-w-0 px-3 py-1 rounded-md wallet-text-strong placeholder:opacity-60"
                      placeholder={t('onboarding.wordPlaceholder')}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={handleImportAccount}
          disabled={isSubmitting}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          {isSubmitting
            ? t('onboarding.importing')
            : t('onboarding.importWallet')}
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

export default ImportWalletPage;

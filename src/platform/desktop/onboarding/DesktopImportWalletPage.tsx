// Desktop-only wallet import flow — same shape as DesktopCreateWalletPage
// minus seed re-confirmation (the user already typed the real words once).
// Replaces src/features/onboarding/ImportWalletPage.tsx via a Vite alias
// (desktop builds only); the upstream mobile page is untouched.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import KeyService from '../../../services/KeyService';
import {
  getBchAccountPath,
  normalizeBchAccountPath,
} from '../../../services/HdWalletService';
import { Network, setNetwork } from '../../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import {
  setWalletId,
  setWalletNetwork,
  setWalletType,
  setWalletDerivationPath,
} from '../../../state/slices/walletSlice';
import { WalletType } from '../../../types/wallet';
import InfoTooltipIcon from '../../../features/onboarding/components/InfoTooltipIcon';
import OnboardingCard from '../../../features/onboarding/components/OnboardingCard';
import OnboardingScreen from '../../../features/onboarding/components/OnboardingScreen';
import DerivationPathField from '../../../features/onboarding/components/DerivationPathField';
import { createWalletWithPassword } from '../DesktopWalletManager';
import {
  BIP39_WORD_COUNTS,
  DEFAULT_BIP39_WORD_COUNT,
  isValidBip39Mnemonic,
  type Bip39WordCount,
} from '../../../services/Bip39Service';
import { useI18n } from '../../../i18n/useI18n';

type Step = 'words' | 'path' | 'name';

const DesktopImportWalletPage = () => {
  const [step, setStep] = useState<Step>('words');
  const [wordCount, setWordCount] = useState<Bip39WordCount>(
    DEFAULT_BIP39_WORD_COUNT
  );
  const [recoveryWords, setRecoveryWords] = useState<string[]>(
    Array(DEFAULT_BIP39_WORD_COUNT).fill('')
  );
  const [wordsError, setWordsError] = useState('');

  const [walletName, setWalletName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [nameError, setNameError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const dbService = useMemo(() => DatabaseService(), []);
  const hasInitialized = useRef(false);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const dispatch = useDispatch();
  const { t } = useI18n();
  const [derivationPath, setDerivationPath] = useState(() =>
    getBchAccountPath(currentNetwork)
  );
  const [customDerivationPath, setCustomDerivationPath] = useState(false);

  useEffect(() => {
    dispatch(setNetwork(Network.MAINNET));
  }, [dispatch]);

  useEffect(() => {
    if (!customDerivationPath)
      setDerivationPath(getBchAccountPath(currentNetwork));
  }, [currentNetwork, customDerivationPath]);

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    void (async () => {
      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) throw new Error('Failed to start the database.');
      } catch (error) {
        console.error(
          '[DesktopImportWalletPage] Error initializing database:',
          error
        );
      }
    })();
  }, [dbService]);

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
      if (index < wordCount - 1) focusIndex(index + 1);
      else handleWordsContinue();
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
    setWordsError('');
  };

  const handleWordsContinue = () => {
    const missingWordIndex = recoveryWords.findIndex(
      (word) => !normalize(word)
    );
    if (missingWordIndex !== -1) {
      setWordsError(
        t('onboarding.missingWord').replace(
          '{number}',
          String(missingWordIndex + 1)
        )
      );
      focusIndex(missingWordIndex);
      return;
    }
    const recoveryPhrase = recoveryWords.map(normalize).join(' ');
    if (!isValidBip39Mnemonic(recoveryPhrase)) {
      setWordsError(t('onboarding.invalidMnemonic'));
      return;
    }
    setWordsError('');
    setStep('path');
  };

  const handleImport = async () => {
    if (!walletName.trim()) {
      setNameError(t('onboarding.nameRequired'));
      return;
    }
    if (password !== passwordConfirm) {
      setNameError(t('onboarding.passwordMismatch'));
      return;
    }
    setNameError('');
    setIsSubmitting(true);
    try {
      const normalizedDerivationPath = normalizeBchAccountPath(derivationPath);
      const recoveryPhrase = recoveryWords.map(normalize).join(' ');
      const walletId = await createWalletWithPassword({
        name: walletName.trim(),
        mnemonic: recoveryPhrase,
        passphrase: '',
        network: currentNetwork,
        walletType: WalletType.STANDARD,
        derivationPath: normalizedDerivationPath,
        derivationPathSource: customDerivationPath ? 'custom' : 'default',
        password,
      });
      if (walletId == null) {
        setNameError(t('onboarding.walletAlreadyExists'));
        return;
      }

      // Materialize one address pair so the worker can start immediately. It
      // performs the full BIP44 discovery/gap-limit scan after navigation;
      // waiting for all 40 key rows here makes import unnecessarily slow.
      await KeyService.bootstrapInitialAddressBatch(walletId, 0, 1);

      dispatch(setWalletId(walletId));
      dispatch(setWalletNetwork(currentNetwork));
      dispatch(setWalletType(WalletType.STANDARD));
      dispatch(
        setWalletDerivationPath({
          path: normalizedDerivationPath,
          source: customDerivationPath ? 'custom' : 'default',
        })
      );
      dispatch(setNetwork(currentNetwork));
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      navigate(`/home/${walletId}`);
    } catch (error) {
      console.error('[DesktopImportWalletPage] Error importing wallet:', error);
      setNameError(t('onboarding.importFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (step === 'words') {
    return (
      <OnboardingScreen>
        <OnboardingCard
          title={t('onboarding.importWallet')}
          maxWidthClassName="max-w-lg"
        >
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
                      className="wallet-input wallet-surface-strong flex-1 min-w-0 px-3 py-1 rounded-md wallet-text-strong placeholder:opacity-60"
                      placeholder={t('onboarding.wordPlaceholder')}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          {wordsError && (
            <p className="text-sm text-red-400 text-center mb-2">
              {wordsError}
            </p>
          )}
          <button
            onClick={handleWordsContinue}
            className="wallet-btn-primary w-full my-2 text-xl font-bold"
          >
            {t('onboarding.continue')}
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
  }

  if (step === 'path') {
    return (
      <OnboardingScreen>
        <OnboardingCard title={t('onboarding.walletSetup')}>
          <p className="text-sm wallet-muted text-center mb-3">
            {t('onboarding.walletSetupDescription')}
          </p>
          <DerivationPathField
            network={currentNetwork}
            value={derivationPath}
            custom={customDerivationPath}
            onChange={(path, custom) => {
              setDerivationPath(path);
              setCustomDerivationPath(custom);
            }}
          />
          <button
            onClick={() => setStep('name')}
            className="wallet-btn-primary w-full my-2 text-xl font-bold"
          >
            {t('onboarding.continue')}
          </button>
          <button
            onClick={() => setStep('words')}
            className="wallet-btn-secondary w-full my-2 text-lg"
          >
            {t('onboarding.back')}
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  // step === 'name'
  return (
    <OnboardingScreen>
      <OnboardingCard title={t('onboarding.nameWallet')}>
        <p className="text-sm wallet-muted text-center mb-3">
          {t('onboarding.nameWalletDescription')}
        </p>
        <div className="space-y-3 mb-2">
          <input
            type="text"
            value={walletName}
            onChange={(e) => {
              setWalletName(e.target.value);
              setNameError('');
            }}
            placeholder={t('onboarding.walletNamePlaceholder')}
            autoFocus
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setNameError('');
            }}
            placeholder={t('onboarding.passwordPlaceholder')}
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
          <input
            type="password"
            value={passwordConfirm}
            onChange={(e) => {
              setPasswordConfirm(e.target.value);
              setNameError('');
            }}
            placeholder={t('onboarding.confirmPasswordPlaceholder')}
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
        </div>
        {nameError && (
          <p className="text-sm text-red-400 text-center mb-2">{nameError}</p>
        )}
        <button
          onClick={() => void handleImport()}
          disabled={isSubmitting}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          {isSubmitting
            ? t('onboarding.importing')
            : t('onboarding.importWallet')}
        </button>
      </OnboardingCard>
    </OnboardingScreen>
  );
};

export default DesktopImportWalletPage;

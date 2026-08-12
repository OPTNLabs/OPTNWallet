// Desktop-only wallet import flow — same shape as DesktopCreateWalletPage
// minus seed re-confirmation (the user already typed the real words once).
// Replaces src/features/onboarding/ImportWalletPage.tsx via a Vite alias
// (desktop builds only); the upstream mobile page is untouched.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import KeyService from '../../../services/KeyService';
import { getBchCoinType } from '../../../services/HdWalletService';
import { setNetwork } from '../../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import { setWalletId, setWalletNetwork, setWalletType } from '../../../state/slices/walletSlice';
import { WalletType } from '../../../types/wallet';
import InfoTooltipIcon from '../../../features/onboarding/components/InfoTooltipIcon';
import OnboardingCard from '../../../features/onboarding/components/OnboardingCard';
import OnboardingScreen from '../../../features/onboarding/components/OnboardingScreen';
import { createWalletWithPassword } from '../DesktopWalletManager';

type Step = 'words' | 'path' | 'name';

const TOTAL_WORDS = 12;

const DesktopImportWalletPage = () => {
  const [step, setStep] = useState<Step>('words');
  const [recoveryWords, setRecoveryWords] = useState<string[]>(Array(TOTAL_WORDS).fill(''));
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

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    void (async () => {
      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) throw new Error('Failed to start the database.');
      } catch (error) {
        console.error('[DesktopImportWalletPage] Error initializing database:', error);
      }
    })();
  }, [dbService]);

  const normalize = (word: string) => word.replace(/\s+/g, ' ').trim().toLowerCase();
  const focusIndex = (index: number) => inputsRef.current[index]?.focus();

  const handleWordChange = (index: number, raw: string) => {
    const parts = normalize(raw).split(' ').filter(Boolean);
    setRecoveryWords((prev) => {
      const next = [...prev];
      if (parts.length <= 1) {
        next[index] = parts[0] ?? '';
      } else {
        for (let i = 0; i < parts.length && index + i < TOTAL_WORDS; i++) {
          next[index + i] = parts[i];
        }
      }
      return next;
    });
    if (parts.length > 1) {
      focusIndex(Math.min(index + parts.length, TOTAL_WORDS - 1));
    } else if (raw.endsWith(' ') && index < TOTAL_WORDS - 1) {
      focusIndex(index + 1);
    }
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    const value = recoveryWords[index];
    if (event.key === 'Enter') {
      event.preventDefault();
      if (index < TOTAL_WORDS - 1) focusIndex(index + 1);
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
      (event.currentTarget.selectionStart ?? 0) === event.currentTarget.value.length &&
      index < TOTAL_WORDS - 1
    ) {
      focusIndex(index + 1);
    }
  };

  const handleWordsContinue = () => {
    const missingWordIndex = recoveryWords.findIndex((word) => !normalize(word));
    if (missingWordIndex !== -1) {
      setWordsError(`Word ${missingWordIndex + 1} is missing.`);
      focusIndex(missingWordIndex);
      return;
    }
    setWordsError('');
    setStep('path');
  };

  const handleImport = async () => {
    if (!walletName.trim()) {
      setNameError('Give this wallet a name.');
      return;
    }
    if (password !== passwordConfirm) {
      setNameError('Passwords do not match.');
      return;
    }
    setNameError('');
    setIsSubmitting(true);
    try {
      const recoveryPhrase = recoveryWords.map(normalize).join(' ');
      const walletId = await createWalletWithPassword({
        name: walletName.trim(),
        mnemonic: recoveryPhrase,
        passphrase: '',
        network: currentNetwork,
        walletType: WalletType.STANDARD,
        password,
      });
      if (walletId == null) {
        setNameError('Could not import this wallet. It may already exist.');
        return;
      }

      void KeyService.bootstrapInitialAddressBatch(walletId, 0, 10).catch((error) => {
        console.error('[DesktopImportWalletPage] Failed to bootstrap initial addresses:', error);
      });

      dispatch(setWalletId(walletId));
      dispatch(setWalletNetwork(currentNetwork));
      dispatch(setWalletType(WalletType.STANDARD));
      dispatch(setNetwork(currentNetwork));
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      navigate(`/home/${walletId}`);
    } catch (error) {
      console.error('[DesktopImportWalletPage] Error importing wallet:', error);
      setNameError('Wallet import failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const derivationPath = `m/44'/${getBchCoinType(currentNetwork)}'/0'`;

  if (step === 'words') {
    return (
      <OnboardingScreen>
        <OnboardingCard title="Import Wallet" maxWidthClassName="max-w-lg">
          <div className="w-full mb-3">
            <div className="mb-2 flex items-center justify-center gap-2">
              <span className="wallet-text-strong font-bold text-xl">Recovery Phrase</span>
              <InfoTooltipIcon
                id="recovery-tooltip"
                content="Enter your 12-word recovery (seed) phrase. Each box corresponds to the word order."
                ariaLabel="Recovery phrase information"
              />
            </div>
            <div className="w-full px-2">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)]">
                {Array.from({ length: TOTAL_WORDS }).map((_, index) => (
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
                      onChange={(event) => handleWordChange(index, event.target.value)}
                      onKeyDown={(event) => handleKeyDown(index, event)}
                      className="wallet-input wallet-surface-strong flex-1 min-w-0 px-3 py-1 rounded-md wallet-text-strong placeholder:opacity-60"
                      placeholder="word"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          {wordsError && <p className="text-sm text-red-400 text-center mb-2">{wordsError}</p>}
          <button onClick={handleWordsContinue} className="wallet-btn-primary w-full my-2 text-xl font-bold">
            Continue
          </button>
          <button onClick={() => navigate('/')} className="wallet-btn-danger w-full my-2 text-xl font-bold">
            Back
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  if (step === 'path') {
    return (
      <OnboardingScreen>
        <OnboardingCard title="Derivation Path">
          <p className="text-sm wallet-muted text-center mb-3">
            This wallet derives its addresses using the standard BIP44 path for Bitcoin Cash.
          </p>
          <div className="mb-4 p-4 rounded-xl wallet-surface-strong border border-[var(--wallet-border)] text-center">
            <code className="text-lg wallet-text-strong font-mono">{derivationPath}</code>
          </div>
          <button onClick={() => setStep('name')} className="wallet-btn-primary w-full my-2 text-xl font-bold">
            Continue
          </button>
          <button onClick={() => setStep('words')} className="wallet-btn-secondary w-full my-2 text-lg">
            Back
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  // step === 'name'
  return (
    <OnboardingScreen>
      <OnboardingCard title="Name This Wallet">
        <p className="text-sm wallet-muted text-center mb-3">
          Give this wallet a name and a password. Each wallet on this device has its own
          independent password.
        </p>
        <div className="space-y-3 mb-2">
          <input
            type="text"
            value={walletName}
            onChange={(e) => { setWalletName(e.target.value); setNameError(''); }}
            placeholder="Wallet name"
            autoFocus
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setNameError(''); }}
            placeholder="Password (or leave blank)"
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
          <input
            type="password"
            value={passwordConfirm}
            onChange={(e) => { setPasswordConfirm(e.target.value); setNameError(''); }}
            placeholder="Confirm password"
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
        </div>
        {nameError && <p className="text-sm text-red-400 text-center mb-2">{nameError}</p>}
        <button
          onClick={() => void handleImport()}
          disabled={isSubmitting}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          {isSubmitting ? 'Importing Wallet…' : 'Import Wallet'}
        </button>
      </OnboardingCard>
    </OnboardingScreen>
  );
};

export default DesktopImportWalletPage;

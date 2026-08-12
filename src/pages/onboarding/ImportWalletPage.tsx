import { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { setNetwork } from '../../redux/networkSlice';
import { selectCurrentNetwork } from '../../redux/selectors/networkSelectors';
import { setWalletId } from '../../redux/walletSlice';
import { ONBOARDING_WALLET_NAME } from './constants';
import InfoTooltipIcon from './components/InfoTooltipIcon';
import OnboardingCard from './components/OnboardingCard';
import OnboardingScreen from './components/OnboardingScreen';
import NetworkSelector from './components/NetworkSelector';

const TOTAL_WORDS = 12;

const ImportWalletPage = () => {
  const [recoveryWords, setRecoveryWords] = useState<string[]>(
    Array(TOTAL_WORDS).fill('')
  );
  const [passphrase] = useState('');

  const dbService = useMemo(() => DatabaseService(), []);
  const walletManager = useMemo(() => WalletManager(), []);
  const hasInitialized = useRef(false);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

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
      } catch (error) {
        console.error('Error initializing database:', error);
      }
    };

    void initDb();
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
      if (index < TOTAL_WORDS - 1) {
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
      (event.currentTarget.selectionStart ?? 0) === event.currentTarget.value.length &&
      index < TOTAL_WORDS - 1
    ) {
      focusIndex(index + 1);
    }
  };

  const handleImportAccount = async () => {
    const missingWordIndex = recoveryWords.findIndex((word) => !normalize(word));

    if (missingWordIndex !== -1) {
      console.error(`Word #${missingWordIndex + 1} is empty.`);
      focusIndex(missingWordIndex);
      return;
    }

    const recoveryPhrase = recoveryWords.map(normalize).join(' ');

    try {
      const accountExists = await walletManager.checkAccount(recoveryPhrase, passphrase);

      if (!accountExists) {
        const created = await walletManager.createWallet(
          ONBOARDING_WALLET_NAME,
          recoveryPhrase,
          passphrase,
          currentNetwork
        );
        if (!created) {
          console.error('Failed to import account.');
          return;
        }
      }

      const walletID = await walletManager.setWalletId(recoveryPhrase, passphrase);
      if (walletID == null) {
        console.error('Failed to set wallet ID.');
        return;
      }

      dispatch(setWalletId(walletID));
      dispatch(setNetwork(currentNetwork));
      navigate(`/home/${walletID}`);
    } catch (error) {
      console.error('Error importing account:', error);
    }
  };

  return (
    <OnboardingScreen>
      <OnboardingCard title="Import Wallet" maxWidthClassName="max-w-lg">
        <div className="flex flex-col items-center min-h-[300px] w-full">
          <NetworkSelector networkType={currentNetwork} centered />

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
                      enterKeyHint={index < TOTAL_WORDS - 1 ? 'next' : 'done'}
                      className="wallet-input wallet-surface-strong flex-1 min-w-0 px-3 py-1 rounded-md wallet-text-strong placeholder:opacity-60"
                      placeholder="word"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={handleImportAccount}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          Import Wallet
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

export default ImportWalletPage;

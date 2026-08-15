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
import { isValidImportMnemonic } from '../../hooks/useImportDerivationDiscovery';
import {
  getBchAccountPath,
  normalizeBchAccountPath,
} from '../../services/HdWalletService';
import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';

const TOTAL_WORDS = 12;
const normalizeRecoveryWord = (word: string) =>
  word.replace(/\s+/g, ' ').trim().toLowerCase();

const ImportWalletPage = () => {
  const currentNetwork = useSelector(selectCurrentNetwork);
  const [recoveryWords, setRecoveryWords] = useState<string[]>(
    Array(TOTAL_WORDS).fill('')
  );
  const [passphrase] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [importError, setImportError] = useState('');
  const [derivationPath, setDerivationPath] = useState(() =>
    getBchAccountPath(currentNetwork)
  );
  const [customDerivationPath, setCustomDerivationPath] = useState(false);
  const recoveryPhrase = useMemo(
    () => recoveryWords.map(normalizeRecoveryWord).join(' '),
    [recoveryWords]
  );
  const dbService = useMemo(() => DatabaseService(), []);
  const walletManager = useMemo(() => WalletManager(), []);
  const hasInitialized = useRef(false);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  const navigate = useNavigate();
  const dispatch = useDispatch();

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
          text: 'Could not prepare wallet import on this device.',
        });
      }
    };

    void initDb();
  }, [dbService]);

  const focusIndex = (index: number) => inputsRef.current[index]?.focus();

  const handleWordChange = (index: number, raw: string) => {
    setImportError('');
    const parts = normalizeRecoveryWord(raw).split(' ').filter(Boolean);

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

  const handleKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLInputElement>
  ) => {
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
      (event.currentTarget.selectionStart ?? 0) ===
        event.currentTarget.value.length &&
      index < TOTAL_WORDS - 1
    ) {
      focusIndex(index + 1);
    }
  };

  const handleImportAccount = async () => {
    if (isSubmitting) return;
    setImportError('');

    const missingWordIndex = recoveryWords.findIndex(
      (word) => !normalizeRecoveryWord(word)
    );

    if (missingWordIndex !== -1) {
      console.error(`Word #${missingWordIndex + 1} is empty.`);
      focusIndex(missingWordIndex);
      const message = `Word ${missingWordIndex + 1} is missing.`;
      setImportError(message);
      await Toast.show({ text: message });
      return;
    }

    if (!isValidImportMnemonic(recoveryPhrase)) {
      const message =
        'Recovery phrase checksum is invalid. Check the words and their order.';
      setImportError(message);
      await Toast.show({ text: message });
      return;
    }

    setIsSubmitting(true);
    let importStage = 'starting import';

    try {
      const normalizedDerivationPath = normalizeBchAccountPath(derivationPath);
      importStage = 'checking existing wallet';
      const accountExists = await walletManager.checkAccount(
        recoveryPhrase,
        passphrase,
        { networkType: currentNetwork, walletType: WalletType.STANDARD }
      );

      if (!accountExists) {
        importStage = 'saving wallet';
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
          const message = 'Wallet import failed on this device.';
          setImportError(message);
          await Toast.show({ text: message });
          return;
        }
      }

      importStage = 'resolving wallet ID';
      const walletID = await walletManager.setWalletId(
        recoveryPhrase,
        passphrase,
        { networkType: currentNetwork, walletType: WalletType.STANDARD }
      );
      if (walletID == null) {
        console.error('Failed to set wallet ID.');
        const message =
          'Wallet was saved, but the wallet ID could not be resolved.';
        setImportError(message);
        await Toast.show({ text: message });
        return;
      }

      importStage = 'loading wallet metadata';
      // Metadata is sufficient to establish the session. Do not decrypt the
      // recovery material a second time just to read network/path settings.
      const walletInfo = await walletManager.getWalletMetadata(walletID);
      const resolvedNetwork =
        walletInfo?.networkType === Network.MAINNET
          ? Network.MAINNET
          : walletInfo?.networkType === Network.CHIPNET
            ? Network.CHIPNET
            : currentNetwork;

      importStage = 'opening wallet';
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

      // Keep the initial key window consistent with desktop. The worker then
      // performs the bounded history-based branch discovery pass.
      void KeyService.bootstrapInitialAddressBatch(walletID, 0, 20).catch(
        (error) => {
          console.error('[ImportWalletPage] Initial address bootstrap failed', {
            walletId: walletID,
            error,
          });
        }
      );
    } catch (error) {
      console.error('[ImportWalletPage] Import failed', {
        stage: importStage,
        error,
      });
      const message = `Wallet import failed while ${importStage}.`;
      setImportError(message);
      await Toast.show({ text: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <OnboardingScreen>
      <OnboardingCard title="Import Wallet" maxWidthClassName="max-w-lg">
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
                Recovery Phrase
              </span>
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
                      onChange={(event) =>
                        handleWordChange(index, event.target.value)
                      }
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
          {importError && (
            <p
              role="alert"
              className="w-full px-2 mb-2 text-sm leading-relaxed wallet-danger-text"
            >
              {importError}
            </p>
          )}
        </div>

        <button
          onClick={handleImportAccount}
          disabled={isSubmitting}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          {isSubmitting ? 'Importing Wallet...' : 'Import Wallet'}
        </button>
        <button
          onClick={() => navigate('/')}
          className="wallet-btn-danger w-full my-2 text-xl font-bold"
        >
          Back
        </button>
      </OnboardingCard>
    </OnboardingScreen>
  );
};

export default ImportWalletPage;

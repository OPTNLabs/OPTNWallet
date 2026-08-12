//@ts-nocheck
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tooltip } from 'react-tooltip';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { useDispatch, useSelector } from 'react-redux';
import { setWalletId } from '../redux/walletSlice';
import WalletManager from '../apis/WalletManager/WalletManager';
import NetworkSwitch from './modules/NetworkSwitch';
import { Network, setNetwork } from '../redux/networkSlice';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';

const TOTAL_WORDS = 12;

const WalletImport = () => {
  const [recoveryWords, setRecoveryWords] = useState<string[]>(
    Array(TOTAL_WORDS).fill('')
  );
  const [passphrase, setPassphrase] = useState('');
  // const [showAdvanced, setShowAdvanced] = useState(false);

  const dbService = DatabaseService();
  const walletManager = WalletManager();
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const dispatch = useDispatch();

  const walletName = 'OPTN';
  const hasInitialized = useRef(false);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

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
    initDb();
  }, []);

  // useEffect(() => {
  //   if (!showAdvanced) setPassphrase('');
  // }, [showAdvanced]);

  const normalize = (w: string) => w.replace(/\s+/g, ' ').trim().toLowerCase();
  const focusIndex = (i: number) => inputsRef.current[i]?.focus();

  const handleWordChange = (idx: number, raw: string) => {
    const parts = normalize(raw).split(' ').filter(Boolean);

    setRecoveryWords((prev) => {
      const next = [...prev];
      if (parts.length <= 1) {
        next[idx] = parts[0] ?? '';
      } else {
        for (let i = 0; i < parts.length && idx + i < TOTAL_WORDS; i++) {
          next[idx + i] = parts[i];
        }
      }
      return next;
    });

    if (parts.length > 1) {
      focusIndex(Math.min(idx + parts.length, TOTAL_WORDS - 1));
    } else if (raw.endsWith(' ') && idx < TOTAL_WORDS - 1) {
      focusIndex(idx + 1);
    }
  };

  const handleKeyDown = (
    idx: number,
    e: React.KeyboardEvent<HTMLInputElement>
  ) => {
    const value = recoveryWords[idx];

    if (e.key === 'Enter') {
      e.preventDefault();
      if (idx < TOTAL_WORDS - 1) {
        focusIndex(idx + 1);
      } else {
        void handleImportAccount();
      }
      return;
    }

    if (e.key === 'Backspace' && value.length === 0 && idx > 0) {
      e.preventDefault();
      focusIndex(idx - 1);
    }
    if (
      e.key === 'ArrowLeft' &&
      (e.currentTarget.selectionStart ?? 0) === 0 &&
      idx > 0
    ) {
      focusIndex(idx - 1);
    }
    if (
      e.key === 'ArrowRight' &&
      (e.currentTarget.selectionStart ?? 0) === e.currentTarget.value.length &&
      idx < TOTAL_WORDS - 1
    ) {
      focusIndex(idx + 1);
    }
  };

  const handleImportAccount = async () => {
    const missing = recoveryWords.findIndex((w) => !normalize(w));
    if (missing !== -1) {
      console.error(`Word #${missing + 1} is empty.`);
      focusIndex(missing);
      return;
    }

    const recoveryPhrase = recoveryWords.map(normalize).join(' ');

    try {
      const accountExists = await walletManager.checkAccount(
        recoveryPhrase,
        passphrase
      );

      if (!accountExists) {
        const createAccountSuccess = await walletManager.createWallet(
          walletName,
          recoveryPhrase,
          passphrase,
          currentNetwork
        );
        if (!createAccountSuccess) {
          console.error('Failed to import account.');
          return;
        }
      }

      let walletID = await walletManager.setWalletId(
        recoveryPhrase,
        passphrase
      );
      if (walletID == null) {
        console.error('Failed to set wallet ID.');
        return;
      }

      dispatch(setWalletId(walletID));
      dispatch(setNetwork(currentNetwork));
      navigate(`/home/${walletID}`);
    } catch (e) {
      console.error('Error importing account:', e);
    }
  };

  const returnHome = () => navigate(`/`);

  return (
    <div className="min-h-screen bg-slate-600 flex flex-col items-center justify-center p-4">
      {/* Increase inner card width slightly and center everything */}
      <div className="bg-slate-600 p-6 w-full max-w-lg">
        <div className="flex justify-center mt-4">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="Welcome"
            className="max-w-full h-auto"
          />
        </div>

        <h1 className="text-white font-bold text-xl mb-4 text-center">
          Import Wallet
        </h1>

        <div className="flex flex-col items-center min-h-[300px] w-full">
          {/* Center the switch row */}
          <div className="flex items-center justify-center gap-2 mb-4 w-full">
            <NetworkSwitch
              networkType={currentNetwork}
              setNetworkType={(network: Network) =>
                dispatch(setNetwork(network))
              }
            />
            <span
              data-tooltip-id="network-tooltip"
              className="cursor-pointer text-blue-300 text-lg font-bold select-none"
              aria-label="Network info"
              role="img"
            >
              ⓘ
            </span>
            <Tooltip
              id="network-tooltip"
              place="top"
              className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
              content="Select the blockchain network your wallet will connect to (e.g., Mainnet or CHIPNET Testnet)."
            />
          </div>

          {/* Recovery Phrase heading centered with tooltip */}
          <div className="w-full mb-3">
            <div className="mb-2 flex items-center justify-center gap-2">
              <span className="text-white font-bold text-xl">
                Recovery Phrase
              </span>
              <span
                data-tooltip-id="recovery-tooltip"
                className="cursor-pointer text-yellow-300 text-lg font-bold select-none"
                aria-label="Recovery phrase info"
                role="img"
              >
                ⓘ
              </span>
              <Tooltip
                id="recovery-tooltip"
                place="top"
                className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug font-normal"
                content="Enter your 12-word recovery (seed) phrase. Each box corresponds to the word order."
              />
            </div>

            {/* Add horizontal padding so inputs don't touch screen edges */}
            <div className="w-full px-2">
              {/* Two equal columns; inputs get a bit of breathing room */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {Array.from({ length: TOTAL_WORDS }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 min-w-0">
                    {/* Fixed-width number keeps columns tidy, avoids left-side “steal” */}
                    <span className="w-7 shrink-0 text-gray-200 text-right">
                      {i + 1}.
                    </span>
                    <input
                      ref={(el) => (inputsRef.current[i] = el)}
                      type="text"
                      inputMode="text"
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={recoveryWords[i]}
                      onChange={(e) => handleWordChange(i, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(i, e)}
                      enterKeyHint={i < TOTAL_WORDS - 1 ? 'next' : 'done'}
                      className="flex-1 min-w-0 px-3 py-1 border border-gray-300 rounded-md text-gray-900"
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
          className="w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 transition duration-300 my-2 text-xl font-bold"
        >
          Import Wallet
        </button>
        <button
          onClick={returnHome}
          className="w-full bg-red-500 text-white py-2 px-4 rounded-md hover:bg-red-600 transition duration-300 my-2 text-xl font-bold"
        >
          Go Back
        </button>
      </div>
    </div>
  );
};

export default WalletImport;

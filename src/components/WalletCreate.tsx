// @ts-nocheck

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import KeyService from '../services/KeyService';
import WalletManager from '../apis/WalletManager/WalletManager';
import { useDispatch, useSelector } from 'react-redux';
import { setWalletId, setWalletNetwork } from '../redux/walletSlice';
import { Network, setNetwork } from '../redux/networkSlice';
import NetworkSwitch from './modules/NetworkSwitch';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';

const WalletCreation = () => {
  const [mnemonicPhrase, setMnemonicPhrase] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const dbService = DatabaseService();
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const dispatch = useDispatch();
  const walletManager = WalletManager();

  // Temporary constant value
  const walletName = 'OPTN';

  // Ref to track if initialization has occurred
  const hasInitialized = useRef(false);

  useEffect(() => {
    const initDb = async () => {
      if (hasInitialized.current) {
        return; // Prevent double initialization
      }
      hasInitialized.current = true;

      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) {
          throw new Error('Failed to start the database.');
        }
        await generateMnemonicPhrase();
      } catch (error) {
        console.error('Error initializing database:', error);
      }
    };
    initDb();
  }, []);

  // Reset passphrase when advanced options are hidden
  useEffect(() => {
    if (!showAdvanced) {
      setPassphrase('');
    }
  }, [showAdvanced]);

  const generateMnemonicPhrase = async () => {
    try {
      const mnemonic = await KeyService.generateMnemonic();
      setMnemonicPhrase(mnemonic);
    } catch (error) {
      console.error('Error generating mnemonic:', error);
    }
  };

  const handleCreateAccount = async () => {
    try {
      const accountExists = await walletManager.checkAccount(
        mnemonicPhrase,
        passphrase
      );
      if (accountExists) {
        console.error('Account already exists.');
        return;
      }

      const createWalletSuccess = await walletManager.createWallet(
        walletName,
        mnemonicPhrase,
        passphrase,
        currentNetwork
      );
      if (!createWalletSuccess) {
        throw new Error('Failed to create wallet in the database.');
      }

      const walletID = await walletManager.setWalletId(
        mnemonicPhrase,
        passphrase
      );
      if (walletID == null) {
        throw new Error('Failed to set wallet ID in the Redux store.');
      }

      dispatch(setWalletId(walletID));
      dispatch(setWalletNetwork(currentNetwork));
      dispatch(setNetwork(currentNetwork));

      navigate(`/home/${walletID}`);
    } catch (e) {
      console.error('Error creating account:', e);
    }
  };

  const returnHome = () => {
    navigate(`/`);
  };

  // Split mnemonic phrase into words and prepare for two-column display
  const mnemonicWords = mnemonicPhrase ? mnemonicPhrase.split(' ') : [];
  const halfLength = Math.ceil(mnemonicWords.length / 2);
  const firstColumn = mnemonicWords.slice(0, halfLength);
  const secondColumn = mnemonicWords.slice(halfLength);

  return (
    <div className="min-h-screen bg-slate-600 flex flex-col items-center justify-center p-4">
      <div className="bg-slate-600 p-6 w-full max-w-md">
        <div className="flex justify-center mt-4">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="Welcome"
            className="max-w-full h-auto"
          />
        </div>
        <div className="text-white font-bold text-xl mb-4 text-center">
          Create Wallet
        </div>

        {/* Fixed-height container for inputs and toggle */}
        <div className="flex flex-col items-center min-h-[300px]">
          {/* Toggle for advanced options */}
          {/* <div className="mb-4 flex flex-row gap-2 items-center text-white">
            <span>Basic</span>
            <div
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`w-12 h-6 rounded-full flex items-center cursor-pointer relative transition-colors ${
                showAdvanced ? 'bg-green-400' : 'bg-orange-400'
              }`}
            >
              <div
                className={`w-6 h-6 bg-white rounded-full shadow-md transform transition-transform ${
                  showAdvanced ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </div>
            <span>Advanced</span>
          </div> */}
          {/* Advanced options: Passphrase and NetworkSwitch */}
          {/* {showAdvanced && ( */}
          <>
            {/* <div className="mb-4">
                <label className="block text-white mb-2">
                  Passphrase - Optional
                </label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
              </div> */}
            <NetworkSwitch
              networkType={currentNetwork}
              setNetworkType={(network: Network) =>
                dispatch(setNetwork(network))
              }
            />
          </>
          {/* )} */}
          {/* Mnemonic phrase display in two columns */}
          <div className="text-white font-bold text-xl mb-2 text-center">
            Generated Mnemonic:
          </div>
          {mnemonicPhrase ? (
            <div className="grid grid-cols-2 gap-4 mb-4 p-2 bg-gray-200 rounded-md">
              <div>
                {firstColumn.map((word, index) => (
                  <div key={index} className="flex items-center mb-2">
                    <span className="w-8 text-gray-700">{index + 1}.</span>
                    <span className="text-gray-700">{word}</span>
                  </div>
                ))}
              </div>
              <div>
                {secondColumn.map((word, index) => (
                  <div
                    key={index + halfLength}
                    className="flex items-center mb-2"
                  >
                    <span className="w-8 text-gray-700">
                      {index + halfLength + 1}.
                    </span>
                    <span className="text-gray-700">{word}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center mb-4 p-2 bg-gray-200 rounded-md">
              Generating...
            </div>
          )}
        </div>
        <button
          onClick={handleCreateAccount}
          className="w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 transition duration-300 my-2 text-xl font-bold"
        >
          Create Wallet
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

export default WalletCreation;

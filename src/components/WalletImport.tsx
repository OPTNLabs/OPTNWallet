// @ts-nocheck

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { useDispatch, useSelector } from 'react-redux';
import { setWalletId } from '../redux/walletSlice';
import WalletManager from '../apis/WalletManager/WalletManager';
import NetworkSwitch from './modules/NetworkSwitch';
import { Network, setNetwork } from '../redux/networkSlice';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';

const WalletImport = () => {
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const dbService = DatabaseService();
  const walletManager = WalletManager();
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const dispatch = useDispatch();

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

  const handleImportAccount = async () => {
    if (recoveryPhrase === '') {
      console.error('Recovery Phrase cannot be empty.');
      return;
    }

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

  const returnHome = () => {
    navigate(`/`);
  };

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
          Import Wallet
        </div>
        {/* Fixed-height container for inputs and toggle */}
        <div className="flex flex-col items-center min-h-[300px]">
          {/* Toggle for advanced options */}
          {/* <div className="mb-4 flex flex-row items-center gap-2 items-center text-white">
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
          <div className="mb-4 flex flex-col items-center">
            <label className="text-white font-bold text-xl mb-2 text-center">
              Recovery Phrase
            </label>
            <input
              type="text"
              onChange={(e) => setRecoveryPhrase(e.target.value)}
              className="w-full p-2 border border-gray-300 rounded-md"
            />
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

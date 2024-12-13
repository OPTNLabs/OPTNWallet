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
  const dbService = DatabaseService();
  const walletManager = WalletManager();
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const dispatch = useDispatch();

  // temporary constant value
  const walletName = 'OPTN';

  // Ref to track if initialization has occurred
  const hasInitialized = useRef(false);

  useEffect(() => {
    const initDb = async () => {
      if (hasInitialized.current) {
        return; // Prevent double initialization
      }
      hasInitialized.current = true;

      // console.log('Starting database...');
      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) {
          throw new Error('Failed to start the database.');
        }
        // console.log('Database has been started.');
      } catch (error) {
        console.error('Error initializing database:', error);
      }
    };
    initDb();
  }, []);

  const handleImportAccount = async () => {
    if (recoveryPhrase === '') {
      console.log('Recovery Phrase cannot be empty.');
      return;
    }

    try {
      // console.log(
      //   'Checking account with given recovery phrase and passphrase...'
      // );
      const accountExists = await walletManager.checkAccount(
        recoveryPhrase,
        passphrase
      );

      if (!accountExists) {
        // console.log('Account does not exist, attempting to create...');
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
        // console.log('Account imported successfully.');
      }

      // console.log('Setting wallet ID...');
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
      // console.log('Wallet ID set and network updated.');

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
        <div className="mb-4">
          <label className="block text-white mb-2">Recovery Phrase</label>
          <input
            type="text"
            onChange={(e) => setRecoveryPhrase(e.target.value)}
            className="w-full p-2 border border-gray-300 rounded-md"
          />
        </div>
        <div className="mb-4">
          <label className="block text-white mb-2">Passphrase - Optional</label>
          <input
            type="password"
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full p-2 border border-gray-300 rounded-md"
          />
        </div>
        <NetworkSwitch
          networkType={currentNetwork}
          setNetworkType={(network: Network) => dispatch(setNetwork(network))}
        />
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

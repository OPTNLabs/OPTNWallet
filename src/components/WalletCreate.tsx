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
  // const [walletName, setWalletName] = useState('OPTN');
  const [passphrase, setPassphrase] = useState('');
  const dbService = DatabaseService();
  const navigate = useNavigate();
  // const wallet_id = useSelector(
  //   (state: RootState) => state.wallet_id.currentWalletId
  // );
  const currentNetwork = useSelector(selectCurrentNetwork);
  const dispatch = useDispatch();
  const walletManager = WalletManager();

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

  const generateMnemonicPhrase = async () => {
    try {
      const mnemonic = await KeyService.generateMnemonic();
      // console.log('Generated mnemonic phrase:', mnemonic);
      setMnemonicPhrase(mnemonic);
    } catch (error) {
      console.error('Error generating mnemonic:', error);
    }
  };

  const handleCreateAccount = async () => {
    // console.log('Creating account...');
    try {
      const accountExists = await walletManager.checkAccount(
        mnemonicPhrase,
        passphrase
      );
      if (accountExists) {
        console.log('Account already exists.');
        return;
      }

      // Create wallet using WalletManager
      const createWalletSuccess = await walletManager.createWallet(
        walletName,
        mnemonicPhrase,
        passphrase,
        currentNetwork
      );
      if (!createWalletSuccess) {
        throw new Error('Failed to create wallet in the database.');
      }

      // console.log('Wallet saved to database successfully.');

      // Set wallet ID and network in Redux
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

      // Create initial keys using KeyService
      // await KeyService.createKeys(walletID, 0, 0, 0);

      // console.log('Keys generated and account created successfully.');
      navigate(`/home/${walletID}`);
    } catch (e) {
      console.error('Error creating account:', e);
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
          Generated Mnemonic:
        </div>
        <div className="text-center mb-4 p-2 bg-gray-200 rounded-md">
          {mnemonicPhrase ? mnemonicPhrase : 'Generating...'}
        </div>

        <div className="mb-4">
          <label className="block text-white mb-2">Set Passphrase</label>
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

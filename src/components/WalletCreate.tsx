import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tooltip } from 'react-tooltip';
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

  const walletName = 'OPTN';
  const hasInitialized = useRef(false);

  useEffect(() => {
    const initDb = async () => {
      if (hasInitialized.current) return;
      hasInitialized.current = true;

      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) throw new Error('Failed to start the database.');
        await generateMnemonicPhrase();
      } catch (error) {
        console.error('Error initializing database:', error);
      }
    };
    initDb();
  }, []);

  useEffect(() => {
    if (!showAdvanced) setPassphrase('');
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
      const accountExists = await walletManager.checkAccount(mnemonicPhrase, passphrase);
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
      if (!createWalletSuccess) throw new Error('Failed to create wallet in the database.');

      const walletID = await walletManager.setWalletId(mnemonicPhrase, passphrase);
      if (walletID == null) throw new Error('Failed to set wallet ID in the Redux store.');

      dispatch(setWalletId(walletID));
      dispatch(setWalletNetwork(currentNetwork));
      dispatch(setNetwork(currentNetwork));

      navigate(`/home/${walletID}`);
    } catch (e) {
      console.error('Error creating account:', e);
    }
  };

  const returnHome = () => navigate(`/`);

  const mnemonicWords = mnemonicPhrase ? mnemonicPhrase.split(' ') : [];
  const halfLength = Math.ceil(mnemonicWords.length / 2);
  const firstColumn = mnemonicWords.slice(0, halfLength);
  const secondColumn = mnemonicWords.slice(halfLength);

  return (
    <div className="min-h-screen bg-slate-600 flex flex-col items-center justify-center p-4">
      <div className="bg-slate-600 p-6 w-full max-w-md">
        <div className="flex justify-center mt-4">
          <img src="/assets/images/OPTNWelcome1.png" alt="Welcome" className="max-w-full h-auto" />
        </div>
        <div className="text-white font-bold text-xl mb-4 text-center">
          Create Wallet
        </div>

        <div className="flex flex-col items-center min-h-[300px]">
          {/* NetworkSwitch with info icon */}
          <div className="flex items-center gap-2 mb-4">
            <NetworkSwitch
              networkType={currentNetwork}
              setNetworkType={(network: Network) => dispatch(setNetwork(network))}
            />
            <span
              data-tooltip-id="network-tooltip"
              className="cursor-pointer text-blue-300 text-lg font-bold select-none"
            >
              ⓘ
            </span>
            <Tooltip
              id="network-tooltip"
              place="top"
              className='max-w-[80vw] whitespace-normal break-words text-sm leading-snug'
              content="Select the blockchain network your wallet will connect to (e.g., Mainnet or CHIPNET Testnet)."
            />
          </div>

          {/* Mnemonic label with info icon */}
          <div className="text-white font-bold text-xl mb-2 flex items-center gap-2">
            <span>Generated Mnemonic:</span>
            <span
              data-tooltip-id="mnemonic-tooltip"
              className="cursor-pointer text-yellow-300 text-lg font-bold select-none"
            >
              ⓘ
            </span>
            <Tooltip
              id="mnemonic-tooltip"
              place="top"
              className='max-w-[80vw] whitespace-normal break-words text-sm leading-snug font-normal'
              content="Your mnemonic (seed phrase) is the master key to your wallet. Store it securely and never share it—anyone with it can access your funds."
            />
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
                  <div key={index + halfLength} className="flex items-center mb-2">
                    <span className="w-8 text-gray-700">{index + halfLength + 1}.</span>
                    <span className="text-gray-700">{word}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center mb-4 p-2 bg-gray-200 rounded-md">Generating...</div>
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

// @ts-nocheck
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import KeyGeneration from '../apis/WalletManager/KeyGeneration';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { setWalletId } from '../redux/walletSlice';
import WalletManager from '../apis/WalletManager/WalletManager';

const WalletCreation = () => {
  const [mnemonicPhrase, setMnemonicPhrase] = useState('');
  const [walletName, setWalletName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const dbService = DatabaseService();
  const WalletManage = WalletManager();
  const navigate = useNavigate();
  const KeyGen = KeyGeneration();
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const dispatch = useDispatch();

  useEffect(() => {
    console.log('Wallet ID: ', wallet_id);
    const initDb = async () => {
      try {
        console.log('Starting database...');
        const dbStarted = await dbService.startDatabase();
        if (dbStarted) {
          console.log('Database has been started.');
          await generateMnemonicPhrase(); // Ensure to wait for mnemonic generation
        } else {
          console.error('Failed to start the database.');
        }
      } catch (error) {
        console.error('Error initializing database:', error);
      }
    };
    initDb();
  }, []);

  const generateMnemonicPhrase = async () => {
    console.log('Generating mnemonic phrase...');
    try {
      const mnemonic = await KeyGen.generateMnemonic();
      console.log('Generated mnemonic phrase:', mnemonic);
      setMnemonicPhrase(mnemonic);
    } catch (error) {
      console.error('Error generating mnemonic:', error);
    }
  };

  const handleCreateAccount = async () => {
    const check = await WalletManage.checkAccount(mnemonicPhrase, passphrase);
    if (!check) {
      try {
        const createAccountSuccess = await WalletManage.createWallet(
          walletName,
          mnemonicPhrase,
          passphrase
        );
        if (createAccountSuccess) {
          console.log('Account created successfully.');
        }
      } catch (e) {
        console.log(e);
      }
    }
    const walletID = await WalletManage.setWalletId(mnemonicPhrase, passphrase);
    if (walletID != null) {
      dispatch(setWalletId(walletID));
      navigate(`/home/${walletID}`);
    }
  };

  const returnHome = async () => {
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
        {console.log(mnemonicPhrase)}
        <div className="text-center mb-4 p-2 bg-gray-200 rounded-md">
          {mnemonicPhrase ? mnemonicPhrase : 'Generating...'}
        </div>

        {/*Remove the following div section*/}
        {/* <div className="mb-4">
          <label className="block text-white mb-2">Set Wallet Name</label>
          <input
            placeholder={wallet_id.toString()}
            onChange={(e) =>
              setWalletName(
                e.target.value ? e.target.value : wallet_id.toString()
              )
            }
            className="w-full p-2 border border-gray-300 rounded-md"
          />
        </div> */}

        <div className="mb-4">
          <label className="block text-white mb-2">Set Passphrase</label>
          <input
            type="password"
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full p-2 border border-gray-300 rounded-md"
          />
        </div>
        <button
          onClick={handleCreateAccount}
          className="w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 transition duration-300 my-2"
        >
          Create Wallet
        </button>
        <button
          onClick={returnHome}
          className="w-full bg-red-500 text-white py-2 px-4 rounded-md hover:bg-red-600 transition duration-300 my-2"
        >
          Go Back
        </button>
      </div>
    </div>
  );
};

export default WalletCreation;

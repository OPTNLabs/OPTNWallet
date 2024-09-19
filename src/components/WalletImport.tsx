import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import {
  useDispatch, //useSelector
} from 'react-redux';
// import { RootState } from '../redux/store';
import { setWalletId } from '../redux/walletSlice';
import WalletManager from '../apis/WalletManager/WalletManager';

const WalletImport = () => {
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [
    walletName, //setWalletName
  ] = useState('OPTN');
  const [passphrase, setPassphrase] = useState('');
  const dbService = DatabaseService();
  const WalletManage = WalletManager();
  const navigate = useNavigate();
  // const wallet_id = useSelector(
  //   (state: RootState) => state.wallet_id.currentWalletId
  // );
  const dispatch = useDispatch();

  useEffect(() => {
    const initDb = async () => {
      const dbStarted = await dbService.startDatabase();
      if (dbStarted) {
        console.log('Database has been started.');
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
      console.log(
        'Checking account with given recovery phrase and passphrase...'
      );
      const check = await WalletManage.checkAccount(recoveryPhrase, passphrase);
      console.log('Account check result:', check);

      if (!check) {
        console.log('Account does not exist, attempting to create...');
        const createAccountSuccess = await WalletManage.createWallet(
          walletName,
          recoveryPhrase,
          passphrase
        );
        if (createAccountSuccess) {
          console.log('Account imported successfully.');
        } else {
          console.log('Failed to import account.');
          return;
        }
      }

      console.log('Setting wallet ID...');
      let walletID = await WalletManage.setWalletId(recoveryPhrase, passphrase);
      console.log('Wallet ID:', walletID);

      if (walletID == null) {
        console.log('No wallet ID found, creating a new wallet...');
        const created = await WalletManage.createWallet(
          walletName,
          recoveryPhrase,
          passphrase
        );
        if (created) {
          console.log('New imported wallet created successfully');
          walletID = await WalletManage.setWalletId(recoveryPhrase, passphrase);
        } else {
          console.log('Failed to create a new wallet.');
          return;
        }
      }

      if (walletID != null) {
        dispatch(setWalletId(walletID));
        navigate(`/home/${walletID}`);
      }
    } catch (e) {
      console.log('Error importing account:', e);
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
          Import Wallet
        </div>
        <div className="mb-4">
          <label className="block text-white mb-2">Recovery Phrase</label>
          <input
            type="password"
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

        <button
          onClick={handleImportAccount}
          className="w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 transition duration-300 my-2"
        >
          Import Wallet
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

export default WalletImport;

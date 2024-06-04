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
    const wallet_id = useSelector((state: RootState) => state.wallet_id.currentWalletId);
    const dispatch = useDispatch();

    useEffect(() => {
        console.log(wallet_id);
        const initDb = async () => {
            const dbStarted = await dbService.startDatabase();
            if (dbStarted) {
                console.log('Database has been started.');
            }
            generateMnemonicPhrase();
        };
        initDb();
    }, []);

    const generateMnemonicPhrase = async () => {
        const mnemonic = await KeyGen.generateMnemonic();
        setMnemonicPhrase(mnemonic);
    };

    const handleCreateAccount = async () => {
        const queryResult = await WalletManage.createWallet(walletName, mnemonicPhrase, passphrase);

        if (queryResult) {
            dispatch(setWalletId(walletName));
            navigate(`/home/${walletName}`);
        }
    };

    return (
        <div className="wallet-create-box">
            <div className="text-black font-bold text-xl">Generated Mnemonic:</div>
            <div className="text-center">{mnemonicPhrase}</div>
            <div>Set your wallet Name</div>
            <input
                onChange={(e) => setWalletName(e.target.value)}
            />
            <div>Set passphrase</div>
            <input
                type="password"
                onChange={(e) => setPassphrase(e.target.value)}
            />
            <button onClick={ handleCreateAccount }>Create account</button>
        </div>
    );
};

export default WalletCreation;

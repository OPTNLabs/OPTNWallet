import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { setWalletId } from '../redux/walletSlice';
import WalletManager from '../apis/WalletManager/WalletManager';

const WalletImport = () => {
    const [recoveryPhrase, setRecoveryPhrase] = useState('');
    const [walletName, setWalletName] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const dbService = DatabaseService();
    const WalletManage = WalletManager();
    const navigate = useNavigate();
    const wallet_id = useSelector((state: RootState) => state.wallet_id.currentWalletId);
    const dispatch = useDispatch();

    useEffect(() => {
        console.log(wallet_id);
        const initDb = async () => {
            const dbStarted = await dbService.startDatabase();
            if (dbStarted) {
                console.log('Database has been started.');
            };
        };
        initDb();
    }, []);

    const handleImportAccount = async () => {
        if (walletName === "") {
            console.log("Wallet name cannot be empty.");
            return;
        }

        try {
            const check = WalletManage.checkAccount(recoveryPhrase, passphrase);
            if (!check) {
                const createAccountSuccess = await WalletManage.createWallet(walletName, recoveryPhrase, passphrase);
                if (createAccountSuccess) {
                    console.log("Account imported successfully.");
                } else {
                    console.log("Failed to import account.");
                    return;
                }
            }

            let walletID = await WalletManage.setWalletId(recoveryPhrase, passphrase);
            if (walletID == null) {
                const created = await WalletManage.createWallet(walletName, recoveryPhrase, passphrase);
                if (created) {
                    console.log("New imported wallet created successfully");
                    walletID = await WalletManage.setWalletId(recoveryPhrase, passphrase);
                } else {
                    console.log("Failed to create a new wallet.");
                    return;
                }
            }

            if (walletID != null) {
                dispatch(setWalletId(walletID));
                navigate(`/home/${walletID}`);
            }
        } catch (e) {
            console.log(e);
        }
    };

    return (
        <div className="wallet-create-box">
            <div>Recovery Phrase</div>
            <input
                type="password"
                onChange={(e) => setRecoveryPhrase(e.target.value)}
            />
            <div>Passphrase - Optional</div>
            <input
                type="password"
                onChange={(e) => setPassphrase(e.target.value)}
            />
            <div>Set your wallet Name</div>
            <input
                onChange={(e) => setWalletName(e.target.value)}
            />
            <button onClick={handleImportAccount}>Import</button>
        </div>
    );
};

export default WalletImport;

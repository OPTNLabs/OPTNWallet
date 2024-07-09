import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import KeyManager from '../apis/WalletManager/KeyManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import WalletManager from '../apis/WalletManager/WalletManager';

const Home = () => {
    const [keyPairs, setKeyPairs] = useState<{ id: number, publicKey: Uint8Array; privateKey: Uint8Array; address: string, accountIndex: number, changeIndex: number, addressIndex: number }[]>([]);
    const [retrieve, setRetrieve] = useState(false);
    const KeyManage = KeyManager();
    const dbService = DatabaseService();
    const navigate = useNavigate();
    const { wallet_id } = useParams<{ wallet_id: string }>();
    const ManageUTXOs = UTXOManager();
    const WalletManage = WalletManager();

    useEffect(() => {
        const retrieveWalletInformation = async () => {
            if (wallet_id) {
                const wallet_id_number = parseInt(wallet_id, 10);
                const walletKeys = await KeyManage.retrieveKeys(wallet_id_number);
                console.log("wallet keys", walletKeys);
                setKeyPairs(walletKeys);
            }
            console.log('wallet id', wallet_id);
        };
        retrieveWalletInformation();
    }, [retrieve]);

    const fetchData = () => {
        setRetrieve(prev => !prev);
    };

    const storeUTXOs = async() => {
        if (wallet_id) {
            const wallet_id_number = parseInt(wallet_id, 10);
            (await ManageUTXOs).checkNewUTXOs(wallet_id_number);
        }
    };

    const handleGenerateKeys = async () => {
        if (wallet_id != null) {
            const wallet_id_number = parseInt(wallet_id, 10);

            // Determine the highest address_index value
            let addressIndex = 0;  // Default starting address index
            if (keyPairs.length > 0) {
                const highestAddressIndex = Math.max(...keyPairs.map(keyPair => keyPair.addressIndex));
                addressIndex = highestAddressIndex + 1;  // Increment the highest address index by 1
            }

            await KeyManage.createKeys(
                wallet_id_number, 
                0,  // accountNumber
                0,  // changeNumber
                addressIndex,  // addressIndex
            );
            await dbService.saveDatabaseToFile();
            fetchData();
        }
    };

    const handleUseForTransaction = async(address : string) => {
        navigate(`/createtransaction/${address}`);
    };

    const uint8ArrayToHexString = (array: Uint8Array) => {
        return Array.from(array).map(byte => byte.toString(16).padStart(2, '0')).join('');
    };

    const deleteWallet = async() => {
        if (!wallet_id) {
            return;
        }
        const wallet_id_number = parseInt(wallet_id, 10);
        const checkDelete = await WalletManage.deleteWallet(wallet_id_number);
        if (checkDelete) {
            console.log("Deleted Successfully");
            navigate(`/`);
        }
    };

    return (
        <>
            <section className='flex flex-col min-h-screen'>
                <div>Hello {wallet_id} </div>
                <div>Generate Public/Private Key here:</div>
                <button onClick={handleGenerateKeys}>Generate</button>
                <div>
                    {keyPairs.map((keyPair, index) => (
                        <div key={index}>
                            <p>Public Key: {uint8ArrayToHexString(keyPair.publicKey)}</p>
                            <p>Private Key: {uint8ArrayToHexString(keyPair.privateKey)}</p>
                            <p>Address: {keyPair.address}</p>
                            <button onClick={() => { handleUseForTransaction(keyPair.address); }}>Use For Transaction</button>
                        </div>
                    ))}
                </div>
                <button onClick={storeUTXOs}>sdhflsdkfs</button>
                <button onClick={deleteWallet}>delete wallet</button>
            </section>
        </>
    );
};

export default Home;

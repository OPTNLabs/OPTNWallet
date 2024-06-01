import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import KeyManager from '../apis/WalletManager/KeyManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';

const Home = () => {
    const [keyPairs, setKeyPairs] = useState<{ id: number, publicKey: Uint8Array; privateKey: Uint8Array; address: string }[]>([]);
    const [retrieve, setRetrieve] = useState(false);
    const KeyManage = KeyManager();
    const dbService = DatabaseService();
    const navigate = useNavigate();
    const { wallet_id } = useParams<{ wallet_id: string }>();

    useEffect(() => {
        const retrieveWalletInformation = async () => {
            if (wallet_id) {
                const walletKeys = await KeyManage.retrieveKeys(wallet_id);
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

    const handleGenerateKeys = async () => {
        if (wallet_id != null) {
            await KeyManage.createKeys(wallet_id, keyPairs.length);
            await dbService.saveDatabaseToFile();
            fetchData();
        }
    };

    const handleUseForTransaction = async(address : string) => {
        navigate(`/createtransaction/${address}`)
    }

    const uint8ArrayToHexString = (array: Uint8Array) => {
        return Array.from(array).map(byte => byte.toString(16).padStart(2, '0')).join('');
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
                            <button onClick = {() => {handleUseForTransaction(keyPair.address)} }>Use For Transaction</button>
                        </div>
                    ))}
                </div>
            </section>
        </>
    );
};

export default Home;

// @ts-nocheck
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import KeyManager from '../apis/WalletManager/KeyManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import WalletManager from '../apis/WalletManager/WalletManager';

const Home = () => {
    const [keyPairs, setKeyPairs] = useState<{ id: number, publicKey: Uint8Array; privateKey: Uint8Array; address: string }[]>([]);
    const [retrieve, setRetrieve] = useState(false);
    const [utxos, setUtxos] = useState<{ [address: string]: any[] }>({});
    const [addressIndex, setAddressIndex] = useState(0);
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
                setAddressIndex(walletKeys.length); // Set address index based on the number of keys
                await fetchUTXOs(walletKeys);
            }
            console.log('wallet id', wallet_id);
        };
        retrieveWalletInformation();
    }, [retrieve]);

    const fetchData = () => {
        setRetrieve(prev => !prev);
    };

    const storeUTXOs = async () => {
        if (wallet_id) {
            const wallet_id_number = parseInt(wallet_id, 10);
            await (await ManageUTXOs).checkNewUTXOs(wallet_id_number);
            fetchData(); // Fetch data again after storing UTXOs to refresh the view
        }
    }

    const fetchUTXOs = async (walletKeys: { id: number, publicKey: Uint8Array; privateKey: Uint8Array; address: string }[]) => {
        const utxosMap: { [address: string]: any[] } = {};
        const uniqueUTXOs = new Set(); // To ensure uniqueness of UTXOs

        for (const key of walletKeys) {
            const addressUTXOs = await (await ManageUTXOs).fetchUTXOs(parseInt(wallet_id!, 10));
            utxosMap[key.address] = addressUTXOs.filter((utxo) => {
                const utxoKey = `${utxo.tx_hash}-${utxo.tx_pos}-${utxo.address}`;
                if (uniqueUTXOs.has(utxoKey)) {
                    return false;
                }
                if (utxo.address === key.address) {
                    uniqueUTXOs.add(utxoKey);
                    return true;
                }
                return false;
            });
        }
        console.log('UTXOs Map:', utxosMap);
        setUtxos(utxosMap);
    };

    const handleGenerateKeys = async () => {
        if (wallet_id != null) {
            const wallet_id_number = parseInt(wallet_id, 10);
            await KeyManage.createKeys(
                wallet_id_number,
                0,  // accountNumber
                0,  // changeNumber
                addressIndex  // addressNumber based on the number of existing keys
            );
            await dbService.saveDatabaseToFile();
            fetchData();
        }
    };

    const handleUseForTransaction = async (address: string) => {
        navigate(`/createtransaction/${address}`)
    }

    const uint8ArrayToHexString = (array: Uint8Array) => {
        return Array.from(array).map(byte => byte.toString(16).padStart(2, '0')).join('');
    };

    const deleteWallet = async () => {
        if (!wallet_id) {
            return;
        }
        const wallet_id_number = parseInt(wallet_id, 10);
        const checkDelete = await WalletManage.deleteWallet(wallet_id_number);
        if (checkDelete) {
            console.log("Deleted Successfully");
            navigate(`/`);
        }
    }

    const buildTransaction = async () => {
        navigate(`/transaction/`)
    }

    return (
        <>
            <section className='flex flex-col min-h-screen'>
                <div>Hello {wallet_id} </div>
                <div>Generate Public/Private Key here:</div>
                <button onClick={handleGenerateKeys}>Generate</button>
                <div>
                    {console.log("keypairs: ", keyPairs)}
                    {keyPairs.map((keyPair, index) => (
                        <div key={index}>
                            <p>Public Key: {uint8ArrayToHexString(keyPair.publicKey)}</p>
                            <p>Private Key: {uint8ArrayToHexString(keyPair.privateKey)}</p>
                            <p>Address: {keyPair.address}</p>
                            <button onClick={() => { handleUseForTransaction(keyPair.address) }}>Use For Transaction</button>
                            <div>
                                <h4>UTXOs:</h4>
                                {console.log(`${index} ${keyPair.address}:`, utxos[keyPair.address])}
                                {utxos[keyPair.address] && utxos[keyPair.address].map((utxo, idx) => (
                                    <div key={idx}>
                                        <p>Amount: {utxo.amount}</p>
                                        <p>Transaction Hash: {utxo.tx_hash}</p>
                                        <p>Position: {utxo.tx_pos}</p>
                                        <p>Height: {utxo.height}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
                <button onClick={storeUTXOs}>Check UTXOs</button>
                <button onClick={buildTransaction}>Build Transaction</button>
                <button onClick={deleteWallet}>delete wallet</button>
            </section>
        </>
    );
};

export default Home;

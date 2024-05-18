import React, { useState, useEffect } from 'react'
import KeyGeneration from '../apis/WalletService/KeyGeneration'
import { useParams } from 'react-router-dom';
import KeyManager from '../apis/WalletService/KeyManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';

const Home = () => {
    const [keyPairs, setKeyPairs] = useState<{ publicKey: string; privateKey: string; addresses: string[] }[]>([]);
    const KeyGen = KeyGeneration();
    const KeyManage = KeyManager();
    const dbService = DatabaseService();

    const { wallet_id } = useParams<{ wallet_id: string }>();

    useEffect(() => {
        const retrieveWalletInformation = async () => {
            if (wallet_id) {
                const walletKeys = await KeyManage.retrieveKeys(wallet_id);
                console.log("wallet keys", walletKeys)
                setKeyPairs(walletKeys)
            }
            console.log('wallet id', wallet_id)
        }
        retrieveWalletInformation();
    }, []);
    const handleGenerateKeys = async() => {
        if (wallet_id != null) {
            KeyManage.createKeys(wallet_id)
            await dbService.saveDatabaseToFile();
        }
    }
    return (
        <>
            <section className = 'flex flex-col min-h-screen'>
                <div>Hello {wallet_id} </div>
                <div>Generate Public/Private Key here:</div>
                <button onClick = {handleGenerateKeys }>Generate</button>
                <div>
                {keyPairs.map((keyPair, index) => (
                    <div key={index}>
                        <p>Public Key: {keyPair.publicKey}</p>
                        <p>Private Key: {keyPair.privateKey}</p>
                    </div>
                ))}
            </div>
            </section>
        </>
    )
}

export default Home
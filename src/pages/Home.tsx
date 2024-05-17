import React, { useState, useEffect } from 'react'
import KeyGeneration from '../apis/WalletService/KeyGeneration'
import { useParams } from 'react-router-dom';
import KeyManager from '../apis/WalletService/KeyManager';

const Home = () => {
    const [keyPairs, setKeyPairs] = useState<{ publicKey: string; privateKey: string; }[]>([]);
    const [mnemonic, setMnemonicPhrase] = useState("");
    const KeyGen = KeyGeneration();
    const KeyManage = KeyManager();

    const { wallet_id } = useParams<{ wallet_id: string }>();

    useEffect(() => {
        if (wallet_id) {
            const walletKeys = KeyManage.retrieveKeys(wallet_id);
            setKeyPairs(walletKeys)
        }
        console.log(wallet_id)
    }, [wallet_id]);
    const handleGenerateKeys = () => {

    }
    return (
        <>
            <section className = 'flex flex-col min-h-screen bg-black'>
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
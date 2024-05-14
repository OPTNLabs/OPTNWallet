import React, { useState, useEffect } from 'react'
import { generateMnemonic } from '../apis/WalletService/KeyGeneration';

const WalletCreation = () => {
    const [mnemonicPhrase, setMnemonicPhrase] = useState("");
    useEffect(() => {
        generateMnemonicPhrase()
    }, [])

    const generateMnemonicPhrase = () => {
        const mnemonic = generateMnemonic();
        setMnemonicPhrase(mnemonic)
    }
  return (
    <>
        <div className = 'wallet-create-box'>
            <div className = 'text-black font-bold text-xl'>Generated Mnemonic:</div>
            <div className = 'text-center'>{ mnemonicPhrase }</div>

            <button></button>
        </div>
    </>
  )
}

export default WalletCreation
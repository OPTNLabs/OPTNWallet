import React, { useState, useEffect } from "react";
import { useNavigate } from 'react-router-dom';
import { generateMnemonic } from "../apis/WalletService/KeyGeneration";
import DatabaseService from "../apis/DatabaseManager/DatabaseService";

const WalletCreation = () => {
  const [mnemonicPhrase, setMnemonicPhrase] = useState("");
  const [walletName, setWalletName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const dbService = DatabaseService();
  const navigate = useNavigate();

  useEffect(() => {
    const dbStarted = dbService.startDatabase();
    if (dbStarted != null) {
        console.log("Database has been started.")
        console.log("Database:", dbStarted)
    }
    generateMnemonicPhrase();
  }, []);

  const generateMnemonicPhrase = () => {
    const mnemonic = generateMnemonic();
    setMnemonicPhrase(mnemonic);
  };

  const handleCreateAccount = async () => {
    const dbService = DatabaseService();
    const queryResult = await dbService.createWallet(walletName, mnemonicPhrase, passphrase);
    console.log("Query result:", JSON.stringify(queryResult, null, 2));
    if (queryResult != null) {
        navigate("/home")
    }
  };

  return (
    <>
      <div className="wallet-create-box">
        <div className="text-black font-bold text-xl">Generated Mnemonic:</div>
        <div className="text-center">{mnemonicPhrase}</div>
        <div>set your wallet Name</div>
        <input
          onChange={(e) => {
            setWalletName(e.target.value);
          }}
        ></input>
        <div>set passphrase</div>
        <input
          onChange={(e) => {
            setPassphrase(e.target.value);
          }}
        ></input>
        <button onClick={handleCreateAccount}>create account</button>
      </div>
    </>
  );
};

export default WalletCreation;

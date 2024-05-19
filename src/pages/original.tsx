import React, { useState, useEffect } from 'react'
import { generateMnemonic, generateKeys } from '../apis/WalletService/KeyGeneration'
import ElectrumService from '../apis/ElectrumServer/ElectrumServer';
import Transactions from '../apis/TransactionService/TransactionBuilder';

const LandingPage = () => {
    const [mnemonicPhrase, setMnemonicPhrase] = useState("");
    const [passphrase, setPassphrase] = useState("");
    const [publicKey, setPublicKey] = useState("");
    const [address, setAddress] = useState("");
    const [privateKey, setPrivateKey] = useState<Uint8Array | null>(null)
    const [inputAddress, setInputAddress] = useState("");
    const [inputAmount, setInputAmount] = useState("");
    const [bchBalance, setBchBalance] = useState("");
    const [coin, setCoin] = useState("");
    const [utxos, setUtxos] = useState([]);
    const Electrum = ElectrumService();
    const Transaction = Transactions();
    useEffect(()=> {
        async function startServer() {
          try {
              await Electrum.electrumConnect()
              console.log('Successfully connected to the Chipnet network');
          } catch (error) {
              console.error('An error occurred:', error);
          }
      }
      startServer();
    }, []);

    const handleGenerateMnemonic = async () => {
      const mnemonic = await generateMnemonic();
      setMnemonicPhrase(mnemonic);
    };

    const generateKey = async () => {
      try {
        const keys = await generateKeys(mnemonicPhrase, passphrase, coin);
        console.log(keys)
        setAddress(keys.aliceAddress)
        setPrivateKey(keys.alicePriv)
        setPublicKey(keys.changeAddress)
      } catch (error) {
        console.log(error);
      };
    };

    const handleDisconnectServer = async() => {
        await Electrum.electrumDisconnect(true);
        console.log('Disconnected from the network');
    }

    const handleRequestBalance = async() => {
      const address1 = inputAddress;
      const balance = await Electrum.getBalance(address1);
      setBchBalance(balance);
    }

    const handleGetUtxos = async() => {
      const address1 = inputAddress;
      const utxoValues = await Electrum.getUTXOS(address1)
      console.log(utxoValues);
      setUtxos(utxoValues);

    };

    const handleBuildTransaction = async() => {
      console.log(utxos[0])
      const recipients = [{ address: "bchtest:qpeu8h6p5r8kvlplaaz79jcq562qxyv8v5v0s4ajp6", amount: 2000 }, { address : "bchtest:qz82a87a7gef965jcq3pm49wkrrvfyafj57ugjd8fz", amount: 2000 } ]
      const transaction = await Transaction.buildTransaction(utxos[0], recipients)
      const Electrum = ElectrumService();
      const result = await Electrum.broadcastTransaction(transaction.hex);
      console.log(result)
      const isSuccess = result === transaction.txid;
      console.log(isSuccess)
    };

    return (
      <>
        <div className = "">Landing Page</div>
        <div>Set Passphrase</div>
        <input onChange={(e) => {
            setPassphrase(e.target.value);
        }}></input>
        <div>Mnemonic Value: { mnemonicPhrase }</div>
        <button onClick = { handleGenerateMnemonic }>Generate Mnemonic</button>

        <div>Public Key: { publicKey }</div>
        <div>Address: { address }</div>
        <div>Private Key: { privateKey }</div>
        <button onClick = { generateKey } >Generate Keys</button>

        <input placeholder = "set coin" onChange={(e) => {
            setCoin(e.target.value);
        }} ></input>

        <button onClick = { handleDisconnectServer }>Disconnect server</button>

        <div>balance: { bchBalance }</div>

        <button onClick = {handleRequestBalance}> request balance</button>

        <div>input address to send to: </div>
        <input onChange = {(e) => {
          setInputAddress(e.target.value);
        }}></input>
        <div>input amount to send: </div>
        <input onChange = {(e) => {
          setInputAmount(e.target.value);
        }}></input>
        <button onClick = { handleGetUtxos }> get utxos</button>

        <button onClick = { handleBuildTransaction }>build transaction</button>

        
      </>
  )
}

export default LandingPage
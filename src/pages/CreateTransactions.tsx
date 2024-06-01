import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import ElectrumService from '../apis/ElectrumServer/ElectrumServer';
import Transactions from '../apis/TranasactionManager/TransactionBuilder';

const CreateTransactions = () => {
  const { sendAddress } = useParams<{ sendAddress: string }>();
  const [transactionSendAddress, setTransactionSendAddress] = useState<string>("");
  const [recipients, setRecipients] = useState<{ address: string, amount: number }[]>([]);
  const [utxos, setUtxos] = useState<any[]>([]);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [recipientAmount, setRecipientAmount] = useState<number>(1000);
  const [signPrivateKey, setSignPrivateKey] = useState<string>("");
  const Electrum = ElectrumService();
  const TransactionBuilder = Transactions();

  useEffect(() => {
    if (sendAddress != null) {
      setTransactionSendAddress(sendAddress);
    }
    async function startServer() {
      try {
        await Electrum.electrumConnect();
        console.log('Successfully connected to the Chipnet network');
      } catch (error) {
        console.error('An error occurred:', error);
      }
    }
    startServer();
  }, [sendAddress]);

  const handleGenerateUTXOs = async () => {
    const address = transactionSendAddress;
    console.log('address', address)
    if (address) {
      const utxoValues = await Electrum.getUTXOS(address);
      console.log(utxoValues);
      setUtxos(utxoValues);
    }
  };

  const handleAddRecipient = () => {
    if (recipientAddress && recipientAmount > 0) {
      setRecipients(prevRecipients => [...prevRecipients, { address: recipientAddress, amount: recipientAmount }]);
      setRecipientAddress("");
      setRecipientAmount(0);
    }
  };

  const hexStringToUint8Array = (hexString: string): Uint8Array => {
    if (hexString.length % 2 !== 0) {
      throw new Error("Invalid hex string");
    }
    const array = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      array[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
    }
    return array;
  };

  const handleMakeTransaction = async () => {
    try {
      const privateKeyUint8Array = hexStringToUint8Array(signPrivateKey);
      const transaction = await TransactionBuilder.buildTransaction(
        utxos,
        recipients,
        privateKeyUint8Array
      );
      console.log(transaction)
      if (transaction != null) {
        const result = await Electrum.broadcastTransaction(transaction.hex);
        console.log(result)
        const isSuccess = result === transaction.txid;
        console.log("Transaction Success??", isSuccess)
      }
    } catch (error) {
      console.error("Error building transaction:", error);
    }
  };

  return (
    <>
      <section>
        <div>Sending from: {transactionSendAddress}</div>
        <button onClick={handleGenerateUTXOs}>Generate UTXOs</button>
        <input
          type="text"
          value={signPrivateKey}
          onChange={(e) => setSignPrivateKey(e.target.value)}
          placeholder="Private Key"
        />
        <div>
          {utxos.map((utxo, index) => (
            <div key={index}>
              <p>Transaction ID: {utxo.txid}</p>
              <p>Output Index: {utxo.vout}</p>
              <p>Amount: {utxo.amount}</p>
            </div>
          ))}
        </div>
        <div>
          <input
            type="text"
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            placeholder="Recipient Address"
          />
          <input
            type="number"
            value={recipientAmount}
            onChange={(e) => setRecipientAmount(Number(e.target.value))}
            placeholder="Amount"
          />
          <button onClick={handleAddRecipient}>Add Recipient</button>
        </div>
        <div>
          {recipients.map((recipient, index) => (
            <div key={index}>
              <p>Recipient Address: {recipient.address}</p>
              <p>Amount: {recipient.amount}</p>
            </div>
          ))}
        </div>
        <button onClick = { handleMakeTransaction }>Make the transaction</button>
      </section>
    </>
  );
};

export default CreateTransactions;

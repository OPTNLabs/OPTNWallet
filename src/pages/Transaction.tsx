// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import TransactionBuilders from '../apis/TransactionManager/TransactionBuilder3';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';

interface UTXO {
  id: number;
  address: string;
  amount: number;
  tx_hash: string;
  tx_pos: number;
  privateKey: Uint8Array;
}

interface TransactionOutput {
  recipientAddress: string;
  amount: number;
}

const Transaction = () => {
  const [walletId, setWalletId] = useState<number | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>([]);
  const [utxos, setUtxos] = useState<UTXO[]>([]);
  const [selectedUtxos, setSelectedUtxos] = useState<UTXO[]>([]);
  const [outputs, setOutputs] = useState<TransactionOutput[]>([]);
  const [recipientAddress, setRecipientAddress] = useState('');
  const [transferAmount, setTransferAmount] = useState<number | string>('');
  const [rawTX, setRawTX] = useState('');
  const [transactionId, setTransactionId] = useState('');

  useEffect(() => {
    const fetchWalletId = async () => {
      const activeWalletId = 1; // Replace this with the actual logic to fetch the active wallet ID
      setWalletId(activeWalletId);
    };
    fetchWalletId();
  }, []);

  useEffect(() => {
    const fetchAddressesAndUTXOs = async (walletId: number) => {
      const dbService = DatabaseService();
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      const addressesQuery = `SELECT address FROM addresses WHERE wallet_id = ?`;
      const addressesStatement = db.prepare(addressesQuery);
      addressesStatement.bind([walletId]);
      const fetchedAddresses: string[] = [];
      while (addressesStatement.step()) {
        const row = addressesStatement.getAsObject();
        fetchedAddresses.push(row.address as string);
      }
      addressesStatement.free();
      setAddresses(fetchedAddresses);

      const utxosQuery = `SELECT * FROM UTXOs WHERE wallet_id = ?`;
      const utxosStatement = db.prepare(utxosQuery);
      utxosStatement.bind([walletId]);
      const fetchedUTXOs: UTXO[] = [];
      const utxoSet = new Set();
      while (utxosStatement.step()) {
        const row = utxosStatement.getAsObject();
        const utxoKey = `${row.tx_hash}-${row.tx_pos}`;
        if (!utxoSet.has(utxoKey)) {
          utxoSet.add(utxoKey);
          fetchedUTXOs.push({
            id: row.id as number,
            address: row.address as string,
            amount: row.amount as number,
            tx_hash: row.tx_hash as string,
            tx_pos: row.tx_pos as number,
            privateKey: await fetchPrivateKey(walletId, row.address),
          });
        }
      }
      utxosStatement.free();
      setUtxos(fetchedUTXOs);
    };

    const fetchPrivateKey = async (
      walletId: number,
      address: string
    ): Promise<Uint8Array> => {
      const dbService = DatabaseService();
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      const privateKeyQuery = `SELECT private_key FROM keys WHERE wallet_id = ? AND address = ?`;
      const privateKeyStatement = db.prepare(privateKeyQuery);
      privateKeyStatement.bind([walletId, address]);
      let privateKey = new Uint8Array();
      while (privateKeyStatement.step()) {
        const row = privateKeyStatement.getAsObject();
        privateKey = new Uint8Array(row.private_key);
      }
      privateKeyStatement.free();
      return privateKey;
    };

    if (walletId !== null) {
      fetchAddressesAndUTXOs(walletId);
    }
  }, [walletId]);

  const toggleAddressSelection = (address: string) => {
    if (selectedAddresses.includes(address)) {
      setSelectedAddresses(
        selectedAddresses.filter(
          (selectedAddress) => selectedAddress !== address
        )
      );
    } else {
      setSelectedAddresses([...selectedAddresses, address]);
    }
  };

  const toggleUtxoSelection = (utxo: UTXO) => {
    if (selectedUtxos.some((selectedUtxo) => selectedUtxo.id === utxo.id)) {
      setSelectedUtxos(
        selectedUtxos.filter((selectedUtxo) => selectedUtxo.id !== utxo.id)
      );
    } else {
      setSelectedUtxos([...selectedUtxos, utxo]);
    }
  };

  const addOutput = () => {
    if (recipientAddress && transferAmount) {
      setOutputs([
        ...outputs,
        { recipientAddress, amount: Number(transferAmount) },
      ]);
      setRecipientAddress('');
      setTransferAmount('');
    }
  };

  const removeOutput = (index: number) => {
    setOutputs(outputs.filter((_, i) => i !== index));
  };

  const buildTransaction = async () => {
    const txBuilder = TransactionBuilders();
    try {
      const transaction = await txBuilder.buildTransaction(
        selectedUtxos,
        outputs
      );
      console.log('Built Transaction:', transaction);
      setRawTX(transaction);
    } catch (error) {
      console.error('Error building transaction:', error);
      setRawTX('');
    }
  };

  const sendTransaction = async () => {
    const txBuilder = TransactionBuilders();
    try {
      const txid = await txBuilder.sendTransaction(rawTX);
      console.log('Sent Transaction:', txid);
      setTransactionId(txid);
    } catch (error) {
      console.error('Error sending transaction:', error);
    }
  };

  return (
    <div className="container mx-auto p-4">
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Select Addresses to Spend From
        </h3>
        {addresses.map((address, index) => (
          <div key={index} className="flex items-center mb-2">
            <input
              type="checkbox"
              checked={selectedAddresses.includes(address)}
              onChange={() => toggleAddressSelection(address)}
              className="mr-2"
            />
            <span>{`Address: ${address}`}</span>
          </div>
        ))}
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Available UTXOs</h3>
        {utxos
          .filter((utxo) => selectedAddresses.includes(utxo.address))
          .map((utxo, index) => (
            <div key={index} className="flex items-center mb-2">
              <input
                type="checkbox"
                checked={selectedUtxos.some(
                  (selectedUtxo) => selectedUtxo.id === utxo.id
                )}
                onChange={() => toggleUtxoSelection(utxo)}
                className="mr-2"
              />
              <span>{`Address: ${utxo.address}, Amount: ${utxo.amount}`}</span>
            </div>
          ))}
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Transaction Outputs</h3>
        {outputs.map((output, index) => (
          <div key={index} className="flex items-center mb-2">
            <span>{`Recipient: ${output.recipientAddress}, Amount: ${output.amount}`}</span>
            <button
              onClick={() => removeOutput(index)}
              className="ml-2 text-red-500"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Add Output</h3>
        <input
          type="text"
          value={recipientAddress}
          placeholder="Recipient Address"
          onChange={(e) => setRecipientAddress(e.target.value)}
          className="border p-2 mb-2 w-full"
        />
        <input
          type="number"
          value={transferAmount}
          placeholder="Amount"
          onChange={(e) => setTransferAmount(e.target.value)}
          className="border p-2 mb-2 w-full"
        />
        <button
          onClick={addOutput}
          className="bg-blue-500 text-white py-2 px-4 rounded"
        >
          Add Output
        </button>
      </div>
      <div className="mb-6">
        <button
          onClick={buildTransaction}
          className="bg-green-500 text-white py-2 px-4 rounded mr-2"
        >
          Build Transaction
        </button>
        <button
          onClick={sendTransaction}
          className="bg-red-500 text-white py-2 px-4 rounded"
        >
          Send Transaction
        </button>
      </div>
      {rawTX !== '' && (
        <div className="text-lg font-semibold">{transactionId}</div>
      )}
    </div>
  );
};

export default Transaction;

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

  useEffect(() => {
    const fetchWalletId = async () => {
      // Simulate fetching the current active wallet ID
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

      // Fetch addresses
      const addressesQuery = `SELECT address FROM addresses WHERE wallet_id = ?`;
      const addressesStatement = db.prepare(addressesQuery);
      addressesStatement.bind([walletId]);
      const fetchedAddresses: string[] = [];
      while (addressesStatement.step()) {
        const row = addressesStatement.getAsObject();
        fetchedAddresses.push(row.address as string);
      }
      addressesStatement.free();
      // console.log("fetched addresses:", fetchedAddresses)
      setAddresses(fetchedAddresses);

      // Fetch UTXOs
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
            privateKey: await fetchPrivateKey(walletId, row.address), // Fetch the private key
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
      // Fetch the private key for the given address from the database or other secure storage
      // This is a placeholder implementation
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
    console.log(`Selected UTXOS - ${typeof selectedUtxos}:`, selectedUtxos);
    console.log(`Outputs - ${typeof outputs}:`, outputs);
    try {
      const transaction = await txBuilder.buildTransaction(
        selectedUtxos,
        outputs
      );
      console.log('Built Transaction:', transaction);
    } catch (error) {
      console.error('Error building transaction:', error);
    }
  };

  return (
    <div>
      <div>
        <h3>Select Addresses to Spend From</h3>
        {addresses.map((address, index) => (
          <div key={index}>
            <input
              type="checkbox"
              checked={selectedAddresses.includes(address)}
              onChange={() => toggleAddressSelection(address)}
            />
            <span>{`Address: ${address}`}</span>
          </div>
        ))}
      </div>
      <div>
        <h3>Available UTXOs</h3>
        {utxos
          .filter((utxo) => selectedAddresses.includes(utxo.address))
          .map((utxo, index) => (
            <div key={index}>
              <input
                type="checkbox"
                checked={selectedUtxos.some(
                  (selectedUtxo) => selectedUtxo.id === utxo.id
                )}
                onChange={() => toggleUtxoSelection(utxo)}
              />
              <span>{`Address: ${utxo.address}, Amount: ${utxo.amount}`}</span>
            </div>
          ))}
      </div>
      <div>
        <h3>Transaction Outputs</h3>
        {outputs.map((output, index) => (
          <div key={index}>
            <span>{`Recipient: ${output.recipientAddress}, Amount: ${output.amount}`}</span>
            <button onClick={() => removeOutput(index)}>Remove</button>
          </div>
        ))}
      </div>
      <div>
        <h3>Add Output</h3>
        <input
          type="text"
          value={recipientAddress}
          placeholder="Recipient Address"
          onChange={(e) => setRecipientAddress(e.target.value)}
        />
        <input
          type="number"
          value={transferAmount}
          placeholder="Amount"
          onChange={(e) => setTransferAmount(e.target.value)}
        />
        <button onClick={addOutput}>Add Output</button>
      </div>
      <button onClick={buildTransaction}>Build Transaction</button>
    </div>
  );
};

export default Transaction;

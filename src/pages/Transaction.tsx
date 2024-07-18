// src/pages/Transaction.tsx

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import TransactionBuilders, {
  TransactionOutput,
  UTXO,
} from '../apis/TransactionManager/TransactionBuilder3';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';

interface ExtendedUTXO extends UTXO {
  id: number;
  height: number;
}

const Transaction: React.FC = () => {
  const [walletId, setWalletId] = useState<number | null>(null);
  const [addresses, setAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>([]);
  const [utxos, setUtxos] = useState<ExtendedUTXO[]>([]);
  const [selectedUtxos, setSelectedUtxos] = useState<ExtendedUTXO[]>([]);
  const [outputs, setOutputs] = useState<TransactionOutput[]>([]);
  const [recipientAddress, setRecipientAddress] = useState<string>('');
  const [transferAmount, setTransferAmount] = useState<number | string>('');
  const [tokenAmount, setTokenAmount] = useState<number | string>('');
  const [selectedTokenCategory, setSelectedTokenCategory] =
    useState<string>('');
  const [changeAddress, setChangeAddress] = useState<string>('');
  const [bytecodeSize, setBytecodeSize] = useState<number | null>(null);
  const [rawTX, setRawTX] = useState<string>('');
  const [transactionId, setTransactionId] = useState<string>('');
  const [finalOutputs, setFinalOutputs] = useState<TransactionOutput[]>([]);
  const navigate = useNavigate();

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

      if (!db) {
        throw new Error('Unable to get DB');
      }

      const addressesQuery = `SELECT address, token_address FROM keys WHERE wallet_id = ?`;
      const addressesStatement = db.prepare(addressesQuery);
      addressesStatement.bind([walletId]);
      const fetchedAddresses: { address: string; tokenAddress: string }[] = [];
      while (addressesStatement.step()) {
        const row = addressesStatement.getAsObject();
        if (
          typeof row.address === 'string' &&
          typeof row.token_address === 'string'
        ) {
          fetchedAddresses.push({
            address: row.address,
            tokenAddress: row.token_address,
          });
        }
      }
      addressesStatement.free();
      console.log('Fetched addresses:', fetchedAddresses); // Debug log
      setAddresses(fetchedAddresses);

      const utxosQuery = `SELECT * FROM UTXOs WHERE wallet_id = ?`;
      const utxosStatement = db.prepare(utxosQuery);
      utxosStatement.bind([walletId]);
      const fetchedUTXOs: ExtendedUTXO[] = [];
      while (utxosStatement.step()) {
        const row = utxosStatement.getAsObject();
        const addressInfo = fetchedAddresses.find(
          (addr) => addr.address === row.address
        );
        const privateKey = await fetchPrivateKey(walletId, row.address);
        if (
          privateKey &&
          typeof row.address === 'string' &&
          typeof row.amount === 'number' &&
          typeof row.tx_hash === 'string' &&
          typeof row.tx_pos === 'number' &&
          typeof row.height === 'number'
        ) {
          fetchedUTXOs.push({
            id: row.id as number,
            address: row.address,
            tokenAddress: addressInfo ? addressInfo.tokenAddress : '',
            amount: row.amount,
            tx_hash: row.tx_hash,
            tx_pos: row.tx_pos,
            height: row.height,
            privateKey: privateKey,
            token_data: row.token_data ? JSON.parse(row.token_data) : undefined,
          });
        } else {
          console.error('Private key not found for address:', row.address);
        }
      }
      utxosStatement.free();
      console.log('Fetched UTXOs:', fetchedUTXOs); // Debug log
      setUtxos(fetchedUTXOs);
    };

    const fetchPrivateKey = async (
      walletId: number,
      address: string
    ): Promise<Uint8Array | null> => {
      const dbService = DatabaseService();
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      const privateKeyQuery = `SELECT private_key FROM keys WHERE wallet_id = ? AND address = ?`;
      const privateKeyStatement = db.prepare(privateKeyQuery);
      privateKeyStatement.bind([walletId, address]);
      let privateKey = new Uint8Array();
      while (privateKeyStatement.step()) {
        const row = privateKeyStatement.getAsObject();
        if (row.private_key) {
          privateKey = new Uint8Array(row.private_key);
        }
      }
      privateKeyStatement.free();
      return privateKey.length > 0 ? privateKey : null;
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

  const handleUtxoClick = (utxo: ExtendedUTXO) => {
    setSelectedUtxos((prevSelectedUtxos) => {
      if (
        prevSelectedUtxos.some((selectedUtxo) => selectedUtxo.id === utxo.id)
      ) {
        return prevSelectedUtxos.filter(
          (selectedUtxo) => selectedUtxo.id !== utxo.id
        );
      } else {
        return [...prevSelectedUtxos, utxo];
      }
    });
  };

  const addOutput = () => {
    if (recipientAddress && (transferAmount || tokenAmount)) {
      const newOutput: TransactionOutput = {
        recipientAddress,
        amount: Number(transferAmount) || 0,
      };

      if (selectedTokenCategory) {
        const tokenUTXO = selectedUtxos.find(
          (utxo) =>
            utxo.token_data &&
            utxo.token_data.category === selectedTokenCategory
        );

        if (tokenUTXO && tokenUTXO.token_data) {
          newOutput.token = {
            amount: Number(tokenAmount),
            category: tokenUTXO.token_data.category,
          };
          // Use the CashToken address format if token is included
          const tokenAddress = addresses.find(
            (addr) => addr.address === recipientAddress
          )?.tokenAddress;
          if (tokenAddress) {
            newOutput.recipientAddress = tokenAddress;
          }
        }
      }

      setOutputs([...outputs, newOutput]);
      setRecipientAddress('');
      setTransferAmount('');
      setTokenAmount('');
      setSelectedTokenCategory('');
    }
  };

  const removeOutput = (index: number) => {
    setOutputs(outputs.filter((_, i) => i !== index));
  };

  const buildTransaction = async () => {
    const txBuilder = TransactionBuilders();
    console.log(`Selected UTXOs: ${JSON.stringify(selectedUtxos, null, 2)}`);
    console.log(`txOutputs: ${JSON.stringify(outputs, null, 2)}`);
    try {
      // Add the change address with a placeholder value of 546 satoshis
      const placeholderOutput = {
        recipientAddress: changeAddress,
        amount: 546,
      };
      const txOutputs = [...outputs, placeholderOutput];

      // Build the transaction with the placeholder
      const transaction = await txBuilder.buildTransaction(
        selectedUtxos,
        txOutputs
      );
      console.log('Built Transaction with Placeholder:', transaction);

      if (transaction) {
        // Calculate bytecode size
        const bytecodeSize = transaction.length / 2;
        setBytecodeSize(bytecodeSize);

        // Calculate total selected UTXO amount
        const totalUtxoAmount = selectedUtxos.reduce(
          (sum, utxo) => sum + utxo.amount,
          0
        );

        // Calculate total output amount
        const totalOutputAmount = outputs.reduce(
          (sum, output) => sum + output.amount,
          0
        );

        // Calculate remainder
        const remainder = totalUtxoAmount - totalOutputAmount - bytecodeSize;

        // Remove the placeholder output
        txOutputs.pop();

        // Add the change address with the actual remainder
        if (changeAddress && remainder > 0) {
          txOutputs.push({
            recipientAddress: changeAddress,
            amount: remainder,
          });
        }

        // Build the final transaction
        const finalTransaction = await txBuilder.buildTransaction(
          selectedUtxos,
          txOutputs
        );
        console.log(
          `Selected UTXOs: ${JSON.stringify(selectedUtxos, null, 2)}`
        );
        console.log(`txOutputs: ${JSON.stringify(txOutputs, null, 2)}`);
        console.log('Final Transaction:', txBuilder);
        console.log('Built Final Transaction:', finalTransaction);
        setRawTX(finalTransaction);
        setFinalOutputs(txOutputs); // Set final outputs to render
      } else {
        setRawTX('');
      }
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

  const returnHome = async () => {
    navigate(`/home/${walletId}`);
  };

  const totalSelectedUtxoAmount = selectedUtxos.reduce(
    (sum, utxo) => sum + utxo.amount,
    0
  );

  const availableTokenCategories = [
    ...new Set(
      utxos
        .filter((utxo) => utxo.token_data)
        .map((utxo) => utxo.token_data!.category)
    ),
  ];

  return (
    <div className="container mx-auto p-4 overflow-x-hidden">
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Select Addresses to Spend From
        </h3>
        {addresses.map((addressObj, index) => (
          <div
            key={index}
            className="flex items-center mb-2 break-words whitespace-normal"
          >
            <input
              type="checkbox"
              checked={selectedAddresses.includes(addressObj.address)}
              onChange={() => toggleAddressSelection(addressObj.address)}
              className="mr-2"
            />
            <span className="break-words">{`Address: ${addressObj.address}, Token Address: ${addressObj.tokenAddress}`}</span>
          </div>
        ))}
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Regular UTXOs</h3>
        {addresses
          .filter((addressObj) =>
            selectedAddresses.includes(addressObj.address)
          )
          .map((addressObj, index) => (
            <div key={index} className="p-2 border rounded-lg mb-2">
              {utxos
                .filter(
                  (utxo) =>
                    utxo.address === addressObj.address && !utxo.token_data
                )
                .map((utxo) => (
                  <button
                    key={utxo.id}
                    onClick={() => handleUtxoClick(utxo)}
                    className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                      selectedUtxos.some(
                        (selectedUtxo) => selectedUtxo.id === utxo.id
                      )
                        ? 'bg-blue-100'
                        : 'bg-white'
                    }`}
                  >
                    <RegularUTXOs
                      address={addressObj.address}
                      utxos={[utxo]}
                      loading={false}
                    />
                  </button>
                ))}
            </div>
          ))}
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">CashToken UTXOs</h3>
        {addresses
          .filter((addressObj) =>
            selectedAddresses.includes(addressObj.address)
          )
          .map((addressObj, index) => (
            <div key={index} className="p-2 border rounded-lg mb-2">
              {utxos
                .filter(
                  (utxo) =>
                    utxo.address === addressObj.address && utxo.token_data
                )
                .map((utxo) => (
                  <button
                    key={utxo.id}
                    onClick={() => handleUtxoClick(utxo)}
                    className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                      selectedUtxos.some(
                        (selectedUtxo) => selectedUtxo.id === utxo.id
                      )
                        ? 'bg-blue-100'
                        : 'bg-white'
                    }`}
                  >
                    <CashTokenUTXOs
                      address={addressObj.address}
                      utxos={[utxo]}
                      loading={false}
                    />
                  </button>
                ))}
            </div>
          ))}
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Selected Transaction Inputs
        </h3>
        {selectedUtxos.map((utxo, index) => (
          <div
            key={index}
            className="flex items-center mb-2 break-words whitespace-normal"
          >
            <span className="break-words">{`Address: ${utxo.address}, Amount: ${utxo.amount}, Tx Hash: ${utxo.tx_hash}, Position: ${utxo.tx_pos}, Height: ${utxo.height}`}</span>
          </div>
        ))}
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Transaction Outputs</h3>
        {outputs.map((output, index) => (
          <div
            key={index}
            className="flex items-center mb-2 break-words whitespace-normal"
          >
            <span className="break-words">{`Recipient: ${output.recipientAddress}, Amount: ${output.amount}`}</span>
            {output.token && (
              <span className="break-words">{`, Token: ${output.token.amount}, Category: ${output.token.category}`}</span>
            )}
            <button
              onClick={() => removeOutput(index)}
              className="ml-2 text-red-500"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      {finalOutputs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2">Final Outputs</h3>
          {finalOutputs.map((output, index) => (
            <div
              key={index}
              className="flex items-center mb-2 break-words whitespace-normal"
            >
              <span className="break-words">{`Recipient: ${output.recipientAddress}, Amount: ${output.amount}`}</span>
              {output.token && (
                <span className="break-words">{`, Token: ${output.token.amount}, Category: ${output.token.category}`}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Add Output</h3>
        <input
          type="text"
          value={recipientAddress}
          placeholder="Recipient Address"
          onChange={(e) => setRecipientAddress(e.target.value)}
          className="border p-2 mb-2 w-full break-words whitespace-normal"
        />
        <input
          type="number"
          value={transferAmount}
          placeholder="Regular Amount"
          onChange={(e) => setTransferAmount(e.target.value)}
          className="border p-2 mb-2 w-full break-words whitespace-normal"
        />
        <input
          type="number"
          value={tokenAmount}
          placeholder="Token Amount"
          onChange={(e) => setTokenAmount(e.target.value)}
          className="border p-2 mb-2 w-full break-words whitespace-normal"
        />
        {availableTokenCategories.length > 0 && (
          <select
            value={selectedTokenCategory}
            onChange={(e) => setSelectedTokenCategory(e.target.value)}
            className="border p-2 mb-2 w-full break-words whitespace-normal"
          >
            <option value="">Select Token Category</option>
            {availableTokenCategories.map((category, index) => (
              <option key={index} value={category}>
                {category}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={addOutput}
          className="bg-blue-500 text-white py-2 px-4 rounded"
        >
          Add Output
        </button>
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Change Address</h3>
        <input
          type="text"
          value={changeAddress}
          placeholder="Change Address"
          onChange={(e) => setChangeAddress(e.target.value)}
          className="border p-2 mb-2 w-full break-words whitespace-normal"
        />
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Total Selected UTXO Amount: {totalSelectedUtxoAmount}
        </h3>
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
      <button
        onClick={returnHome}
        className="bg-red-500 text-white py-2 px-4 rounded"
      >
        Go Back
      </button>
      {bytecodeSize !== null && (
        <div className="mb-6 break-words whitespace-normal">
          <h3 className="text-lg font-semibold mb-2">
            Bytecode Size: {bytecodeSize} bytes
          </h3>
        </div>
      )}
      {rawTX !== '' && (
        <div className="text-lg font-semibold break-words whitespace-normal">
          {rawTX}
        </div>
      )}
      {transactionId !== '' && (
        <div className="text-lg font-semibold break-words whitespace-normal">
          <a
            rel="stylesheet"
            href={`https://chipnet.imaginary.cash/tx/${transactionId}`}
          >
            {transactionId}
          </a>
        </div>
      )}
    </div>
  );
};

export default Transaction;

// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import TransactionBuilderHelper, {
  TransactionOutput,
  UTXO,
} from '../apis/TransactionManager/TransactionBuilderHelper';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';
import ContractManager from '../apis/ContractManager/ContractManager';
import SelectContractFunctionPopup from '../components/SelectContractFunctionPopup';
import {
  SignatureTemplate,
  ElectrumNetworkProvider,
  Network,
  HashType,
} from 'cashscript';
import { RootState } from '../redux/store';
import { setSelectedFunction, setInputs } from '../redux/contractSlice';

interface ExtendedUTXO extends UTXO {
  id: string;
  height: number;
  unlocker?: any;
}

const Transaction: React.FC = () => {
  const [walletId, setWalletId] = useState<number | null>(null);
  const [addresses, setAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [contractAddresses, setContractAddresses] = useState<
    {
      address: string;
      tokenAddress: string;
      contractName: string;
      abi: any[];
    }[]
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
  const [showPopup, setShowPopup] = useState(false);
  const [showRawTxPopup, setShowRawTxPopup] = useState(false); // State for rawTX pop-up
  const [showTxIdPopup, setShowTxIdPopup] = useState(false); // State for transactionId pop-up
  const [loading, setLoading] = useState(false); // State for loading spinner
  const [selectedContractAddresses, setSelectedContractAddresses] = useState<
    string[]
  >([]);
  const [selectedContractABIs, setSelectedContractABIs] = useState<any[]>([]);
  const [contractFunction, setContractFunction] = useState<string | null>(null);
  const [contractFunctionInputs, setContractFunctionInputs] = useState<
    any[] | null
  >(null);
  const [contractUTXOs, setContractUTXOs] = useState<ExtendedUTXO[]>([]);
  const [currentContractABI, setCurrentContractABI] = useState<any[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null); // State for error messages
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const selectedFunction = useSelector(
    (state: RootState) => state.contract.selectedFunction
  );
  const functionInputs = useSelector(
    (state: RootState) => state.contract.inputs
  );

  useEffect(() => {
    const fetchWalletId = async () => {
      const activeWalletId = 1;
      setWalletId(activeWalletId);
    };
    fetchWalletId();
  }, []);

  useEffect(() => {
    const fetchAddressesAndUTXOs = async (walletId: number) => {
      const dbService = DatabaseService();
      const contractManager = ContractManager();
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
      console.log('Fetched addresses:', fetchedAddresses);

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
            id: `${row.tx_hash}:${row.tx_pos}`,
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
      console.log('Fetched UTXOs:', fetchedUTXOs);

      const contractInstances = await contractManager.fetchContractInstances();
      console.log('Fetched contract instances:', contractInstances);

      const contractUTXOs = await Promise.all(
        contractInstances.map(async (contract) => {
          const contractUTXOs = contract.utxos;
          return contractUTXOs.map((utxo) => ({
            ...utxo,
            id: `${utxo.tx_hash}:${utxo.tx_pos}`,
            address: contract.address,
            tokenAddress: contract.token_address,
            contractName: contract.contract_name,
            abi: contract.abi,
          }));
        })
      ).then((results) => results.flat());

      console.log('Fetched contract UTXOs:', contractUTXOs);

      const allUTXOs = [...fetchedUTXOs, ...contractUTXOs];

      const addressesWithUTXOs = fetchedAddresses.filter((addressObj) =>
        allUTXOs.some((utxo) => utxo.address === addressObj.address)
      );
      setAddresses(addressesWithUTXOs);

      const contractAddressList = contractInstances.map((contract) => ({
        address: contract.address,
        tokenAddress: contract.token_address,
        contractName: contract.contract_name,
        abi: contract.abi,
      }));
      setContractAddresses(contractAddressList);

      setUtxos(allUTXOs);
      setContractUTXOs(contractUTXOs);
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

  const toggleContractSelection = (address: string, abi: {}) => {
    if (
      selectedContractAddresses.includes(address) &&
      selectedContractABIs.includes(abi)
    ) {
      setSelectedContractAddresses(
        selectedContractAddresses.filter(
          (selectedContractAddress) => selectedContractAddress !== address
        )
      );
      setSelectedContractABIs(
        selectedContractABIs.filter(
          (selectedContractABI) => selectedContractABI !== abi
        )
      );
    } else {
      setSelectedContractAddresses([...selectedContractAddresses, address]);
      setSelectedContractABIs([...selectedContractABIs, abi]);
    }
  };

  const handleUtxoClick = async (utxo: ExtendedUTXO) => {
    console.log('Selected UTXOs before function inputs:', selectedUtxos);
    const isSelected = selectedUtxos.some(
      (selectedUtxo) => selectedUtxo.id === utxo.id
    );

    if (isSelected) {
      setSelectedUtxos(
        selectedUtxos.filter((selectedUtxo) => selectedUtxo.id !== utxo.id)
      );
    } else {
      if (utxo.abi) {
        setCurrentContractABI(utxo.abi);
        setShowPopup(true);
        // Store UTXO temporarily until function is selected
        return;
      } else {
        const provider = new ElectrumNetworkProvider(Network.CHIPNET);
        const signatureTemplate = new SignatureTemplate(
          utxo.privateKey!,
          HashType.SIGHASH_ALL
        );
        const unlocker = signatureTemplate.unlockP2PKH();

        utxo = {
          ...utxo,
          unlocker,
        };

        setSelectedUtxos([...selectedUtxos, utxo]);
      }
    }

    console.log('Selected UTXOs after function inputs:', selectedUtxos);
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
    const txBuilder = TransactionBuilderHelper();
    console.log(`${selectedUtxos}`);
    console.log(`txOutputs: ${JSON.stringify(outputs, null, 2)}`);
    try {
      setLoading(true); // Show the loader
      const placeholderOutput = {
        recipientAddress: changeAddress,
        amount: 546,
      };
      const txOutputs = [...outputs, placeholderOutput];

      console.log(
        'Building transaction with placeholder output:',
        placeholderOutput
      );
      const transaction = await txBuilder.buildTransaction(
        selectedUtxos,
        txOutputs,
        selectedFunction,
        functionInputs
      );
      console.log('Built Transaction with Placeholder:', transaction);

      if (transaction) {
        const bytecodeSize = transaction.length / 2;
        setBytecodeSize(bytecodeSize);

        const totalUtxoAmount = selectedUtxos.reduce(
          (sum, utxo) => sum + BigInt(utxo.amount),
          BigInt(0)
        );

        const totalOutputAmount = outputs.reduce(
          (sum, output) => sum + BigInt(output.amount),
          BigInt(0)
        );

        const remainder =
          totalUtxoAmount - totalOutputAmount - BigInt(bytecodeSize);

        txOutputs.pop();

        if (changeAddress && remainder > BigInt(0)) {
          txOutputs.push({
            recipientAddress: changeAddress,
            amount: Number(remainder),
          });
        }

        console.log('Building final transaction with outputs:', txOutputs);
        const finalTransaction = await txBuilder.buildTransaction(
          selectedUtxos,
          txOutputs,
          selectedFunction,
          functionInputs
        );
        console.log(`Selected UTXOs: ${selectedUtxos}`);
        console.log(`txOutputs: ${JSON.stringify(txOutputs, null, 2)}`);
        console.log('Final Transaction:', finalTransaction);
        setRawTX(finalTransaction);
        setFinalOutputs(txOutputs);
        setErrorMessage(null); // Clear any previous error messages
        setShowRawTxPopup(true); // Show the raw transaction pop-up
      } else {
        setRawTX('');
      }
    } catch (error) {
      console.error('Error building transaction:', error);
      setRawTX('');
      setErrorMessage('Error building transaction: ' + error.message);
      setRawTX('');
      setShowRawTxPopup(true); // Show pop-up to display the error
    } finally {
      setLoading(false); // Hide the loader
    }
  };

  const sendTransaction = async () => {
    const txBuilder = TransactionBuilderHelper();
    try {
      const txid = await txBuilder.sendTransaction(rawTX);
      console.log('Sent Transaction:', txid);
      setTransactionId(txid);
      setShowTxIdPopup(true); // Show the transaction ID pop-up
    } catch (error) {
      console.error('Error sending transaction:', error);
      console.error('Error sending transaction:', error);
      setErrorMessage('Error sending transaction: ' + error.message);
      setShowTxIdPopup(true); // Show pop-up to display the error
    }
  };

  const returnHome = async () => {
    navigate(`/home/${walletId}`);
  };

  const closePopups = () => {
    setShowRawTxPopup(false);
    setShowTxIdPopup(false);
    setErrorMessage(null); // Clear error messages when pop-ups are closed
  };

  const totalSelectedUtxoAmount = selectedUtxos.reduce(
    (sum, utxo) => sum + BigInt(utxo.amount),
    BigInt(0)
  );

  const availableTokenCategories = [
    ...new Set(
      utxos
        .filter((utxo) => utxo.token_data)
        .map((utxo) => utxo.token_data!.category)
    ),
  ];

  const handleContractFunctionSelect = (
    contractFunction: string,
    inputs: any[]
  ) => {
    console.log(contractFunction);
    console.log(inputs);
    setContractFunction(contractFunction);
    setContractFunctionInputs(inputs);
    dispatch(setSelectedFunction(contractFunction));
    dispatch(setInputs(inputs));
    console.log('Selected Contract Function:', contractFunction);
    console.log('Selected Contract Function Inputs:', inputs);

    const unlockerInputs = inputs.map((input) =>
      input.type === 'sig' ? new SignatureTemplate(input.value) : input.value
    );

    const unlocker = {
      contractFunction,
      unlockerInputs,
    };

    const utxoIndex = utxos.findIndex(
      (utxo) => utxo.abi && utxo.abi === currentContractABI
    );

    if (utxoIndex !== -1) {
      const utxo = utxos[utxoIndex];
      utxos[utxoIndex] = {
        ...utxo,
        unlocker,
      };

      setSelectedUtxos([...selectedUtxos, utxos[utxoIndex]]);
    }

    setShowPopup(false);
  };

  const filteredContractUTXOs = contractUTXOs.filter((utxo) =>
    selectedContractAddresses.includes(utxo.address)
  );

  return (
    <div className="container mx-auto p-4 overflow-x-hidden">
      <h1 className="text-2xl font-bold mb-4">Transaction Builder</h1>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Select Addresses to Spend From
        </h3>
        <h4 className="text-md font-semibold mb-2">Wallet Addresses</h4>
        <div className="overflow-y-auto max-h-96">
          {addresses.map((addressObj, index) => (
            <div
              key={addressObj.address}
              className="flex items-center mb-2 break-words whitespace-normal"
            >
              <input
                type="checkbox"
                checked={selectedAddresses.includes(addressObj.address)}
                onChange={() => toggleAddressSelection(addressObj.address)}
                className="mr-2"
              />
              <span className="break-words overflow-x-auto">
                {`Address: ${addressObj.address}`}
                <br />
                {`Token Address: ${addressObj.tokenAddress}`}
              </span>
            </div>
          ))}
        </div>
        <h4 className="text-md font-semibold mb-2">Contract Addresses</h4>
        <div className="overflow-y-auto max-h-96">
          {contractAddresses.map((contractObj) => (
            <div
              key={contractObj.address}
              className="flex items-center mb-2 break-words whitespace-normal"
            >
              <input
                type="checkbox"
                checked={selectedContractAddresses.includes(
                  contractObj.address
                )}
                onChange={() => {
                  toggleAddressSelection(contractObj.address);
                  toggleContractSelection(contractObj.address, contractObj.abi);
                }}
                className="mr-2"
              />
              <span className="break-words overflow-x-auto">{`Contract Address: ${contractObj.address}, Token Address: ${contractObj.tokenAddress}`}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Regular UTXOs</h3>
        {addresses
          .filter((addressObj) =>
            selectedAddresses.includes(addressObj.address)
          )
          .map((addressObj) => (
            <div
              key={addressObj.address}
              className="p-2 border rounded-lg mb-2"
            >
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
                        (selectedUtxo) =>
                          selectedUtxo.tx_hash === utxo.tx_hash &&
                          selectedUtxo.tx_pos === utxo.tx_pos
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
          .map((addressObj) => (
            <div
              key={addressObj.address}
              className="p-2 border rounded-lg mb-2"
            >
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
                        (selectedUtxo) =>
                          selectedUtxo.tx_hash === utxo.tx_hash &&
                          selectedUtxo.tx_pos === utxo.tx_pos
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
        <h3 className="text-lg font-semibold mb-2">Contract UTXOs</h3>
        {selectedContractAddresses.length > 0 && (
          <div className="p-2 border rounded-lg mb-2">
            {filteredContractUTXOs.length > 0 && (
              <>
                {filteredContractUTXOs
                  .filter((utxo) => !utxo.token_data)
                  .map((utxo) => (
                    <div key={utxo.id} className="flex items-center">
                      <button
                        onClick={() => handleUtxoClick(utxo)}
                        className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                          selectedUtxos.some(
                            (selectedUtxo) =>
                              selectedUtxo.tx_hash === utxo.tx_hash &&
                              selectedUtxo.tx_pos === utxo.tx_pos
                          )
                            ? 'bg-blue-100'
                            : 'bg-white'
                        }`}
                      >
                        <RegularUTXOs
                          address={selectedContractAddresses.join(', ')}
                          utxos={[utxo]}
                          loading={false}
                        />
                      </button>
                    </div>
                  ))}
                {filteredContractUTXOs
                  .filter((utxo) => utxo.token_data)
                  .map((utxo) => (
                    <div key={utxo.id} className="flex items-center">
                      <button
                        onClick={() => handleUtxoClick(utxo)}
                        className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                          selectedUtxos.some(
                            (selectedUtxo) =>
                              selectedUtxo.tx_hash === utxo.tx_hash &&
                              selectedUtxo.tx_pos === utxo.tx_pos
                          )
                            ? 'bg-blue-100'
                            : 'bg-white'
                        }`}
                      >
                        <CashTokenUTXOs
                          address={selectedContractAddresses.join(', ')}
                          utxos={[utxo]}
                          loading={false}
                        />
                      </button>
                    </div>
                  ))}
              </>
            )}
          </div>
        )}
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Selected Transaction Inputs
        </h3>
        {selectedUtxos.map((utxo) => (
          <div
            key={utxo.id}
            className="flex items-center mb-2 break-words whitespace-normal"
          >
            <span className="break-words">{`Address: ${utxo.address}, Amount: ${utxo.amount}, Tx Hash: ${utxo.tx_hash}, Position: ${utxo.tx_pos}, Height: ${utxo.height}`}</span>
            {!utxo.unlocker && utxo.abi && (
              <span className="text-red-500 ml-2">Missing unlocker!</span>
            )}
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
          Total Selected UTXO Amount: {totalSelectedUtxoAmount.toString()}
        </h3>
      </div>

      {/* Spinning Loader */}
      {loading && (
        <div className="flex justify-center items-center mb-6">
          <div className="w-8 h-8 border-4 border-t-4 border-blue-500 rounded-full animate-spin"></div>
        </div>
      )}

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
      {showRawTxPopup && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
          <div className="bg-white p-6 rounded shadow-lg w-96 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-4">Raw Transaction</h3>
            <div className="text-sm font-medium text-gray-700 break-words whitespace-normal mb-4">
              {errorMessage ? (
                <div className="text-red-500">{errorMessage}</div>
              ) : (
                rawTX
              )}
            </div>
            <div className="flex justify-end">
              <button
                onClick={closePopups}
                className="bg-gray-300 text-gray-700 py-2 px-4 rounded"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {showTxIdPopup && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
          <div className="bg-white p-6 rounded shadow-lg w-96 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-4">Transaction ID</h3>
            <div className="text-sm font-medium text-gray-700 break-words whitespace-normal mb-4">
              {errorMessage ? (
                <div className="text-red-500">{errorMessage}</div>
              ) : (
                <a
                  className="text-blue-500 underline"
                  href={`https://chipnet.imaginary.cash/tx/${transactionId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {transactionId}
                </a>
              )}
            </div>
            <div className="flex justify-end">
              <button
                onClick={closePopups}
                className="bg-gray-300 text-gray-700 py-2 px-4 rounded"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {showPopup && currentContractABI.length > 0 && (
        <SelectContractFunctionPopup
          contractABI={currentContractABI}
          onClose={() => setShowPopup(false)}
          onFunctionSelect={handleContractFunctionSelect}
        />
      )}
    </div>
  );
};

export default Transaction;

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
  HashType,
} from 'cashscript';
import { RootState, AppDispatch } from '../redux/store';
import {
  setSelectedFunction,
  // setInputs,
  setInputValues,
} from '../redux/contractSlice';
import { addTxOutput, removeTxOutput } from '../redux/transactionBuilderSlice';
import TransactionManager from '../apis/TransactionManager/TransactionManager';

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
  const [utxos, setUtxos] = useState<UTXO[]>([]);
  const [selectedUtxos, setSelectedUtxos] = useState<UTXO[]>([]);
  const [tempUtxos, setTempUtxos] = useState<UTXO>();
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
  const [contractUTXOs, setContractUTXOs] = useState<UTXO[]>([]);
  const [currentContractABI, setCurrentContractABI] = useState<any[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null); // State for error messages
  const [showWalletAddressesPopup, setShowWalletAddressesPopup] =
    useState(false); // State for wallet addresses popup
  const [showContractAddressesPopup, setShowContractAddressesPopup] =
    useState(false); // State for contract addresses popup
  const [showRegularUTXOsPopup, setShowRegularUTXOsPopup] = useState(false); // State for regular UTXOs popup
  const [showCashTokenUTXOsPopup, setShowCashTokenUTXOsPopup] = useState(false); // State for cash token UTXOs popup
  const [showContractUTXOsPopup, setShowContractUTXOsPopup] = useState(false); // State for contract UTXOs popup
  const navigate = useNavigate();
  const dispatch: AppDispatch = useDispatch();

  const TransactionManage = TransactionManager();

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
      const fetchedUTXOs: UTXO[] = [];
      while (utxosStatement.step()) {
        const row = utxosStatement.getAsObject();
        const addressInfo = fetchedAddresses.find(
          (addr) => addr.address === row.address
        );
        const privateKey = await TransactionManage.fetchPrivateKey(row.address);
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

      // Set default change address to the first available address if it hasn't been set yet
      if (!changeAddress && addressesWithUTXOs.length > 0) {
        setChangeAddress(addressesWithUTXOs[0].address);
      }

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

    if (walletId !== null) {
      fetchAddressesAndUTXOs(walletId);
    }
  }, [walletId, changeAddress]);

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

  const handleUtxoClick = async (utxo: UTXO) => {
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
        console.log('contract utxo: ', utxo);
        setTempUtxos(utxo);
        setCurrentContractABI(utxo.abi);
        setShowPopup(true);
        // Store UTXO temporarily until function is selected
        return;
      } else {
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

  const addOutput = async () => {
    if (recipientAddress && (transferAmount || tokenAmount)) {
      const newOutput = await TransactionManage.addOutput(
        recipientAddress,
        transferAmount,
        tokenAmount,
        selectedTokenCategory,
        selectedUtxos,
        addresses
      );
      setOutputs([...outputs, newOutput]);
      setRecipientAddress('');
      setTransferAmount('');
      setTokenAmount('');
      setSelectedTokenCategory('');

      dispatch(addTxOutput(newOutput));
      console.log(outputs);
    }
  };

  const removeOutput = (index: number) => {
    setOutputs(outputs.filter((_, i) => i !== index));
    dispatch(removeTxOutput(index));
  };

  const buildTransaction = async () => {
    try {
      setLoading(true);
      const transaction = await TransactionManage.buildTransaction(
        outputs,
        contractFunctionInputs,
        changeAddress,
        selectedUtxos
      );
      setBytecodeSize(transaction.bytecodeSize);
      setLoading(false);
      setRawTX(transaction.finalTransaction);
      setFinalOutputs(transaction.finalOutputs);
      setErrorMessage(transaction.errorMsg);
      setShowRawTxPopup(true);
    } catch (err) {
      console.error('Error building transaction:', err);
      setRawTX('');
      setErrorMessage('Error building transaction: ' + err.message);
      setShowRawTxPopup(true); // Show error pop-up
      setLoading(false);
    }
  };

  const sendTransaction = async () => {
    const transactionID = await TransactionManage.sendTransaction(rawTX);
    if (transactionID.txid) setTransactionId(transactionID.txid);
    if (transactionID.errorMessage) setErrorMessage(transactionID.errorMessage);
    setShowRawTxPopup(true);
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
    inputs: { [key: string]: string }
  ) => {
    console.log('Selected Contract Function:', contractFunction);
    console.log('Selected Contract Function Inputs:', inputs);

    // Validate inputs is an object, not an array
    if (typeof inputs !== 'object' || Array.isArray(inputs)) {
      console.error("Error: 'inputs' is not a valid object. Received:", inputs);
      return;
    }

    // Set contract function and inputs
    setContractFunction(contractFunction);
    setContractFunctionInputs(inputs);

    // Dispatch actions to set the selected function and input values
    dispatch(setSelectedFunction(contractFunction));
    dispatch(setInputValues(inputs)); // Ensure inputs are properly dispatched

    // Create an unlocker template from the input values
    const unlockerInputs = Object.entries(inputs).map(([key, value]) =>
      key === 's' ? new SignatureTemplate(value) : value
    );

    const unlocker = {
      contractFunction,
      unlockerInputs,
    };

    // Find the matching UTXO and update it with unlocker
    const utxoIndex = utxos.findIndex(
      (utxo) =>
        utxo.abi &&
        utxo.abi === currentContractABI &&
        utxo.tx_pos === tempUtxos.tx_pos &&
        utxo.tx_hash === tempUtxos.tx_hash
    );

    if (utxoIndex !== -1) {
      const utxo = utxos[utxoIndex];
      utxos[utxoIndex] = {
        ...utxo,
        unlocker,
      };

      setSelectedUtxos([...selectedUtxos, utxos[utxoIndex]]);
    }

    // Close the popup
    setShowPopup(false);
  };

  const filteredContractUTXOs = contractUTXOs.filter((utxo) =>
    selectedContractAddresses.includes(utxo.address)
  );

  const filteredRegularUTXOs = utxos.filter(
    (utxo) => selectedAddresses.includes(utxo.address) && !utxo.token_data
  );

  const filteredCashTokenUTXOs = utxos.filter(
    (utxo) => selectedAddresses.includes(utxo.address) && utxo.token_data
  );

  return (
    <div className="container mx-auto p-4 overflow-x-hidden">
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>
      <h1 className="text-2xl font-bold mb-4">Transaction Builder</h1>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Select Addresses to Spend From
        </h3>
        {/* Wallet Addresses Button */}
        <button
          className="bg-blue-500 text-white mx-1 py-2 px-4 rounded mb-2"
          onClick={() => setShowWalletAddressesPopup(true)}
        >
          Wallet Addresses
        </button>
        {showWalletAddressesPopup && (
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
            <div className="bg-white p-6 rounded shadow-lg w-full max-w-md max-h-[90vh] overflow-hidden">
              <h4 className="text-md font-semibold mb-4">Wallet Addresses</h4>
              <div className="overflow-y-auto max-h-80">
                {addresses.map((addressObj, index) => (
                  <div
                    key={addressObj.address}
                    className="flex items-center mb-2 break-words whitespace-normal"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAddresses.includes(addressObj.address)}
                      onChange={() =>
                        toggleAddressSelection(addressObj.address)
                      }
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
              <button
                className="bg-gray-300 text-gray-700 py-2 px-4 rounded mt-4"
                onClick={() => setShowWalletAddressesPopup(false)}
              >
                Close
              </button>
            </div>
          </div>
        )}
        {/* Contract Addresses Button */}
        <button
          className="bg-blue-500 text-white mx-1 py-2 px-4 rounded mb-2"
          onClick={() => setShowContractAddressesPopup(true)}
        >
          Contract Addresses
        </button>
        {showContractAddressesPopup && (
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
            <div className="bg-white p-6 rounded shadow-lg w-full max-w-md max-h-[90vh] overflow-hidden">
              <h4 className="text-md font-semibold mb-4">Contract Addresses</h4>
              <div className="overflow-y-auto max-h-80">
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
                        toggleContractSelection(
                          contractObj.address,
                          contractObj.abi
                        );
                      }}
                      className="mr-2"
                    />
                    <span className="break-words overflow-x-auto">
                      {`Contract Address: ${contractObj.address}`}
                      <br />
                      {`Token Address: ${contractObj.tokenAddress}`}
                    </span>
                  </div>
                ))}
              </div>
              <button
                className="bg-gray-300 text-gray-700 py-2 px-4 rounded mt-4"
                onClick={() => setShowContractAddressesPopup(false)}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="mb-6">
        {selectedAddresses.length > 0 && (
          <>
            <button
              className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
              onClick={() => setShowRegularUTXOsPopup(true)}
            >
              View Regular UTXOs
            </button>
            <button
              className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
              onClick={() => setShowCashTokenUTXOsPopup(true)}
            >
              View CashToken UTXOs
            </button>
          </>
        )}
        {showRegularUTXOsPopup && (
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
            <div className="bg-white p-6 rounded shadow-lg w-full max-w-md max-h-[90vh] overflow-hidden">
              <h4 className="text-md font-semibold mb-4">Regular UTXOs</h4>
              <div className="overflow-y-auto max-h-80">
                {filteredRegularUTXOs.map((utxo) => (
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
                      address={utxo.address}
                      utxos={[utxo]}
                      loading={false}
                    />
                  </button>
                ))}
              </div>
              <button
                className="bg-gray-300 text-gray-700 py-2 px-4 rounded mt-4"
                onClick={() => setShowRegularUTXOsPopup(false)}
              >
                Close
              </button>
            </div>
          </div>
        )}
        {showCashTokenUTXOsPopup && (
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
            <div className="bg-white p-6 rounded shadow-lg w-full max-w-md max-h-[90vh] overflow-hidden">
              <h4 className="text-md font-semibold mb-4">CashToken UTXOs</h4>
              <div className="overflow-y-auto max-h-80">
                {filteredCashTokenUTXOs.map((utxo) => (
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
                      address={utxo.address}
                      utxos={[utxo]}
                      loading={false}
                    />
                  </button>
                ))}
              </div>
              <button
                className="bg-gray-300 text-gray-700 py-2 px-4 rounded mt-4"
                onClick={() => setShowCashTokenUTXOsPopup(false)}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="mb-6">
        {selectedContractAddresses.length > 0 && (
          <button
            className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
            onClick={() => setShowContractUTXOsPopup(true)}
          >
            View Contract UTXOs
          </button>
        )}
        {showContractUTXOsPopup && (
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
            <div className="bg-white p-6 rounded shadow-lg w-full max-w-md max-h-[90vh] overflow-hidden">
              <h4 className="text-md font-semibold mb-4">Contract UTXOs</h4>
              <div className="overflow-y-auto max-h-80">
                {filteredContractUTXOs.map((utxo) => (
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
                      address={utxo.address}
                      utxos={[utxo]}
                      loading={false}
                    />
                  </button>
                ))}
              </div>
              <button
                className="bg-gray-300 text-gray-700 py-2 px-4 rounded mt-4"
                onClick={() => setShowContractUTXOsPopup(false)}
              >
                Close
              </button>
            </div>
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
            className="flex flex-col items-start mb-2 w-full break-words whitespace-normal"
          >
            <span className="w-full">{`Address: ${utxo.address}`}</span>
            <span className="w-full">{`Amount: ${utxo.amount}`}</span>
            <span className="w-full">{`Tx Hash: ${utxo.tx_hash}`}</span>
            <span className="w-full">{`Position: ${utxo.tx_pos}`}</span>
            <span className="w-full">{`Height: ${utxo.height}`}</span>
            {!utxo.unlocker && utxo.abi && (
              <span className="text-red-500 w-full">Missing unlocker!</span>
            )}
          </div>
        ))}
      </div>
      <div className="mb-6">
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2">Transaction Outputs</h3>
          {outputs.map((output, index) => (
            <div
              key={index}
              className="flex flex-col items-start mb-2 w-full break-words whitespace-normal"
            >
              <span className="w-full">{`Recipient: ${output.recipientAddress}`}</span>
              <span className="w-full">{`Amount: ${output.amount.toString()}`}</span>
              {output.token && (
                <>
                  <span className="w-full">{`Token: ${output.token.amount.toString()}`}</span>
                  <span className="w-full">{`Category: ${output.token.category}`}</span>
                </>
              )}
              <button
                onClick={() => removeOutput(index)}
                className="text-red-500"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
      {finalOutputs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2">Final Outputs</h3>
          {finalOutputs.map((output, index) => (
            <div
              key={index}
              className="flex flex-col items-start mb-2 w-full break-words whitespace-normal"
            >
              <span className="w-full">{`Recipient: ${output.recipientAddress}`}</span>
              <span className="w-full">{`Amount: ${output.amount}`}</span>
              {output.token && (
                <>
                  <span className="w-full">{`Token: ${output.token.amount}`}</span>
                  <span className="w-full">{`Category: ${output.token.category}`}</span>
                </>
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

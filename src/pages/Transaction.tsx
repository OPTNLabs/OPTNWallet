// src/pages/Transaction.tsx

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { TransactionOutput, UTXO } from '../types/types';
import TransactionService from '../services/TransactionService'; // Ensure correct import path
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';
import SelectContractFunctionPopup from '../components/SelectContractFunctionPopup';
import { SignatureTemplate, HashType } from 'cashscript';
import { RootState, AppDispatch } from '../redux/store';
import {
  setSelectedFunction,
  setInputValues,
  resetContract,
} from '../redux/contractSlice'; // Import resetContract
import {
  addTxOutput,
  removeTxOutput,
  clearTransaction,
  setTxOutputs,
} from '../redux/transactionBuilderSlice';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { Network } from '../redux/networkSlice';
import AddressSelection from '../components/transaction/AddressSelection';
import Popup from '../components/transaction/Popup';
import OutputSelection from '../components/transaction/OutputSelection';
import TransactionBuilder from '../components/transaction/TransactionBuilder';
import ErrorBoundary from '../components/ErrorBoundary'; // Import ErrorBoundary
import { resetTransactions } from '../redux/transactionSlice';

const Transaction: React.FC = () => {
  // Local State Variables (Outputs are now managed by Redux)
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
  const [tempUtxos, setTempUtxos] = useState<UTXO | undefined>();
  const [recipientAddress, setRecipientAddress] = useState<string>('');
  const [transferAmount, setTransferAmount] = useState<number>(0);
  const [tokenAmount, setTokenAmount] = useState<number>(0);
  const [selectedTokenCategory, setSelectedTokenCategory] =
    useState<string>('');
  const [changeAddress, setChangeAddress] = useState<string>('');
  const [bytecodeSize, setBytecodeSize] = useState<number | null>(null);
  const [rawTX, setRawTX] = useState<string>('');
  const [transactionId, setTransactionId] = useState<string>('');
  // Removed local `finalOutputs` as we will use Redux's `txOutputs`
  const [showPopup, setShowPopup] = useState(false);
  const [showRawTxPopup, setShowRawTxPopup] = useState(false);
  const [showTxIdPopup, setShowTxIdPopup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedContractAddresses, setSelectedContractAddresses] = useState<
    string[]
  >([]);
  const [selectedContractABIs, setSelectedContractABIs] = useState<any[]>([]);
  const [contractFunctionInputs, setContractFunctionInputs] = useState<{
    [key: string]: string;
  } | null>(null);
  const [contractUTXOs, setContractUTXOs] = useState<UTXO[]>([]);
  const [currentContractABI, setCurrentContractABI] = useState<any[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showRegularUTXOsPopup, setShowRegularUTXOsPopup] = useState(false);
  const [showCashTokenUTXOsPopup, setShowCashTokenUTXOsPopup] = useState(false);
  const [showContractUTXOsPopup, setShowContractUTXOsPopup] = useState(false);
  const navigate = useNavigate();
  const dispatch: AppDispatch = useDispatch();

  // Correctly initialize TransactionService
  const transactionService = TransactionService; // Ensure TransactionService is a function that returns the service object

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  // Access Redux state using useSelector
  const selectedFunction = useSelector(
    (state: RootState) => state.contract.selectedFunction
  );
  const txOutputs = useSelector(
    (state: RootState) => state.transactionBuilder.txOutputs
  );

  // Add this useEffect to log txOutputs whenever they change
  useEffect(() => {
    console.log('txOutputs updated:', txOutputs);
  }, [txOutputs]);

  /**
   * Fetch wallet ID on component mount.
   * Replace the hardcoded `1` with actual logic to retrieve the active wallet ID.
   */
  useEffect(() => {
    const fetchWalletId = async () => {
      // TODO: Implement actual logic to get active wallet ID
      const activeWalletId = 1;
      setWalletId(activeWalletId);
      dispatch(clearTransaction());
    };

    fetchWalletId();
  }, []);

  /**
   * Fetch addresses and UTXOs whenever `walletId` changes.
   * Removed `changeAddress` and `selectedAddresses` from dependencies to prevent infinite loop.
   */
  useEffect(() => {
    const fetchData = async (walletId: number) => {
      try {
        const { addresses, utxos, contractAddresses } =
          await transactionService.fetchAddressesAndUTXOs(walletId);
        setAddresses(addresses);
        setContractAddresses(contractAddresses);
        setUtxos(utxos);
        setContractUTXOs(
          contractAddresses.flatMap((contract) =>
            utxos.filter((utxo) => utxo.address === contract.address)
          )
        );

        // Auto-select the first address if only one exists
        if (
          addresses.length === 1 &&
          !selectedAddresses.includes(addresses[0].address)
        ) {
          setSelectedAddresses([addresses[0].address]);
        }

        // Set default change address
        if (!changeAddress && addresses.length > 0) {
          setChangeAddress(addresses[0].address);
        }
      } catch (error) {
        console.error('Error fetching addresses and UTXOs:', error);
        setErrorMessage(
          'Error fetching addresses and UTXOs: ' + (error as Error).message
        );
      }
    };

    if (walletId !== null) {
      fetchData(walletId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId]);

  /**
   * Handle changes to `selectedAddresses` to auto-select change address if needed.
   * This is a separate useEffect to manage state updates without causing the main fetchData useEffect to re-run.
   */
  useEffect(() => {
    if (selectedAddresses.length === 1) {
      setChangeAddress(selectedAddresses[0]);
    }
  }, [selectedAddresses]);

  /**
   * Handle the selection and deselection of UTXOs.
   *
   * @param utxo - The UTXO being clicked.
   */
  const handleUtxoClick = (utxo: UTXO) => {
    console.log('Selected UTXOs before function inputs:', selectedUtxos);
    const isSelected = selectedUtxos.some(
      (selectedUtxo) => selectedUtxo.id === utxo.id
    );

    if (isSelected) {
      setSelectedUtxos(
        selectedUtxos.filter((selectedUtxo) => selectedUtxo.id !== utxo.id)
      );

      // If the UTXO being deselected was a contract UTXO, reset the contract state
      if (utxo.abi) {
        dispatch(resetContract());
      }
    } else {
      if (utxo.abi) {
        console.log('Contract UTXO:', utxo);
        setTempUtxos(utxo);
        setCurrentContractABI(utxo.abi);
        setShowPopup(true);
        return;
      } else {
        const signatureTemplate = new SignatureTemplate(
          utxo.privateKey!,
          HashType.SIGHASH_ALL
        );
        const unlocker = signatureTemplate.unlockP2PKH();

        const updatedUtxo: UTXO = {
          ...utxo,
          unlocker,
        };

        setSelectedUtxos([...selectedUtxos, updatedUtxo]);

        // Reset contract state since a regular UTXO is being selected
        dispatch(resetContract());
      }
    }

    console.log('Selected UTXOs after function inputs:', selectedUtxos);
  };

  /**
   * Adds a new transaction output.
   */
  const handleAddOutput = () => {
    if (recipientAddress && (transferAmount || tokenAmount)) {
      try {
        const newOutput = transactionService.addOutput(
          recipientAddress,
          transferAmount,
          tokenAmount,
          selectedTokenCategory,
          selectedUtxos,
          addresses
        );

        if (newOutput) {
          // Dispatch to Redux is already handled in TransactionManager.addOutput
          // Optionally, reset form fields
          setRecipientAddress('');
          setTransferAmount(0);
          setTokenAmount(0);
          setSelectedTokenCategory('');

          console.log('Updated Outputs:', txOutputs);
        }
      } catch (error: any) {
        console.error('Error adding output:', error);
        setErrorMessage('Error adding output: ' + error.message);
      }
    }
  };

  /**
   * Removes a transaction output at a specified index.
   *
   * @param index - The index of the output to remove.
   */
  const handleRemoveOutput = (index: number) => {
    dispatch(removeTxOutput(index));
  };

  /**
   * Builds the transaction.
   */
  const handleBuildTransaction = async () => {
    try {
      setLoading(true);
      console.log('Building transaction with:');
      console.log('Outputs:', txOutputs);
      console.log('Contract Function Inputs:', contractFunctionInputs);
      console.log('Selected Function:', selectedFunction);
      console.log('Selected UTXOs:', selectedUtxos);

      // Optionally, notify the user that no outputs are added and a change output will be added automatically
      if (txOutputs.length === 0) {
        console.log(
          'No outputs added. A change output will be added automatically.'
        );
      }

      // If a contract function is selected, ensure inputs are provided
      if (
        selectedFunction &&
        (!contractFunctionInputs ||
          Object.keys(contractFunctionInputs).length === 0)
      ) {
        setErrorMessage(
          'Please provide all required contract function inputs.'
        );
        setLoading(false);
        return;
      }

      const transaction = await transactionService.buildTransaction(
        txOutputs,
        contractFunctionInputs,
        changeAddress,
        selectedUtxos
      );

      if (!transaction) {
        setErrorMessage('Failed to build transaction.');
        setLoading(false);
        return;
      }

      console.log('Transaction Build Result:', transaction);

      setBytecodeSize(transaction.bytecodeSize);
      setRawTX(transaction.finalTransaction);
      // Removed `setFinalOutputs` as outputs are managed by Redux

      // **[Modification]**: Update the Redux outputs state with finalOutputs
      if (transaction.finalOutputs) {
        // Clear existing outputs
        dispatch(clearTransaction());

        // Set the entire txOutputs array to finalOutputs
        dispatch(setTxOutputs(transaction.finalOutputs));

        console.log('Final Outputs after Build:', transaction.finalOutputs);
      }

      setErrorMessage(transaction.errorMsg);
      setShowRawTxPopup(true);
      setLoading(false);
    } catch (err: any) {
      console.error('Error building transaction:', err);
      setRawTX('');
      setErrorMessage('Error building transaction: ' + err.message);
      setShowRawTxPopup(true);
      setLoading(false);
    }
  };

  /**
   * Sends the built transaction.
   */
  const handleSendTransaction = async () => {
    try {
      setLoading(true);
      const transactionID = await transactionService.sendTransaction(rawTX);

      if (transactionID.txid) {
        setTransactionId(transactionID.txid);
      }

      if (transactionID.errorMessage) {
        setErrorMessage(transactionID.errorMessage);
      } else {
        // Only reset the contract state if the transaction was successful
        dispatch(resetTransactions());
        dispatch(resetContract());
      }

      setShowTxIdPopup(true);
      setLoading(false);
    } catch (error: any) {
      console.error('Error sending transaction:', error);
      setErrorMessage('Error sending transaction: ' + error.message);
      setShowTxIdPopup(true);
      setLoading(false);
    }
  };

  /**
   * Navigates back to the home page.
   */
  const returnHome = async () => {
    navigate(`/home/${walletId}`);
  };

  /**
   * Closes all popups and clears error messages.
   */
  const closePopups = () => {
    setShowRawTxPopup(false);
    setShowTxIdPopup(false);
    setShowContractUTXOsPopup(false);
    setShowRegularUTXOsPopup(false);
    setShowCashTokenUTXOsPopup(false);
    setShowPopup(false);
    setErrorMessage(null);
  };

  /**
   * Handles the selection of a contract function from the popup.
   *
   * @param contractFunction - The selected contract function name.
   * @param inputs - The inputs for the contract function.
   */
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
    setContractFunctionInputs(inputs);

    // Dispatch actions to set the selected function and input values
    dispatch(setSelectedFunction(contractFunction));
    dispatch(setInputValues(inputs));

    // Create an unlocker template from the input values
    const unlockerInputs = Object.entries(inputs).map(([key, value]) =>
      key === 's' ? new SignatureTemplate(value) : value
    );

    const unlocker = {
      contractFunction,
      unlockerInputs,
    };

    // Find the matching UTXO and update it with unlocker
    if (tempUtxos) {
      const updatedUtxo: UTXO = {
        ...tempUtxos,
        unlocker,
      };
      setSelectedUtxos([...selectedUtxos, updatedUtxo]);
    }

    // Close the popup
    setShowPopup(false);
  };

  /**
   * Filters UTXOs based on selected addresses and contract addresses.
   */
  const filteredContractUTXOs = contractUTXOs.filter((utxo) =>
    selectedContractAddresses.includes(utxo.address)
  );

  const filteredRegularUTXOs = utxos.filter(
    (utxo) => selectedAddresses.includes(utxo.address) && !utxo.token_data
  );

  const filteredCashTokenUTXOs = utxos.filter(
    (utxo) => selectedAddresses.includes(utxo.address) && utxo.token_data
  );

  // Calculate the total amount from selected UTXOs
  const totalSelectedUtxoAmount = selectedUtxos.reduce(
    (sum, utxo) => sum + BigInt(utxo.amount),
    BigInt(0)
  );

  return (
    <ErrorBoundary>
      <div className="container mx-auto p-4 overflow-x-hidden">
        {/* Welcome Image */}
        <div className="flex justify-center mt-4">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="Welcome"
            className="max-w-full h-auto"
          />
        </div>

        {/* Page Title */}
        <h1 className="text-2xl font-bold mb-4">Transaction Builder</h1>

        {/* Address Selection Component */}
        <AddressSelection
          addresses={addresses}
          selectedAddresses={selectedAddresses}
          contractAddresses={contractAddresses}
          selectedContractAddresses={selectedContractAddresses}
          setSelectedContractAddresses={setSelectedContractAddresses}
          selectedContractABIs={selectedContractABIs}
          setSelectedContractABIs={setSelectedContractABIs}
          setSelectedAddresses={setSelectedAddresses}
        />

        {/* Regular UTXOs Popup */}
        <div>
          {selectedAddresses.length > 0 && (
            <button
              className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
              onClick={() => setShowRegularUTXOsPopup(true)}
            >
              View Regular UTXOs
            </button>
          )}
          {showRegularUTXOsPopup && (
            <Popup closePopups={closePopups}>
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
                    <RegularUTXOs utxos={[utxo]} loading={false} />
                  </button>
                ))}
              </div>
            </Popup>
          )}
        </div>

        {/* CashToken UTXOs Popup */}
        <div>
          {selectedAddresses.length > 0 && (
            <button
              className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
              onClick={() => setShowCashTokenUTXOsPopup(true)}
            >
              View CashToken UTXOs
            </button>
          )}
          {showCashTokenUTXOsPopup && (
            <Popup closePopups={closePopups}>
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
                    <CashTokenUTXOs utxos={[utxo]} loading={false} />
                  </button>
                ))}
              </div>
            </Popup>
          )}
        </div>

        {/* Contract UTXOs Popup */}
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
            <Popup closePopups={closePopups}>
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
                    <RegularUTXOs utxos={[utxo]} loading={false} />
                  </button>
                ))}
              </div>
            </Popup>
          )}
        </div>

        {/* Selected Transaction Inputs */}
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

        {/* Transaction Outputs */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2">Transaction Outputs</h3>
          {txOutputs.map((output, index) => (
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
                onClick={() => handleRemoveOutput(index)}
                className="text-red-500"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        {/* Output Selection Component */}
        <OutputSelection
          recipientAddress={recipientAddress}
          setRecipientAddress={setRecipientAddress}
          transferAmount={transferAmount}
          setTransferAmount={setTransferAmount}
          tokenAmount={tokenAmount}
          setTokenAmount={setTokenAmount}
          utxos={utxos}
          selectedTokenCategory={selectedTokenCategory}
          setSelectedTokenCategory={setSelectedTokenCategory}
          addOutput={handleAddOutput}
          changeAddress={changeAddress}
          setChangeAddress={setChangeAddress}
        />

        {/* Transaction Builder Component */}
        <TransactionBuilder
          totalSelectedUtxoAmount={totalSelectedUtxoAmount}
          loading={loading}
          buildTransaction={handleBuildTransaction}
          sendTransaction={handleSendTransaction}
          returnHome={returnHome}
        />

        {/* Bytecode Size Display */}
        {bytecodeSize !== null && (
          <div className="mb-6 break-words whitespace-normal">
            <h3 className="text-lg font-semibold mb-2">
              Bytecode Size: {bytecodeSize} bytes
            </h3>
          </div>
        )}

        {/* Raw Transaction Popup */}
        {showRawTxPopup && (
          <Popup closePopups={closePopups}>
            <h3 className="text-lg font-semibold mb-4">Raw Transaction</h3>
            <div className="text-sm font-medium text-gray-700 break-words whitespace-normal mb-4">
              {errorMessage ? (
                <div className="text-red-500">{errorMessage}</div>
              ) : (
                rawTX
              )}
            </div>
          </Popup>
        )}

        {/* Transaction ID Popup */}
        {showTxIdPopup && (
          <Popup closePopups={closePopups}>
            <h3 className="text-lg font-semibold mb-4">Transaction ID</h3>
            <div className="text-sm font-medium text-gray-700 break-words whitespace-normal mb-4">
              {errorMessage ? (
                <div className="text-red-500">{errorMessage}</div>
              ) : (
                <a
                  className="text-blue-500 underline"
                  href={
                    currentNetwork === Network.CHIPNET
                      ? `https://chipnet.imaginary.cash/tx/${transactionId}`
                      : `https://blockchair.com/bitcoin-cash/transaction/${transactionId}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {transactionId}
                </a>
              )}
            </div>
          </Popup>
        )}

        {/* Contract Function Selection Popup */}
        {showPopup && currentContractABI.length > 0 && (
          <SelectContractFunctionPopup
            contractABI={currentContractABI}
            onClose={() => setShowPopup(false)}
            onFunctionSelect={handleContractFunctionSelect}
          />
        )}
      </div>
    </ErrorBoundary>
  );
};

export default Transaction;

// src/pages/Transaction.tsx

import React, { useEffect, useState } from 'react';
// import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { UTXO } from '../types/types';
import AddressSelection from '../components/transaction/AddressSelection';
import OutputSelection from '../components/transaction/OutputSelection';
import SelectedUTXOsDisplay from '../components/transaction/SelectedUTXOsDisplay';
// import TransactionOutputsDisplay from '../components/transaction/TransactionOutputsDisplay';
import TransactionActions from '../components/transaction/TransactionActions';
import UTXOSelection from '../components/transaction/UTXOSelection';
import SelectContractFunctionPopup from '../components/SelectContractFunctionPopup';
import ErrorAndStatusPopups from '../components/transaction/ErrorAndStatusPopups';
import ErrorBoundary from '../components/ErrorBoundary'; // Import ErrorBoundary
import { SignatureTemplate, HashType } from 'cashscript';
import { RootState, AppDispatch } from '../redux/store';
import {
  setSelectedFunction,
  setInputValues,
  resetContract,
} from '../redux/contractSlice'; // Import resetContract
import {
  // addTxOutput,
  removeTxOutput,
  clearTransaction,
  // setTxOutputs,
} from '../redux/transactionBuilderSlice';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
// import { Network } from '../redux/networkSlice';
import useFetchWalletData from '../hooks/useFetchWalletData';
import useHandleTransaction from '../hooks/useHandleTransaction';
import TransactionService from '../services/TransactionService';
import {
  selectWalletId,
  // setWalletId,
  // selectNetworkType,
} from '../redux/walletSlice';
import SweepPaperWallet from '../components/SweepPaperWallet';

const Transaction: React.FC = () => {
  // Removed local walletId state
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
  const [selectedContractAddresses, setSelectedContractAddresses] = useState<
    string[]
  >([]);
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
  const [paperWalletUTXOs, setPaperWalletUTXOs] = useState<UTXO[]>([]);
  // const [selectedPaperWalletUTXOs, setSelectedPaperWalletUTXOs] = useState<
  //   UTXO[]
  // >([]);
  const [showPaperWalletUTXOsPopup, setShowPaperWalletUTXOsPopup] =
    useState<boolean>(false);
  const [showOutputs, setShowOutputs] = useState<boolean>(false);

  // const navigate = useNavigate();
  const dispatch: AppDispatch = useDispatch();

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  // Access Redux state using useSelector
  // const selectedFunction = useSelector(
  //   (state: RootState) => state.contract.selectedFunction
  // );
  const txOutputs = useSelector(
    (state: RootState) => state.transactionBuilder.txOutputs
  );

  const walletId = useSelector(selectWalletId);
  // const networkType = useSelector(selectNetworkType);

  // console.log('Selected Wallet ID from Redux:', walletId);
  // console.log('Current Network Type:', networkType);

  // Reset transactions and contract states when the component mounts
  useEffect(() => {
    dispatch(clearTransaction());
    dispatch(resetContract());
    // console.log('Transaction and Contract states have been reset.');
  }, [dispatch]);

  // Log txOutputs whenever they change
  useFetchWalletData(
    walletId,
    // selectedAddresses,
    setAddresses,
    setContractAddresses,
    setUtxos,
    setContractUTXOs,
    // setSelectedAddresses,
    setChangeAddress,
    setErrorMessage
  );

  // Use useEffect to set the walletId if not set
  // useEffect(() => {
  //   if (walletId === 0) {
  //     // assuming 0 is invalid, initial value
  //     const fetchWalletId = async () => {
  //       // TODO: Implement actual logic to get active wallet ID
  //       const activeWalletId = 1;
  //       dispatch(setWalletId(activeWalletId));
  //       // console.log('Wallet ID set to:', activeWalletId);
  //       // dispatch(clearTransaction());
  //     };

  //     fetchWalletId();
  //   }
  // }, [dispatch, walletId]);

  /**
   * Handle the selection and deselection of UTXOs.
   *
   * @param utxo - The UTXO being clicked.
   */
  const handleUtxoClick = (utxo: UTXO) => {
    // console.log('Selected UTXO:', utxo);
    if (rawTX !== '' && txOutputs.length !== 0) {
      handleRemoveOutput(-1);
    }
    setRawTX('');
    const isSelected = selectedUtxos.some((selectedUtxo) =>
      selectedUtxo.id
        ? selectedUtxo.id === utxo.id
        : selectedUtxo.tx_hash + selectedUtxo.tx_pos ===
          utxo.tx_hash + utxo.tx_pos
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
        // console.log('Contract UTXO:', utxo);
        setShowPopup(true);
        setTempUtxos(utxo);
        setCurrentContractABI(utxo.abi);
        setSelectedContractAddresses((prev) => [...prev, utxo.address]);
        return;
      } else if (utxo.isPaperWallet) {
        // console.log('Selected a Paper Wallet UTXO:', paperWalletUTXOs);

        // const isDuplicate = paperWalletUTXOs.some(
        //   (existingUtxo) =>
        //     existingUtxo.tx_hash === utxo.tx_hash &&
        //     existingUtxo.tx_pos === utxo.tx_pos
        // );
        // if (!isDuplicate) {
        // setSelectedPaperWalletUTXOs([...selectedPaperWalletUTXOs, utxo]);
        setSelectedUtxos([...selectedUtxos, utxo]);
        setSelectedAddresses((prev) => [...prev, utxo.address]);
        setShowPaperWalletUTXOsPopup(true);
        dispatch(resetContract());
        // console.log('Selected a Paper Wallet UTXO:', utxo);
        // }
      } else {
        // const signatureTemplate = new SignatureTemplate(
        //   utxo.privateKey!,
        //   HashType.SIGHASH_ALL
        // );
        // const unlocker = signatureTemplate.unlockP2PKH();

        // const updatedUtxo: UTXO = {
        //   ...utxo,
        //   unlocker,
        // };

        setSelectedUtxos([...selectedUtxos, utxo]);
        setSelectedAddresses((prev) => [...prev, utxo.address]);

        // Reset contract state since a regular UTXO is being selected
        dispatch(resetContract());

        // **Add Logging Here**
        // console.log('Selected a non-contract UTXO:', utxo);
      }
    }

    // console.log('Selected UTXOs after function inputs:', selectedUtxos);
  };

  /**
   * Adds a new transaction output.
   */
  const handleAddOutput = () => {
    if (recipientAddress && (transferAmount || tokenAmount)) {
      if (rawTX !== '' && txOutputs.length !== 0) {
        handleRemoveOutput(-1);
      }
      try {
        const newOutput = TransactionService.addOutput(
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

          // console.log('Updated Outputs:', txOutputs);
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
    setRawTX('');
    dispatch(removeTxOutput(index));
  };

  /**
   * Use custom hook to handle building and sending transactions.
   */
  const { handleBuildTransaction: buildTransaction, handleSendTransaction } =
    useHandleTransaction(
      txOutputs,
      contractFunctionInputs,
      changeAddress,
      selectedUtxos,
      setBytecodeSize,
      setRawTX,
      setErrorMessage,
      setShowRawTxPopup,
      setShowTxIdPopup, // Pass the setter to the hook
      setLoading
    );

  /**
   * Sends the built transaction.
   */
  const sendTransaction = () => {
    handleSendTransaction(rawTX, setTransactionId);
  };

  /**
   * Navigates back to the home page.
   */
  // const returnHome = async () => {
  //   navigate(`/home/${walletId}`);
  // };

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
    setShowPaperWalletUTXOsPopup(false);
    setShowOutputs(false);
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
    // console.log('Selected Contract Function:', contractFunction);
    // console.log('Selected Contract Function Inputs:', inputs);

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
      key === 's' ? new SignatureTemplate(value, HashType.SIGHASH_ALL) : value
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
        contractFunction, // Ensure this is set
        contractFunctionInputs: inputs, // Ensure this is set
      };
      setSelectedUtxos([...selectedUtxos, updatedUtxo]);

      // **Add Logging Here**
      // console.log(
      //   'Updated UTXO with contractFunction and contractFunctionInputs:',
      //   updatedUtxo
      // );
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
    (sum, utxo) => sum + BigInt(utxo.amount ? utxo.amount : utxo.value),
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

        {/* Flex Container for AddressSelection and SweepPaperWallet */}
        <div className="flex flex-wrap gap-2 mb-6 justify-center">
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

          {/* Sweep Paper Wallet Component */}
          <SweepPaperWallet setPaperWalletUTXOs={setPaperWalletUTXOs} />
        </div>

        {/* UTXO Selection Component */}
        <UTXOSelection
          selectedAddresses={selectedAddresses}
          selectedContractAddresses={selectedContractAddresses}
          // contractAddresses={contractAddresses}
          filteredRegularUTXOs={filteredRegularUTXOs}
          filteredCashTokenUTXOs={filteredCashTokenUTXOs}
          filteredContractUTXOs={filteredContractUTXOs}
          selectedUtxos={selectedUtxos}
          handleUtxoClick={handleUtxoClick}
          showRegularUTXOsPopup={showRegularUTXOsPopup}
          setShowRegularUTXOsPopup={setShowRegularUTXOsPopup}
          showCashTokenUTXOsPopup={showCashTokenUTXOsPopup}
          setShowCashTokenUTXOsPopup={setShowCashTokenUTXOsPopup}
          showContractUTXOsPopup={showContractUTXOsPopup}
          setShowContractUTXOsPopup={setShowContractUTXOsPopup}
          paperWalletUTXOs={paperWalletUTXOs}
          showPaperWalletUTXOsPopup={showPaperWalletUTXOsPopup}
          setShowPaperWalletUTXOsPopup={setShowPaperWalletUTXOsPopup}
          // selectedPaperWalletUTXOs={selectedPaperWalletUTXOs}
          closePopups={closePopups}
        />

        {/* Selected Transaction Inputs */}
        <SelectedUTXOsDisplay
          selectedUtxos={selectedUtxos}
          totalSelectedUtxoAmount={totalSelectedUtxoAmount}
          handleUtxoClick={handleUtxoClick}
          currentNetwork={currentNetwork}
        />

        {/* Transaction Outputs Display */}
        {/* <TransactionOutputsDisplay
          txOutputs={txOutputs}
          handleRemoveOutput={handleRemoveOutput}
        /> */}

        {/* Output Selection Component */}
        <OutputSelection
          txOutputs={txOutputs}
          handleRemoveOutput={handleRemoveOutput}
          currentNetwork={currentNetwork}
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
          showOutputs={showOutputs}
          setShowOutputs={setShowOutputs}
          closePopups={closePopups}
        />

        {/* Bytecode Size Display */}
        {bytecodeSize !== 0 && rawTX !== '' && (
          <div className="mb-6 break-words whitespace-normal">
            <h3 className="text-lg font-semibold mb-2">
              Transaction Fee: {bytecodeSize} sats
            </h3>
          </div>
        )}

        {/* Transaction Actions Component */}
        <TransactionActions
          // totalSelectedUtxoAmount={totalSelectedUtxoAmount}
          loading={loading}
          buildTransaction={buildTransaction}
          sendTransaction={sendTransaction}
          rawTX={rawTX}
          // returnHome={returnHome}
        />

        {/* Error and Status Popups */}
        <ErrorAndStatusPopups
          showRawTxPopup={showRawTxPopup}
          // setShowRawTxPopup={setShowRawTxPopup}
          showTxIdPopup={showTxIdPopup}
          // setShowTxIdPopup={setShowTxIdPopup}
          rawTX={rawTX}
          transactionId={transactionId}
          errorMessage={errorMessage}
          currentNetwork={currentNetwork}
          closePopups={closePopups}
        />

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

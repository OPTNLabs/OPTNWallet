// src/pages/Transaction.tsx

import React, { Dispatch, SetStateAction, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ContractAddressRecord, UTXO } from '../types/types';
import AddressSelection from '../components/transaction/AddressSelection';
import OutputSelection from '../components/transaction/OutputSelection';
import SelectedUTXOsDisplay from '../components/transaction/SelectedUTXOsDisplay';
import TransactionActions from '../components/transaction/TransactionActions';
import UTXOSelection from '../components/transaction/UTXOSelection';
import SelectContractFunctionPopup from '../components/SelectContractFunctionPopup';
import ErrorAndStatusPopups from '../components/transaction/ErrorAndStatusPopups';
import ErrorBoundary from '../components/ErrorBoundary';
import { RootState, AppDispatch } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import useFetchWalletData from '../hooks/useFetchWalletData';
import useHandleTransaction from '../hooks/useHandleTransaction';
import { selectWalletId } from '../redux/walletSlice';
import { useTransactionHandlers } from './transaction/useTransactionHandlers';
import { useTransactionInit } from './transaction/useTransactionInit';
import { useTransactionDerived } from './transaction/useTransactionDerived';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';

const noopSetUtxos: Dispatch<SetStateAction<UTXO[]>> = () => undefined;

const Transaction: React.FC = () => {
  // Removed local walletId state
  const [addresses, setAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [contractAddresses, setContractAddresses] = useState<
    ContractAddressRecord[]
  >([]);
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>([]);
  // const [utxos, setUtxos] = useState<UTXO[]>([]);
  const [selectedContractAddresses, setSelectedContractAddresses] = useState<
    string[]
  >([]);
  const [selectedUtxos, setSelectedUtxos] = useState<UTXO[]>([]);
  const [tempUtxos, setTempUtxos] = useState<UTXO | undefined>();
  const [recipientAddress, setRecipientAddress] = useState<string>('');
  const [transferAmount, setTransferAmount] = useState<number>(0);
  const [tokenAmount, setTokenAmount] = useState<number | bigint>(0);
  const [selectedTokenCategory, setSelectedTokenCategory] =
    useState<string>('none');
  const [changeAddress, setChangeAddress] = useState<string>('');
  const [bytecodeSize, setBytecodeSize] = useState<number>(0);
  const [rawTX, setRawTX] = useState<string>('');
  const [transactionId, setTransactionId] = useState<string>('');
  // Removed local `finalOutputs` as we will use Redux's `txOutputs`
  const [showPopup, setShowPopup] = useState(false);
  const [showRawTxPopup, setShowRawTxPopup] = useState(false);
  const [showTxIdPopup, setShowTxIdPopup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedContractABIs, setSelectedContractABIs] = useState<unknown[]>(
    []
  );
  const [contractFunctionInputs, setContractFunctionInputs] = useState<{
    [key: string]: string;
  } | null>(null);
  const [contractUTXOs, setContractUTXOs] = useState<UTXO[]>([]);
  const [currentContractABI, setCurrentContractABI] = useState<unknown[]>([]);
  const [currentContractSource, setCurrentContractSource] =
    useState<string>('');
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

  const [nftCapability, setNftCapability] = useState<
    undefined | 'none' | 'mutable' | 'minting'
  >(undefined);
  const [nftCommitment, setNftCommitment] = useState<undefined | string>(
    undefined
  );

  // const spentOutpoints = useMemo(
  //   () =>
  //     selectedUtxos.map(u => ({ tx_hash: u.tx_hash, tx_pos: u.tx_pos })),
  //   [selectedUtxos]
  // );

  // const touchedAddresses = useMemo(
  //   () => Array.from(new Set(selectedUtxos.map(u => u.address))).filter(Boolean),
  //   [selectedUtxos]
  // );

  // const navigate = useNavigate();
  const dispatch: AppDispatch = useDispatch();

  const prices = useSelector((s: RootState) => s.priceFeed);

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  const utxosByAddress = useSelector((s: RootState) => s.utxos.utxos);

  const txOutputs = useSelector(
    (state: RootState) => state.transactionBuilder.txOutputs
  );

  const walletId = useSelector(selectWalletId);
  useTransactionInit(dispatch);

  // Log txOutputs whenever they change
  useFetchWalletData(
    walletId,
    // selectedAddresses,
    setAddresses,
    setContractAddresses,
    // setUtxos,
    noopSetUtxos,
    setContractUTXOs,
    // setSelectedAddresses,
    setChangeAddress,
    setErrorMessage
  );

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

  const {
    handleRemoveOutput,
    handleUtxoClick,
    handleAddOutput,
    sendTransaction,
    closePopups,
    handleContractFunctionSelect,
  } = useTransactionHandlers({
    dispatch,
    rawTX,
    txOutputsLength: txOutputs.length,
    selectedUtxos,
    tempUtxos,
    recipientAddress,
    transferAmount,
    tokenAmount,
    selectedTokenCategory,
    addresses,
    nftCapability,
    nftCommitment,
    handleSendTransaction,
    txSetters: {
      setRawTX,
      setBytecodeSize,
      setErrorMessage,
    },
    selectionSetters: {
      setSelectedUtxos,
      setSelectedAddresses,
      setSelectedContractAddresses,
    },
    contractSetters: {
      setShowPopup,
      setTempUtxos,
      setCurrentContractABI,
      setCurrentContractSource,
    },
    outputSetters: {
      setRecipientAddress,
      setTransferAmount,
      setTokenAmount,
      setSelectedTokenCategory,
      setNftCapability,
      setNftCommitment,
    },
    popupSetters: {
      setShowPaperWalletUTXOsPopup,
      setShowRawTxPopup,
      setShowTxIdPopup,
      setShowContractUTXOsPopup,
      setShowRegularUTXOsPopup,
      setShowCashTokenUTXOsPopup,
    },
  });

  const handleSend = () => sendTransaction(setTransactionId);

  const onContractFunctionSelect = async (
    contractFunction: string,
    inputs: { [key: string]: string },
    abiInputs: { name: string; type: string }[]
  ) => {
    setContractFunctionInputs(inputs);
    await handleContractFunctionSelect(contractFunction, inputs, abiInputs);
  };

  const {
    utxos,
    filteredRegularUTXOs,
    filteredCashTokenUTXOs,
    filteredContractUTXOs,
    totalSelectedUtxoAmount,
    showFee,
    feeBch,
    feeUsdLabel,
  } = useTransactionDerived({
    utxosByAddress,
    contractUTXOs,
    selectedAddresses,
    selectedContractAddresses,
    selectedUtxos,
    bytecodeSize,
    rawTX,
    prices,
  });

  return (
    <ErrorBoundary>
      <div className="container mx-auto max-w-xl p-4 pb-16 overflow-x-hidden wallet-page">
        <PageHeader
          title="Transaction Builder"
          subtitle="Advanced transaction construction"
          compact
        />

        {/* Flex Container for AddressSelection */}
        <SectionCard className="mb-4">
          <div className="flex flex-wrap gap-2 justify-center">
          {/* Address Selection Component */}
          <AddressSelection
            addresses={addresses}
            selectedUtxos={selectedUtxos}
            selectedAddresses={selectedAddresses}
            contractAddresses={contractAddresses}
            selectedContractAddresses={selectedContractAddresses}
            setSelectedContractAddresses={setSelectedContractAddresses}
            selectedContractABIs={selectedContractABIs}
            setSelectedContractABIs={setSelectedContractABIs}
            setSelectedAddresses={setSelectedAddresses}
            setPaperWalletUTXOs={setPaperWalletUTXOs}
          />
          </div>
        </SectionCard>

        {/* UTXO Selection Component */}
        <UTXOSelection
          // selectedAddresses={selectedAddresses}
          // selectedContractAddresses={selectedContractAddresses}
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
          selectedAddresses={selectedAddresses}
          selectedContractAddresses={selectedContractAddresses}
          totalSelectedUtxoAmount={totalSelectedUtxoAmount}
          handleUtxoClick={handleUtxoClick}
          currentNetwork={currentNetwork}
        />

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
          utxos={utxos.concat(contractUTXOs)}
          selectedUtxos={selectedUtxos}
          selectedTokenCategory={selectedTokenCategory}
          setSelectedTokenCategory={setSelectedTokenCategory}
          addOutput={handleAddOutput}
          changeAddress={changeAddress}
          setChangeAddress={setChangeAddress}
          nftCapability={nftCapability}
          setNftCapability={setNftCapability}
          nftCommitment={nftCommitment}
          setNftCommitment={setNftCommitment}
        />

        {/* Bytecode Size Display */}
        {showFee && (
          <div className="mb-6 break-words whitespace-normal">
            <h3 className="flex justify-between items-baseline mb-2">
              <span className="font-bold">Transaction Fee:</span>
              <div className="flex flex-col items-end text-sm">
                <span className="text-right">{feeBch.toFixed(8)} BCH</span>
                <span className="text-right">{feeUsdLabel}</span>
              </div>
            </h3>
          </div>
        )}

        {/* Transaction Actions Component */}
        <TransactionActions
          // totalSelectedUtxoAmount={totalSelectedUtxoAmount}
          loading={loading}
          buildTransaction={buildTransaction}
          sendTransaction={handleSend}
          rawTX={rawTX}
          txOutputs={txOutputs}
          selectedUtxos={selectedUtxos}

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
            currentContractSource={currentContractSource}
            contractABI={currentContractABI}
            onClose={() => setShowPopup(false)}
            onFunctionSelect={onContractFunctionSelect}
          />
        )}
      </div>
    </ErrorBoundary>
  );
};

export default Transaction;

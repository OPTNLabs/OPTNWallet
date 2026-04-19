// src/pages/Transaction.tsx

import React, {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
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
import { type BroadcastState } from '../services/TransactionService';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import {
  getLegacyDefaultChangeAddress,
  getPreferredBchChangeAddress,
} from '../utils/changeAddressPreference';

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
  const [hasManualChangeSelection, setHasManualChangeSelection] =
    useState(false);
  const [preferredBchChangeAddress, setPreferredBchChangeAddress] =
    useState('');
  const [bytecodeSize, setBytecodeSize] = useState<number>(0);
  const [rawTX, setRawTX] = useState<string>('');
  const [transactionId, setTransactionId] = useState<string>('');
  const [broadcastState, setBroadcastState] =
    useState<BroadcastState>('broadcasted');
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
  const preferInternalChangeForBch = false;

  const utxosByAddress = useSelector((s: RootState) => s.utxos.utxos);

  const txOutputs = useSelector(
    (state: RootState) => state.transactionBuilder.txOutputs
  );

  const walletId = useSelector(selectWalletId);
  const {
    hasUnresolved,
    reservedOutpointKeys,
  } = useOutboundTransactions(walletId);
  useTransactionInit(dispatch);

  const resetTransactionViewState = useCallback(() => {
    setSelectedAddresses([]);
    setSelectedContractAddresses([]);
    setSelectedContractABIs([]);
    setSelectedUtxos([]);
    setTempUtxos(undefined);
    setRecipientAddress('');
    setTransferAmount(0);
    setTokenAmount(0);
    setSelectedTokenCategory('none');
    setBytecodeSize(0);
    setRawTX('');
    setBroadcastState('broadcasted');
    setShowPopup(false);
    setContractFunctionInputs(null);
    setCurrentContractABI([]);
    setCurrentContractSource('');
    setShowContractUTXOsPopup(false);
    setShowRegularUTXOsPopup(false);
    setShowCashTokenUTXOsPopup(false);
    setShowPaperWalletUTXOsPopup(false);
    setNftCapability(undefined);
    setNftCommitment(undefined);
    setHasManualChangeSelection(false);
  }, []);

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
      setBroadcastState,
      setLoading,
      resetTransactionViewState
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
    reservedOutpointKeys,
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

  const hasTokenOutputs = useMemo(
    () => txOutputs.some((output) => 'token' in output && !!output.token),
    [txOutputs]
  );

  const setChangeAddressWithOverride = useCallback((address: string) => {
    setHasManualChangeSelection(true);
    setChangeAddress(address);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!walletId) {
        if (!cancelled) setPreferredBchChangeAddress('');
        return;
      }

      if (!preferInternalChangeForBch || hasTokenOutputs) {
        if (!cancelled) {
          setPreferredBchChangeAddress(getLegacyDefaultChangeAddress(addresses));
        }
        return;
      }

      try {
        const preferred = await getPreferredBchChangeAddress(walletId, addresses);
        if (!cancelled) setPreferredBchChangeAddress(preferred);
      } catch {
        if (!cancelled) {
          setPreferredBchChangeAddress(getLegacyDefaultChangeAddress(addresses));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [walletId, addresses, preferInternalChangeForBch, hasTokenOutputs]);

  useEffect(() => {
    if (hasManualChangeSelection) return;

    const legacyDefault = getLegacyDefaultChangeAddress(addresses);
    const nextDefault =
      preferInternalChangeForBch && !hasTokenOutputs
        ? preferredBchChangeAddress || legacyDefault
        : legacyDefault;

    if (changeAddress !== nextDefault) {
      setChangeAddress(nextDefault);
    }
  }, [
    addresses,
    changeAddress,
    hasManualChangeSelection,
    hasTokenOutputs,
    preferInternalChangeForBch,
    preferredBchChangeAddress,
  ]);

  const hasSourceSelection =
    selectedAddresses.length > 0 || selectedContractAddresses.length > 0;
  const hasInputSelection = selectedUtxos.length > 0;
  const hasOutputs = txOutputs.length > 0;
  const hasBuiltTransaction = rawTX !== '';
  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | 4>(1);

  const stepStates = [
    {
      label: 'Choose a source',
      state: hasSourceSelection ? 'done' : 'current',
    },
    {
      label: 'Pick funds',
      state: hasInputSelection
        ? 'done'
        : hasSourceSelection
          ? 'current'
          : 'upcoming',
    },
    {
      label: 'Add recipients',
      state: hasOutputs ? 'done' : hasInputSelection ? 'current' : 'upcoming',
    },
    {
      label: 'Review and send',
      state: hasBuiltTransaction
        ? 'done'
        : hasOutputs
          ? 'current'
          : 'upcoming',
    },
  ] as const;

  const canOpenStep = (step: 1 | 2 | 3 | 4) => {
    if (step === 1) return true;
    if (step === 2) return hasSourceSelection;
    if (step === 3) return hasInputSelection;
    return hasOutputs;
  };

  const goToNextStep = () => {
    setActiveStep((prev) => {
      if (prev === 1 && hasSourceSelection) return 2;
      if (prev === 2 && hasInputSelection) return 3;
      if (prev === 3 && hasOutputs) return 4;
      return prev;
    });
  };

  const goToPreviousStep = () => {
    setActiveStep((prev) => {
      if (prev === 4) return 3;
      if (prev === 3) return 2;
      if (prev === 2) return 1;
      return prev;
    });
  };

  return (
    <ErrorBoundary>
      <div className="container mx-auto max-w-xl h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-[calc(var(--safe-bottom)+1rem)] flex flex-col overflow-hidden wallet-page">
        <PageHeader
          title="Custom Send"
          compact
        />

        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        <SectionCard className="mb-3 wallet-step-card">
          <div className="flex items-center justify-between gap-3">
            <div className="wallet-kicker">Flow</div>
            <details className="text-right">
              <summary className="cursor-pointer text-xs wallet-muted list-none">
                How this works
              </summary>
              <p className="mt-2 max-w-[220px] text-xs wallet-muted">
                Pick a source, choose funds, add recipients, then preview the
                final transaction before sending.
              </p>
            </details>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {stepStates.map((step, index) => (
              <button
                key={step.label}
                type="button"
                onClick={() => {
                  const nextStep = (index + 1) as 1 | 2 | 3 | 4;
                  if (canOpenStep(nextStep)) setActiveStep(nextStep);
                }}
                disabled={!canOpenStep((index + 1) as 1 | 2 | 3 | 4)}
                className={`rounded-xl border px-3 py-2.5 ${
                  activeStep === index + 1
                    ? 'ring-2 ring-[var(--wallet-focus-ring)]'
                    : ''
                } ${
                  step.state === 'done'
                    ? 'wallet-success-panel'
                    : step.state === 'current'
                      ? 'wallet-selectable-active'
                      : 'wallet-selectable-inactive'
                } ${!canOpenStep((index + 1) as 1 | 2 | 3 | 4) ? 'opacity-60' : ''}`}
              >
                <div className="text-xs font-semibold uppercase tracking-[0.12em] opacity-80">
                  Step {index + 1}
                </div>
                <div className="mt-1 text-sm font-semibold">{step.label}</div>
              </button>
            ))}
          </div>
        </SectionCard>

        <SectionCard className="mb-4 wallet-step-card">
          {activeStep === 1 && (
            <>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="wallet-kicker">Step 1</div>
                  <h2 className="text-lg font-semibold wallet-text-strong">
                    Choose source
                  </h2>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs wallet-muted list-none">
                    Help
                  </summary>
                  <p className="mt-2 max-w-[180px] text-xs wallet-muted">
                    Pick wallet addresses for normal sends, or contracts for script
                    spends.
                  </p>
                </details>
              </div>
              <div className="flex flex-wrap gap-2 mb-2">
                <span className="wallet-chip">
                  {selectedAddresses.length} wallet source
                  {selectedAddresses.length === 1 ? '' : 's'}
                </span>
                <span className="wallet-chip">
                  {selectedContractAddresses.length} contract source
                  {selectedContractAddresses.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
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
            </>
          )}

          {activeStep === 2 && (
            <>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="wallet-kicker">Step 2</div>
                  <h2 className="text-lg font-semibold wallet-text-strong">
                    Pick funds
                  </h2>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs wallet-muted list-none">
                    Help
                  </summary>
                  <p className="mt-2 max-w-[180px] text-xs wallet-muted">
                    Select the BCH, tokens, or collectibles that will fund this
                    transaction.
                  </p>
                </details>
              </div>
              <UTXOSelection
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
                closePopups={closePopups}
              />

              <SelectedUTXOsDisplay
                selectedUtxos={selectedUtxos}
                selectedAddresses={selectedAddresses}
                selectedContractAddresses={selectedContractAddresses}
                totalSelectedUtxoAmount={totalSelectedUtxoAmount}
                handleUtxoClick={handleUtxoClick}
                currentNetwork={currentNetwork}
              />
            </>
          )}

          {activeStep === 3 && (
            <>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="wallet-kicker">Step 3</div>
                  <h2 className="text-lg font-semibold wallet-text-strong">
                    Add recipients
                  </h2>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs wallet-muted list-none">
                    Help
                  </summary>
                  <p className="mt-2 max-w-[180px] text-xs wallet-muted">
                    Add BCH recipients, token transfers, collectibles, or an
                    optional message output.
                  </p>
                </details>
              </div>

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
                setChangeAddress={setChangeAddressWithOverride}
                nftCapability={nftCapability}
                setNftCapability={setNftCapability}
                nftCommitment={nftCommitment}
                setNftCommitment={setNftCommitment}
              />
            </>
          )}

          {activeStep === 4 && (
            <>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="wallet-kicker">Step 4</div>
                  <h2 className="text-lg font-semibold wallet-text-strong">
                    Review and send
                  </h2>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs wallet-muted list-none">
                    Help
                  </summary>
                  <p className="mt-2 max-w-[180px] text-xs wallet-muted">
                    Preview first, then send only when the summary looks right.
                  </p>
                </details>
              </div>

              <div className="space-y-2 mb-4">
                <div className="wallet-stat-row">
                  <span className="text-sm wallet-muted">Sources chosen</span>
                  <span className="font-semibold wallet-text-strong">
                    {selectedAddresses.length + selectedContractAddresses.length}
                  </span>
                </div>
                <div className="wallet-stat-row">
                  <span className="text-sm wallet-muted">Funds selected</span>
                  <span className="font-semibold wallet-text-strong">
                    {selectedUtxos.length}
                  </span>
                </div>
                <div className="wallet-stat-row">
                  <span className="text-sm wallet-muted">Recipients added</span>
                  <span className="font-semibold wallet-text-strong">
                    {txOutputs.length}
                  </span>
                </div>
                {showFee && (
                  <div className="wallet-stat-row">
                    <span className="text-sm wallet-muted">Estimated network fee</span>
                    <div className="text-right">
                      <div className="font-semibold wallet-text-strong">
                        {feeBch.toFixed(8)} BCH
                      </div>
                      <div className="text-xs wallet-muted">{feeUsdLabel}</div>
                    </div>
                  </div>
                )}
              </div>

              <TransactionActions
                loading={loading}
                buildTransaction={buildTransaction}
                sendTransaction={handleSend}
                rawTX={rawTX}
                txOutputs={txOutputs}
                selectedUtxos={selectedUtxos}
                sendingLocked={hasUnresolved}
              />
            </>
          )}

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--wallet-border)] pt-3">
            <button
              type="button"
              onClick={goToPreviousStep}
              disabled={activeStep === 1}
              className="wallet-btn-secondary flex-1"
            >
              Back
            </button>
            <button
              type="button"
              onClick={goToNextStep}
              disabled={
                (activeStep === 1 && !hasSourceSelection) ||
                (activeStep === 2 && !hasInputSelection) ||
                (activeStep === 3 && !hasOutputs) ||
                activeStep === 4
              }
              className="wallet-btn-primary flex-1"
            >
              {activeStep === 4 ? 'Ready' : 'Next'}
            </button>
          </div>
        </SectionCard>

        <ErrorAndStatusPopups
          showRawTxPopup={showRawTxPopup}
          showTxIdPopup={showTxIdPopup}
          rawTX={rawTX}
          transactionId={transactionId}
          errorMessage={errorMessage}
          currentNetwork={currentNetwork}
          broadcastState={broadcastState}
          closePopups={closePopups}
        />

        {showPopup && currentContractABI.length > 0 && (
          <SelectContractFunctionPopup
            currentContractSource={currentContractSource}
            contractABI={currentContractABI}
            onClose={() => setShowPopup(false)}
            onFunctionSelect={onContractFunctionSelect}
          />
        )}
        </div>
      </div>
    </ErrorBoundary>
  );
};

export default Transaction;

import { HashType, SignatureTemplate } from 'cashscript';
import { Dispatch, SetStateAction, useCallback } from 'react';
import ContractManager from '../../apis/ContractManager/ContractManager';
import { setInputValues, setSelectedFunction, resetContract } from '../../redux/contractSlice';
import { removeTxOutput } from '../../redux/transactionBuilderSlice';
import { AppDispatch } from '../../redux/store';
import TransactionService from '../../services/TransactionService';
import { PaperWalletSecretStore } from '../../services/PaperWalletSecretStore';
import KeyService from '../../services/KeyService';
import { UTXO } from '../../types/types';
import { toErrorMessage } from '../../utils/errorHandling';

export type ContractAbiInput = { name: string; type: string };

type UseTransactionHandlersParams = {
  dispatch: AppDispatch;
  rawTX: string;
  txOutputsLength: number;
  selectedUtxos: UTXO[];
  tempUtxos?: UTXO;
  recipientAddress: string;
  transferAmount: number;
  tokenAmount: number | bigint;
  selectedTokenCategory: string;
  addresses: { address: string; tokenAddress: string }[];
  nftCapability?: 'none' | 'mutable' | 'minting';
  nftCommitment?: string;
  handleSendTransaction: (
    rawTx: string,
    setTransactionId: Dispatch<SetStateAction<string>>
  ) => Promise<{ txid: string | null; errorMessage: string | null }>;
  txSetters: {
    setRawTX: (value: string) => void;
    setBytecodeSize: (value: number) => void;
    setErrorMessage: (value: string | null) => void;
  };
  selectionSetters: {
    setSelectedUtxos: (value: UTXO[] | ((prev: UTXO[]) => UTXO[])) => void;
    setSelectedAddresses: (
      value: string[] | ((prev: string[]) => string[])
    ) => void;
    setSelectedContractAddresses: (
      value: string[] | ((prev: string[]) => string[])
    ) => void;
  };
  contractSetters: {
    setShowPopup: (value: boolean) => void;
    setTempUtxos: (value: UTXO | undefined) => void;
    setCurrentContractABI: (value: unknown[]) => void;
    setCurrentContractSource: (value: string) => void;
  };
  outputSetters: {
    setRecipientAddress: (value: string) => void;
    setTransferAmount: (value: number) => void;
    setTokenAmount: (value: number | bigint) => void;
    setSelectedTokenCategory: (value: string) => void;
    setNftCapability: (
      value: undefined | 'none' | 'mutable' | 'minting'
    ) => void;
    setNftCommitment: (value: undefined | string) => void;
  };
  popupSetters: {
    setShowPaperWalletUTXOsPopup: (value: boolean) => void;
    setShowRawTxPopup: (value: boolean) => void;
    setShowTxIdPopup: (value: boolean) => void;
    setShowContractUTXOsPopup: (value: boolean) => void;
    setShowRegularUTXOsPopup: (value: boolean) => void;
    setShowCashTokenUTXOsPopup: (value: boolean) => void;
  };
};

export function useTransactionHandlers({
  dispatch,
  rawTX,
  txOutputsLength,
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
  txSetters: { setRawTX, setBytecodeSize, setErrorMessage },
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
}: UseTransactionHandlersParams) {
  const handleRemoveOutput = useCallback(
    (index: number) => {
      setRawTX('');
      setBytecodeSize(0);
      dispatch(removeTxOutput(index));
    },
    [dispatch, setBytecodeSize, setRawTX]
  );

  const handleUtxoClick = useCallback(
    async (utxo: UTXO) => {
      if (rawTX !== '' && txOutputsLength !== 0) {
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
        if (utxo.isPaperWallet) {
          PaperWalletSecretStore.del(utxo.tx_hash, utxo.tx_pos);
        }

        setSelectedUtxos(
          selectedUtxos.filter((selectedUtxo) => selectedUtxo.id !== utxo.id)
        );

        if (utxo.abi) {
          dispatch(resetContract());
        }
      } else {
        if (utxo.abi) {
          const contractManager = ContractManager();
          const constructorArgs = await contractManager.getContractInstanceByAddress(
            utxo.address
          );
          setShowPopup(true);
          setTempUtxos(utxo);
          setCurrentContractABI(utxo.abi);
          setCurrentContractSource(constructorArgs.artifact.source);
          setSelectedContractAddresses((prev) => [...prev, utxo.address]);
          return;
        }

        if (utxo.isPaperWallet) {
          setSelectedUtxos([...selectedUtxos, utxo]);
          setSelectedAddresses((prev) => [...prev, utxo.address]);
          setShowPaperWalletUTXOsPopup(true);
          dispatch(resetContract());
          return;
        }

        setSelectedUtxos([...selectedUtxos, utxo]);
        setSelectedAddresses((prev) => [...prev, utxo.address]);
        dispatch(resetContract());
      }
    },
    [
      dispatch,
      handleRemoveOutput,
      rawTX,
      selectedUtxos,
      setCurrentContractABI,
      setCurrentContractSource,
      setRawTX,
      setSelectedAddresses,
      setSelectedContractAddresses,
      setSelectedUtxos,
      setShowPaperWalletUTXOsPopup,
      setShowPopup,
      setTempUtxos,
      txOutputsLength,
    ]
  );

  const handleAddOutput = useCallback(() => {
    if (!recipientAddress || (!transferAmount && !tokenAmount)) {
      setErrorMessage('Recipient address and an amount are required');
      return;
    }

    if (rawTX !== '' && txOutputsLength !== 0) {
      handleRemoveOutput(-1);
    }

    try {
      const newOutput = TransactionService.addOutput(
        recipientAddress,
        transferAmount,
        tokenAmount,
        selectedTokenCategory,
        selectedUtxos,
        addresses,
        nftCapability,
        nftCommitment
      );

      if (newOutput) {
        setRecipientAddress('');
        setTransferAmount(0);
        setTokenAmount(0);
        setSelectedTokenCategory('');
        setNftCapability(undefined);
        setNftCommitment(undefined);
      }
    } catch (error: unknown) {
      setErrorMessage(`Error adding output: ${toErrorMessage(error)}`);
    }
  }, [
    addresses,
    handleRemoveOutput,
    nftCapability,
    nftCommitment,
    rawTX,
    recipientAddress,
    selectedTokenCategory,
    selectedUtxos,
    setErrorMessage,
    setNftCapability,
    setNftCommitment,
    setRecipientAddress,
    setSelectedTokenCategory,
    setTokenAmount,
    setTransferAmount,
    tokenAmount,
    transferAmount,
    txOutputsLength,
  ]);

  const sendTransaction = useCallback(
    (setTransactionId: Dispatch<SetStateAction<string>>) => {
      try {
        if (!rawTX) throw new Error('No transaction built');
        void handleSendTransaction(rawTX, setTransactionId);
      } catch (error: unknown) {
        setErrorMessage(`Failed to send transaction: ${toErrorMessage(error)}`);
      }
    },
    [handleSendTransaction, rawTX, setErrorMessage]
  );

  const closePopups = useCallback(() => {
    setShowRawTxPopup(false);
    setShowTxIdPopup(false);
    setShowContractUTXOsPopup(false);
    setShowRegularUTXOsPopup(false);
    setShowCashTokenUTXOsPopup(false);
    setShowPopup(false);
    setErrorMessage(null);
    setShowPaperWalletUTXOsPopup(false);
    PaperWalletSecretStore.clear();
  }, [
    setErrorMessage,
    setShowCashTokenUTXOsPopup,
    setShowContractUTXOsPopup,
    setShowPaperWalletUTXOsPopup,
    setShowPopup,
    setShowRawTxPopup,
    setShowRegularUTXOsPopup,
    setShowTxIdPopup,
  ]);

  const handleContractFunctionSelect = useCallback(
    async (
      contractFunction: string,
      inputs: { [key: string]: string },
      abiInputs: ContractAbiInput[]
    ) => {
      if (typeof inputs !== 'object' || Array.isArray(inputs)) {
        console.error("Error: 'inputs' is not a valid object. Received:", inputs);
        return;
      }

      setErrorMessage(null);
      dispatch(setSelectedFunction(contractFunction));
      dispatch(setInputValues(inputs));

      const unlockerInputs = await Promise.all(
        abiInputs.map(async (abiIn) => {
          const raw = inputs[abiIn.name] ?? '';

          if (abiIn.type === 'sig') {
            const address = raw.startsWith('sigaddr:')
              ? raw.slice('sigaddr:'.length)
              : raw;

            const pk = await KeyService.fetchAddressPrivateKey(address);
            if (!pk) throw new Error(`Missing private key for address: ${address}`);
            return new SignatureTemplate(pk, HashType.SIGHASH_ALL);
          }

          return raw;
        })
      );

      const unlocker = { contractFunction, unlockerInputs };

      if (tempUtxos) {
        const updatedUtxo: UTXO = {
          ...tempUtxos,
          unlocker,
          contractFunction,
          contractFunctionInputs: inputs,
        };
        setSelectedUtxos([...selectedUtxos, updatedUtxo]);
      }

      setShowPopup(false);
    },
    [dispatch, selectedUtxos, setErrorMessage, setSelectedUtxos, setShowPopup, tempUtxos]
  );

  return {
    handleRemoveOutput,
    handleUtxoClick,
    handleAddOutput,
    sendTransaction,
    closePopups,
    handleContractFunctionSelect,
  };
}

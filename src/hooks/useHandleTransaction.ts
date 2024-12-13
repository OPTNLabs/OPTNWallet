// src/hooks/useHandleTransaction.ts

import { useDispatch } from 'react-redux';
import TransactionService from '../services/TransactionService';
import { TransactionOutput, UTXO } from '../types/types';
import {
  clearTransaction,
  setTxOutputs,
} from '../redux/transactionBuilderSlice';
import { resetTransactions } from '../redux/transactionSlice';
import { resetContract } from '../redux/contractSlice';

interface BuildTransactionResult {
  bytecodeSize: number;
  finalTransaction: string;
  finalOutputs: TransactionOutput[] | null;
  errorMsg: string;
}

const useHandleTransaction = (
  txOutputs: TransactionOutput[],
  contractFunctionInputs: { [key: string]: string } | null,
  changeAddress: string,
  selectedUtxos: UTXO[],
  setBytecodeSize: React.Dispatch<React.SetStateAction<number | null>>,
  setRawTX: React.Dispatch<React.SetStateAction<string>>,
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>,
  setShowRawTxPopup: React.Dispatch<React.SetStateAction<boolean>>,
  setShowTxIdPopup: React.Dispatch<React.SetStateAction<boolean>>, // Added parameter
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
) => {
  const dispatch = useDispatch();

  const handleBuildTransaction = async () => {
    try {
      setLoading(true);
      // console.log('Building transaction with:');
      // console.log('Outputs:', txOutputs);
      // console.log('Contract Function Inputs:', contractFunctionInputs);
      // console.log('Selected UTXOs:', selectedUtxos); // **Add Logging**

      // If a contract function is selected, ensure inputs are provided
      if (
        contractFunctionInputs &&
        Object.keys(contractFunctionInputs).length === 0
      ) {
        setErrorMessage(
          'Please provide all required contract function inputs.'
        );
        setLoading(false);
        return;
      }

      const transaction: BuildTransactionResult =
        await TransactionService.buildTransaction(
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

      // console.log('Transaction Build Result:', transaction);

      setBytecodeSize(transaction.bytecodeSize);
      setRawTX(transaction.finalTransaction);

      // Update Redux outputs state with finalOutputs
      if (transaction.finalOutputs) {
        // Clear existing outputs
        dispatch(clearTransaction());

        // Set the entire txOutputs array to finalOutputs
        dispatch(setTxOutputs(transaction.finalOutputs));

        // console.log('Final Outputs after Build:', transaction.finalOutputs);
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

  const handleSendTransaction = async (
    rawTX: string,
    setTransactionId: React.Dispatch<React.SetStateAction<string>>
  ) => {
    try {
      setLoading(true);
      const transactionID = await TransactionService.sendTransaction(rawTX);

      if (transactionID.txid) {
        setTransactionId(transactionID.txid);
        setShowTxIdPopup(true); // Trigger the popup
      }

      if (transactionID.errorMessage) {
        setErrorMessage(transactionID.errorMessage);
      } else {
        // Reset both transaction and contract states if successful
        dispatch(resetTransactions());
        dispatch(resetContract());
      }

      setLoading(false);
      return transactionID;
    } catch (error: any) {
      console.error('Error sending transaction:', error);
      setErrorMessage('Error sending transaction: ' + error.message);
      setShowTxIdPopup(false); // Ensure popup is not shown on error
      setLoading(false);
      return { txid: null, errorMessage: error.message };
    }
  };

  return { handleBuildTransaction, handleSendTransaction };
};

export default useHandleTransaction;

// src/services/TransactionOutputService.ts
import { TransactionOutput, UTXO } from '../types/types';
import { store } from '../redux/store';
import { addTxOutput } from '../redux/transactionBuilderSlice';

function createTransactionOutput(
  recipientAddress: string,
  transferAmount: number,
  tokenAmount: number,
  selectedTokenCategory: string,
  selectedUtxos: UTXO[],
  addresses: { address: string; tokenAddress?: string }[]
): TransactionOutput {
  const newOutput: TransactionOutput = {
    recipientAddress,
    amount: transferAmount,
  };

  if (selectedTokenCategory) {
    const tokenUTXO = selectedUtxos.find(
      (utxo) =>
        utxo.token_data && utxo.token_data.category === selectedTokenCategory
    );

    if (tokenUTXO && tokenUTXO.token_data) {
      newOutput.token = {
        amount: tokenAmount,
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
  store.dispatch(addTxOutput(newOutput));
  return newOutput;
}

export default {
  createTransactionOutput,
};

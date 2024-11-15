//@ts-nocheck
// src/services/TransactionService.ts
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  HashType,
} from 'cashscript';
import { UTXO, TransactionOutput } from '../types/types';
import PrivateKeyService from './PrivateKeyService';
import ContractService from './ContractService';
import { store } from '../redux/store';

export default function TransactionService() {
  const currentNetwork = store.getState().network.currentNetwork;
  const provider = new ElectrumNetworkProvider(currentNetwork);
  const contractService = ContractService();

  async function buildTransaction(
    utxos: UTXO[],
    outputs: TransactionOutput[],
    contractFunction: string | null = null,
    contractFunctionInputs: any[] | null = null
  ) {
    const txBuilder = new TransactionBuilder({ provider });

    const unlockableUtxos = await Promise.all(
      utxos.map(async (utxo) => {
        let unlocker: any;

        // Ensure the UTXO has `value`, convert `amount` to `value`
        const processedUtxo = {
          ...utxo,
          value: utxos.value || utxos.amount,
        };

        if (!processedUtxo.contractName || !processedUtxo.abi) {
          // Non-contract UTXOs (e.g., P2PKH)
          const privateKey = await PrivateKeyService.fetchPrivateKey(
            processedUtxo.address
          );
          const signatureTemplate = new SignatureTemplate(
            privateKey,
            HashType.SIGHASH_ALL
          );
          unlocker = signatureTemplate.unlockP2PKH();
        } else {
          // Contract UTXOs
          const contractUnlockFunction =
            await contractService.getContractUnlockFunction(
              processedUtxo,
              contractFunction!,
              contractFunctionInputs!
            );
          unlocker = contractUnlockFunction.unlocker;
        }

        return {
          txid: processedUtxo.tx_hash,
          vout: processedUtxo.tx_pos,
          satoshis: BigInt(processedUtxo.value),
          unlocker,
          token_data: processedUtxo.token_data,
        };
      })
    );

    txBuilder.addInputs(unlockableUtxos);
    txBuilder.addOutputs(
      outputs.map((output) => ({
        to: output.recipientAddress,
        amount: BigInt(output.amount),
        token: output.token
          ? {
              amount: BigInt(output.token.amount),
              category: output.token.category,
            }
          : undefined,
      }))
    );

    try {
      const builtTransaction = txBuilder.build();
      return builtTransaction;
    } catch (error) {
      console.error('Error building transaction:', error);
      return null;
    }
  }

  return {
    buildTransaction,
  };
}

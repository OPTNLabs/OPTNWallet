// src/apis/TransactionManager/TransactionBuilderHelper.ts

import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  HashType,
} from 'cashscript';
import ContractManager from '../ContractManager/ContractManager';
import { UTXO, TransactionOutput } from '../../types/types'; // Updated import to include UTXO and TransactionOutput interfaces
import { store } from '../../redux/store';
import KeyService from '../../services/KeyService';

export default function TransactionBuilderHelper() {
  const currentNetwork = store.getState().network.currentNetwork;
  const provider = new ElectrumNetworkProvider(currentNetwork);
  const contractManager = ContractManager();

  /**
   * Prepares transaction outputs by formatting them according to CashScript requirements.
   *
   * @param outputs - An array of TransactionOutput objects.
   * @returns An array of formatted outputs.
   */
  function prepareTransactionOutputs(outputs: TransactionOutput[]): any[] {
    return outputs.map((output) => {
      const baseOutput = {
        to: output.recipientAddress,
        amount: BigInt(output.amount),
      };

      if (output.token) {
        return {
          ...baseOutput,
          token: {
            amount: BigInt(output.token.amount),
            category: output.token.category,
          },
        };
      }

      return baseOutput;
    });
  }

  /**
   * Builds a transaction using selected UTXOs, outputs, and optional contract functions.
   *
   * @param utxos - An array of selected UTXOs.
   * @param outputs - An array of desired transaction outputs.
   * @param contractFunction - (Optional) The name of the contract function to invoke.
   * @param contractFunctionInputs - (Optional) An object containing inputs for the contract function.
   * @returns The built transaction or null if an error occurs.
   */
  async function buildTransaction(
    utxos: UTXO[],
    outputs: TransactionOutput[]
    // contractFunction: string | null = null,
    // contractFunctionInputs: { [key: string]: any } | null = null
  ) {
    const txBuilder = new TransactionBuilder({ provider });

    // Prepare unlockable UTXOs with appropriate unlockers
    const unlockableUtxos = await Promise.all(
      utxos.map(async (utxo) => {
        let unlocker: any;

        const processedUtxo = {
          ...utxo,
          value: utxo.value || utxo.amount,
        };

        if (!processedUtxo.contractName || !processedUtxo.abi) {
          // Regular UTXO - use signature unlocker
          const privateKey = utxo.privateKey
            ? utxo.privateKey
            : await KeyService.fetchAddressPrivateKey(processedUtxo.address);

          if (!privateKey || privateKey.length === 0) {
            throw new Error(
              `Private key not found or empty for address: ${processedUtxo.address}`
            );
          }

          const signatureTemplate = new SignatureTemplate(
            privateKey,
            HashType.SIGHASH_ALL
          );
          unlocker = signatureTemplate.unlockP2PKH();
        } else {
          // Contract UTXO - use contract unlocker
          if (!utxo.contractFunction || !utxo.contractFunctionInputs) {
            throw new Error('Contract function and inputs must be provided');
          }

          const contractUnlockFunction =
            await contractManager.getContractUnlockFunction(
              processedUtxo,
              utxo.contractFunction,
              utxo.contractFunctionInputs
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

    // Add inputs to the transaction builder
    txBuilder.addInputs(unlockableUtxos);

    // Prepare and add outputs
    const txOutputs = prepareTransactionOutputs(outputs);
    txBuilder.addOutputs(txOutputs);

    console.log(txBuilder);

    try {
      const builtTransaction = await txBuilder.build(); // Ensure await is present
      // console.log('Built Transaction:', builtTransaction);
      return builtTransaction;
    } catch (error) {
      console.error('Error building transaction:', error);
      throw error; // Propagate the error upwards for better handling
    }
  }

  /**
   * Sends a raw transaction to the network.
   *
   * @param tx - The raw transaction hex string.
   * @returns The transaction ID or null if an error occurs.
   */
  const sendTransaction = async (tx: string) => {
    try {
      const txid = await provider.sendRawTransaction(tx);
      return txid;
    } catch (error) {
      console.error(error);
      return null;
    }
  };

  return {
    buildTransaction,
    sendTransaction,
  };
}

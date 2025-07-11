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
   * Extracts the body of a specified function from the contract source code.
   *
   * @param source - The contract source code as a string.
   * @param functionName - The name of the function to extract.
   * @returns The function body as a string, or null if not found.
   */
  function extractFunctionBody(source: string, functionName: string): string | null {
    // Regex to match function definition, e.g., "function timeout(sig senderSig) {"
    const functionRegex = new RegExp(`function\\s+${functionName}\\s*\\(.*?\\)\\s*{`, 's');
    const match = source.match(functionRegex);
    if (!match || match.index === undefined) return null;

    const startIndex = match.index + match[0].length;
    let braceCount = 1;
    let endIndex = startIndex;

    // Count braces to find the end of the function body
    while (endIndex < source.length && braceCount > 0) {
      if (source[endIndex] === '{') braceCount++;
      else if (source[endIndex] === '}') braceCount--;
      endIndex++;
    }

    if (braceCount === 0) {
      return source.substring(startIndex, endIndex - 1).trim();
    }
    return null;
  }

  /**
   * Checks if the specified function uses time-related keywords (tx.time, tx.age, this.age).
   *
   * @param contractInstance - The contract instance containing the artifact.
   * @param functionName - The name of the function to check.
   * @returns True if the function uses tx.time, tx.age, or this.age; false otherwise.
   */
  function doesFunctionUseTimeKeywords(contractInstance: any, functionName: string): boolean {
    const source = contractInstance.artifact.source;
    const functionBody = extractFunctionBody(source, functionName);
    if (!functionBody) return false;

    // Check for any of the time-related keywords
    return (
      functionBody.includes('tx.time') ||
      functionBody.includes('tx.age') ||
      functionBody.includes('this.age')
    );
  }

  /**
   * Prepares transaction outputs by formatting them according to CashScript requirements.
   *
   * @param outputs - An array of TransactionOutput objects.
   * @returns An array of formatted outputs for cashscript TransactionBuilder.
   */
  function prepareTransactionOutputs(outputs: TransactionOutput[]): any[] {
    return outputs.map((output) => {
      // If this is an OP_RETURN variant
      if ('opReturn' in output && output.opReturn !== undefined) {
        return {
          opReturn: output.opReturn,
        };
      }

      // Otherwise, this is a "regular" or token output
      const baseOutput = {
        to: output.recipientAddress,
        amount: BigInt(output.amount),
      };

      // If there's a token field
      if (output.token) {
        return {
          ...baseOutput,
          token: {
            category: output.token.category,
            ...(output.token.nft && {
              nft: {
                capability: output.token.nft.capability,
                commitment: output.token.nft.commitment,
              },
            }),
            ...(output.token.amount && {
              amount: BigInt(output.token.amount),
            }),
          },
        };
      }

      // If there's no token, return the base output
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
    let needsLocktime = false;

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
          const contractInstance = await contractManager.getContractInstanceByAddress(utxo.address)
          console.log(contractInstance)
          // console.log(utxo)
          if (!utxo.contractFunction || !utxo.contractFunctionInputs) {
            throw new Error('Contract function and inputs must be provided');
          }

          // Check if the selected function uses time keywords
          const usesTimeKeywords = doesFunctionUseTimeKeywords(
            contractInstance,
            utxo.contractFunction
          );
          if (usesTimeKeywords) {
            needsLocktime = true;
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
          token: processedUtxo.token
            ? {
                ...processedUtxo.token,
                amount: BigInt(processedUtxo.token.amount), // convert amount to bigint
              }
            : undefined,
        };
      })
    );

    // Add inputs to the transaction builder
    txBuilder.addInputs(unlockableUtxos);

    // Prepare and add outputs
    const txOutputs = prepareTransactionOutputs(outputs);
    txBuilder.addOutputs(txOutputs);

    // Set locktime if any contract function uses time keywords
    if (needsLocktime) {
      const currentBlockHeight = await provider.getBlockHeight();
      txBuilder.setLocktime(currentBlockHeight);
    }

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

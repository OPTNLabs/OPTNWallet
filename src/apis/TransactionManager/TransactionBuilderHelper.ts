// src/apis/TransactionManager/TransactionBuilderHelper.ts

import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  HashType,
} from 'cashscript';
import ContractManager from '../ContractManager/ContractManager';
import { UTXO, TransactionOutput } from '../../types/types';
import { store } from '../../redux/store';
import KeyService from '../../services/KeyService';
import { PaperWalletSecretStore } from '../../services/PaperWalletSecretStore';
import { TOKEN_OUTPUT_SATS } from '../../utils/constants';

export default function TransactionBuilderHelper() {
  const currentNetwork = store.getState().network.currentNetwork;
  const provider = new ElectrumNetworkProvider(currentNetwork);
  const contractManager = ContractManager();

  // Safe bigint coercion for number | bigint | string | undefined/null
  function toBigIntAmount(value: unknown): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 0n;
      // BCH sats + token amounts should be integers
      return BigInt(Math.trunc(value));
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return 0n;
      try {
        return BigInt(trimmed);
      } catch {
        return 0n;
      }
    }
    return 0n;
  }

  /**
   * Extracts the body of a specified function from the contract source code.
   */
  function extractFunctionBody(
    source: string,
    functionName: string
  ): string | null {
    const functionRegex = new RegExp(
      `function\\s+${functionName}\\s*\\(.*?\\)\\s*{`,
      's'
    );
    const match = source.match(functionRegex);
    if (!match || match.index === undefined) return null;

    const startIndex = match.index + match[0].length;
    let braceCount = 1;
    let endIndex = startIndex;

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
   */
  function doesFunctionUseTimeKeywords(
    contractInstance: any,
    functionName: string
  ): boolean {
    const source = contractInstance.artifact.source;
    const functionBody = extractFunctionBody(source, functionName);
    if (!functionBody) return false;

    return (
      functionBody.includes('tx.time') ||
      functionBody.includes('tx.age') ||
      functionBody.includes('this.age')
    );
  }

  /**
   * Prepares transaction outputs by formatting them according to CashScript requirements.
   *
   * Token-bearing outputs are forced to have at least TOKEN_OUTPUT_SATS sats.
   * Token.amount is always included (NFTs should use amount=0).
   */
  function prepareTransactionOutputs(outputs: TransactionOutput[]): any[] {
    return outputs.map((output) => {
      // OP_RETURN variant
      if ('opReturn' in output && output.opReturn !== undefined) {
        return {
          opReturn: output.opReturn,
        };
      }

      // Regular or token output
      let amountSats = toBigIntAmount(output.amount);

      // Enforce token-bearing outputs have minimum sats
      if (output.token) {
        const minTokenSats = BigInt(TOKEN_OUTPUT_SATS);
        if (amountSats < minTokenSats) amountSats = minTokenSats;
      }

      const baseOutput = {
        to: output.recipientAddress,
        amount: amountSats,
      };

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
            // Always include amount: NFTs should be 0; FTs should be set by caller.
            amount: toBigIntAmount((output.token as any).amount ?? 0),
          },
        };
      }

      return baseOutput;
    });
  }

  /**
   * Builds a transaction using selected UTXOs and outputs.
   */
  async function buildTransaction(utxos: UTXO[], outputs: TransactionOutput[]) {
    const txBuilder = new TransactionBuilder({ provider });
    let needsLocktime = false;

    const unlockableUtxos = await Promise.all(
      utxos.map(async (utxo) => {
        let unlocker: any;

        // Prefer nullish coalescing so 0 doesn't fall through
        const value = (utxo.value ?? utxo.amount) as number | undefined;
        if (
          value === undefined ||
          value === null ||
          Number.isNaN(Number(value))
        ) {
          throw new Error(
            `UTXO missing value/amount for ${utxo.tx_hash}:${utxo.tx_pos}`
          );
        }

        const processedUtxo = {
          ...utxo,
          value,
        };

        if (!processedUtxo.contractName || !processedUtxo.abi) {
          let signingKey: Uint8Array | undefined;

          if (processedUtxo.isPaperWallet) {
            signingKey = PaperWalletSecretStore.get(
              processedUtxo.tx_hash,
              processedUtxo.tx_pos
            );
            if (!signingKey || signingKey.length === 0) {
              throw new Error(
                `Paper wallet key missing for outpoint ${processedUtxo.tx_hash}:${processedUtxo.tx_pos}`
              );
            }
          } else {
            signingKey = await KeyService.fetchAddressPrivateKey(
              processedUtxo.address
            );
            if (!signingKey || signingKey.length === 0) {
              throw new Error(
                `Private key not found or empty for address: ${processedUtxo.address}`
              );
            }
          }

          const signatureTemplate = new SignatureTemplate(
            signingKey,
            HashType.SIGHASH_ALL
          );
          unlocker = signatureTemplate.unlockP2PKH();
        } else {
          // Contract UTXO - contract unlocker
          const contractInstance =
            await contractManager.getContractInstanceByAddress(utxo.address);

          if (!utxo.contractFunction || !utxo.contractFunctionInputs) {
            throw new Error('Contract function and inputs must be provided');
          }

          const usesTimeKeywords = doesFunctionUseTimeKeywords(
            contractInstance,
            utxo.contractFunction
          );
          if (usesTimeKeywords) needsLocktime = true;

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
                // Always coerce safely; NFTs should end up with 0n
                amount: toBigIntAmount(
                  (processedUtxo.token as any).amount ?? 0
                ),
              }
            : undefined,
        };
      })
    );

    txBuilder.addInputs(unlockableUtxos);

    const txOutputs = prepareTransactionOutputs(outputs);
    txBuilder.addOutputs(txOutputs);

    if (needsLocktime) {
      const currentBlockHeight = await provider.getBlockHeight();
      txBuilder.setLocktime(currentBlockHeight);
    }

    try {
      const builtTransaction = await txBuilder.build();
      return builtTransaction;
    } catch (error) {
      console.error('Error building transaction:', error);
      throw error;
    }
  }

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

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

  function normalizeCategory(x: unknown): string {
    if (typeof x !== 'string') return '';
    return x.trim().toLowerCase().replace(/^0x/, '');
  }

  function validateAuthGuardShape(utxos: UTXO[], outputs: TransactionOutput[]) {
    // Find first AuthGuard contract spend in inputs
    const idx = utxos.findIndex(
      (u) =>
        String(u.contractName ?? '').toLowerCase() === 'authguard' &&
        String(u.contractFunction ?? '') === 'unlockWithNft'
    );

    if (idx === -1) return; // not an AuthGuard spend

    // AuthGuard contract checks tx.inputs[1] specifically
    if (utxos.length < 2) {
      throw new Error(
        'AuthGuard spend requires at least 2 inputs: [authHead, authKeyNFT, ...]'
      );
    }

    // Strongly enforce the recommended ordering for v1 UX
    if (idx !== 0) {
      throw new Error(
        `AuthGuard spend requires authHead to be inputs[0] (got inputs[${idx}]). Ensure inputs=[authHead, authKeyNFT, ...fee].`
      );
    }

    const authKey = utxos[1];
    if (!authKey.token) {
      throw new Error(
        'AuthGuard spend requires inputs[1] to be the AuthKey NFT (token UTXO with amount=0).'
      );
    }

    const authKeyAmt = toBigIntAmount((authKey.token as any).amount ?? 0);
    if (authKeyAmt !== 0n) {
      throw new Error(
        `AuthKey must be NFT-only (token amount must be 0). Got amount=${authKeyAmt.toString()}`
      );
    }

    // If keepGuarded=true, outputs[0] must preserve locking bytecode.
    // We can’t compute bytecode here, but we can enforce a sane structure:
    const keep = !!(utxos[0].contractFunctionInputs as any)?.keepGuarded;

    if (keep) {
      if (!outputs || outputs.length === 0) {
        throw new Error(
          'AuthGuard keepGuarded=true requires outputs[0] to be the authHead continuation.'
        );
      }
      const o0 = outputs[0];
      if ('opReturn' in o0 && o0.opReturn !== undefined) {
        throw new Error(
          'AuthGuard keepGuarded=true requires outputs[0] to be a normal output (not OP_RETURN).'
        );
      }
      const toAddr = (o0 as any).recipientAddress;
      if (!toAddr || typeof toAddr !== 'string') {
        throw new Error(
          'AuthGuard keepGuarded=true requires outputs[0].recipientAddress to be the authHead contract address.'
        );
      }
      // Best-effort check: if the contract UTXO has an address, ensure output[0] targets it
      const headAddr = utxos[0].address;
      if (headAddr && String(toAddr) !== String(headAddr)) {
        throw new Error(
          `AuthGuard keepGuarded=true requires outputs[0] to pay back to authHead address. expected=${headAddr} got=${String(
            toAddr
          )}`
        );
      }
    }
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
      let amountSats = toBigIntAmount((output as any).amount);

      // Enforce token-bearing outputs have minimum sats
      if ((output as any).token) {
        const minTokenSats = BigInt(TOKEN_OUTPUT_SATS);
        if (amountSats < minTokenSats) amountSats = minTokenSats;
      }

      const baseOutput = {
        to: (output as any).recipientAddress,
        amount: amountSats,
      };

      if ((output as any).token) {
        return {
          ...baseOutput,
          token: {
            category: (output as any).token.category,
            ...((output as any).token.nft && {
              nft: {
                capability: (output as any).token.nft.capability,
                commitment: (output as any).token.nft.commitment,
              },
            }),
            // Always include amount: NFTs should be 0; FTs should be set by caller.
            amount: toBigIntAmount(((output as any).token as any).amount ?? 0),
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
    // Preflight: fail early with clear errors for covenant ordering constraints
    validateAuthGuardShape(utxos, outputs);

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
                [
                  'Private key not found for selected input address.',
                  `address=${processedUtxo.address}`,
                  `outpoint=${processedUtxo.tx_hash}:${processedUtxo.tx_pos}`,
                  'Likely causes:',
                  '- address encoding mismatch (cashaddr vs token addr vs prefixed)',
                  '- wallet keys table no longer stores this address',
                  '- KeyService lookup now requires walletId/account and is not provided here',
                ].join(' ')
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

          // Patient-0 / fresh contract outputs may not have a DB instance.
          // Avoid null-deref; locktime can still be detected later if needed.
          if (contractInstance) {
            const usesTimeKeywords = doesFunctionUseTimeKeywords(
              contractInstance,
              utxo.contractFunction
            );
            if (usesTimeKeywords) needsLocktime = true;
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
    // IMPORTANT: do not swallow broadcast errors
    const txid = await provider.sendRawTransaction(tx);

    if (!txid || typeof txid !== 'string') {
      throw new Error(`Broadcast returned invalid txid: ${String(txid)}`);
    }

    return txid;
  };

  return {
    buildTransaction,
    sendTransaction,
  };
}

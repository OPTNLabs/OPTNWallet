// src/apis/TransactionManager/TransactionManager.ts

import { store } from '../../redux/store';
import { addTxOutput } from '../../redux/transactionBuilderSlice';
import ElectrumService from '../../services/ElectrumService';
import {
  TransactionHistoryItem,
  TransactionOutput,
  UTXO,
} from '../../types/types';
import DatabaseService from '../DatabaseManager/DatabaseService';
import TransactionBuilderHelper from './TransactionBuilderHelper';
import { DUST, TOKEN_OUTPUT_SATS } from '../../utils/constants';

export default function TransactionManager() {
  const dbService = DatabaseService();

  /**
   * Fetches transaction history from the Electrum service and stores it in the database.
   */
  async function fetchAndStoreTransactionHistory(
    walletId: number,
    address: string
  ): Promise<TransactionHistoryItem[]> {
    const db = dbService.getDatabase();
    if (!db) {
      throw new Error('Could not get database');
    }

    let history: TransactionHistoryItem[] = [];

    try {
      history = await ElectrumService.getTransactionHistory(address);

      if (!Array.isArray(history)) {
        throw new Error('Invalid transaction history format');
      }

      const timestamp = new Date().toISOString();

      db.exec('BEGIN TRANSACTION');

      const upsertStmt = db.prepare(`
        INSERT INTO transactions (wallet_id, tx_hash, height, timestamp, amount)
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
          height = excluded.height,
          timestamp = excluded.timestamp
      `);

      for (const tx of history) {
        upsertStmt.run([walletId, tx.tx_hash, tx.height, timestamp]);
      }

      upsertStmt.free();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      console.error(
        `Failed to fetch and store transaction history for address ${address}:`,
        error
      );
    }

    return history;
  }

  /**
   * Sends a raw transaction to the network using the TransactionBuilderHelper.
   */
  async function sendTransaction(rawTX: string) {
    const txBuilder = TransactionBuilderHelper();
    let txid: string | null = null;
    let errorMessage: string | null = null;
    try {
      txid = await txBuilder.sendTransaction(rawTX);
    } catch (error: any) {
      console.error('Error sending transaction:', error);
      errorMessage = 'Error sending transaction: ' + error.message;
    }
    return {
      txid,
      errorMessage,
    };
  }

  /**
   * Adds a new output to the transaction builder.
   *
   * Baseline rules:
   * - token-bearing outputs must have >= TOKEN_OUTPUT_SATS sats
   * - NFT token.amount must exist and should be 0 (do not delete it)
   */
  function addOutput(
    recipientAddress: string,
    transferAmount: number,
    tokenAmount: number | bigint,
    selectedTokenCategory: string = '',
    selectedUtxos: UTXO[] = [],
    addresses: { address: string; tokenAddress?: string }[] = [],
    nftCapability?: undefined | 'none' | 'mutable' | 'minting',
    nftCommitment?: string
  ): TransactionOutput | undefined {
    // Validate inputs
    if (!recipientAddress || (!transferAmount && !tokenAmount)) {
      console.warn(
        'addOutput: Invalid inputs. recipientAddress and at least one amount required.'
      );
      return undefined;
    }

    const newOutput: TransactionOutput = {
      recipientAddress,
      amount: transferAmount || 0,
    };

    if (selectedTokenCategory) {
      const existingTokenUTXO = selectedUtxos.find(
        (utxo) => utxo.token && utxo.token.category === selectedTokenCategory
      );

      const genesisUtxo = selectedUtxos.find(
        (utxo) =>
          !utxo.token &&
          utxo.tx_pos === 0 &&
          utxo.tx_hash === selectedTokenCategory
      );

      if (existingTokenUTXO && existingTokenUTXO.token) {
        // ------- TRANSFERRING EXISTING TOKEN -------
        newOutput.token = {
          amount: tokenAmount, // default FT amount
          category: existingTokenUTXO.token.category,
        };

        // NFT transfer: keep amount field present, force 0
        if (existingTokenUTXO.token.nft) {
          newOutput.token.amount = 0;
          newOutput.token.nft = {
            capability: existingTokenUTXO.token.nft.capability,
            commitment: existingTokenUTXO.token.nft.commitment,
          };
        }

        // Redirect to token address if available
        const tokenAddress = addresses.find(
          (addr) => addr.address === recipientAddress
        )?.tokenAddress;
        if (tokenAddress) {
          newOutput.recipientAddress = tokenAddress;
        }

        // Enforce token-bearing sats minimum
        if ((newOutput as any).amount < TOKEN_OUTPUT_SATS) {
          (newOutput as any).amount = TOKEN_OUTPUT_SATS;
        }
      } else if (genesisUtxo) {
        // ------- CREATING A NEW CASHTOKEN (GENESIS) -------
        const isNftGenesis = nftCapability && nftCommitment !== undefined;

        newOutput.token = {
          amount: isNftGenesis ? 0 : tokenAmount,
          category: genesisUtxo.tx_hash,
        };

        if (isNftGenesis) {
          newOutput.token.nft = {
            capability: nftCapability,
            commitment: nftCommitment!,
          };
        }

        // Redirect to token address if available
        const tokenAddress = addresses.find(
          (addr) => addr.address === recipientAddress
        )?.tokenAddress;
        if (tokenAddress) {
          newOutput.recipientAddress = tokenAddress;
        }

        // Enforce token-bearing sats minimum
        if ((newOutput as any).amount < TOKEN_OUTPUT_SATS) {
          (newOutput as any).amount = TOKEN_OUTPUT_SATS;
        }
      } else {
        console.warn(
          'addOutput: No matching token UTXO or valid genesis UTXO found for the selected category.'
        );
      }
    }

    store.dispatch(addTxOutput(newOutput));
    return newOutput;
  }

  /**
   * Builds a transaction using the provided outputs, change address, and selected UTXOs.
   *
   * Baseline rules:
   * - Fee policy: 1 sat/byte
   * - Change output is added only if >= DUST
   * - If remainder < DUST, no change output is added (remainder goes to fee)
   * - Token-bearing outputs should already have minimum sats, and TransactionBuilderHelper
   *   enforces it again at build time.
   */
  const buildTransaction = async (
    outputs: TransactionOutput[],
    contractFunctionInputs: { [key: string]: any } | null,
    changeAddress: string,
    selectedUtxos: UTXO[]
  ): Promise<{
    bytecodeSize: number;
    finalTransaction: string;
    finalOutputs: TransactionOutput[] | null;
    errorMsg: string;
  }> => {
    console.warn(`Unused Params: ${JSON.stringify(contractFunctionInputs)}`);

    const txBuilder = TransactionBuilderHelper();
    const returnObj = {
      bytecodeSize: 0,
      finalTransaction: '',
      finalOutputs: [] as TransactionOutput[],
      errorMsg: '',
    };

    // Defensive: amount might be in .value for some UTXOs, but your code currently uses .amount.
    // Keep behavior stable: prefer amount, fallback to value.
    const totalUtxoAmount = selectedUtxos.reduce((sum, utxo) => {
      const n = (utxo.amount ?? utxo.value) as number;
      return sum + BigInt(n || 0);
    }, 0n);

    const totalOutputAmount = outputs.reduce(
      (sum, output) => sum + BigInt(output.amount as any),
      0n
    );

    try {
      // 1) First build WITHOUT adding change to estimate fee at 1 sat/byte.
      //    If build fails without change (rare, but possible if builder requires change),
      //    we’ll fall back to a placeholder.
      let estimatedBytecodeSize = 0;

      try {
        const txNoChange = await txBuilder.buildTransaction(
          selectedUtxos,
          outputs
        );
        estimatedBytecodeSize = txNoChange.length / 2;
      } catch (e) {
        // Fallback: placeholder change output to allow size estimation
        const placeholder: TransactionOutput = {
          recipientAddress: changeAddress,
          amount: DUST,
        };
        const txWithPlaceholder = await txBuilder.buildTransaction(
          selectedUtxos,
          [...outputs, placeholder]
        );
        estimatedBytecodeSize = txWithPlaceholder.length / 2;
      }

      // Fee = 1 sat/byte * bytecodeSize
      const fee = BigInt(estimatedBytecodeSize);

      // Remainder after paying outputs + fee
      const remainder = totalUtxoAmount - totalOutputAmount - fee;

      if (remainder < 0n) {
        throw new Error(
          `Insufficient funds: inputs=${totalUtxoAmount.toString()} outputs=${totalOutputAmount.toString()} fee≈${fee.toString()}`
        );
      }

      const txOutputs: TransactionOutput[] = [...outputs];

      // Only add change if it is >= DUST
      if (changeAddress && remainder >= BigInt(DUST)) {
        txOutputs.push({
          recipientAddress: changeAddress,
          amount: Number(remainder),
        });
      } else {
        // remainder < DUST => no change, remainder is added to fee implicitly
        // (This is the correct "no dust change" policy.)
      }

      // 2) Final build
      const finalTransaction = await txBuilder.buildTransaction(
        selectedUtxos,
        txOutputs
      );

      returnObj.bytecodeSize = finalTransaction.length / 2;
      returnObj.finalTransaction = finalTransaction;
      returnObj.finalOutputs = txOutputs;
      returnObj.errorMsg = '';

      return returnObj;
    } catch (err: any) {
      console.error('Error building transaction:', err);
      returnObj.errorMsg = err.message || 'Unknown error';
      return returnObj;
    }
  };

  /**
   * Fetches the private key for a given address using the KeyService.
   * (Note: you said key storage baseline is deferred; leaving this unchanged.)
   */
  async function fetchPrivateKey(address: string): Promise<Uint8Array | null> {
    // Keeping this so other code that calls TransactionManager.fetchPrivateKey won't break
    // even if unused in current flows.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return await (
      await import('../../services/KeyService')
    ).default.fetchAddressPrivateKey(address);
  }

  return {
    fetchAndStoreTransactionHistory,
    sendTransaction,
    addOutput,
    buildTransaction,
    fetchPrivateKey,
  };
}

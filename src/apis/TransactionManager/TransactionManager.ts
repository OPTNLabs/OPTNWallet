// src/apis/TransactionManager/TransactionManager.ts

import { store } from '../../redux/store';
import { addTxOutput } from '../../redux/transactionBuilderSlice';
import ElectrumService from '../../services/ElectrumService';
import KeyService from '../../services/KeyService';
import {
  TransactionHistoryItem,
  TransactionOutput,
  UTXO,
} from '../../types/types';
import DatabaseService from '../DatabaseManager/DatabaseService';
import TransactionBuilderHelper from './TransactionBuilderHelper';

export default function TransactionManager() {
  const dbService = DatabaseService();

  /**
   * Fetches transaction history from the Electrum service and stores it in the database.
   *
   * @param walletId - The ID of the wallet.
   * @param address - The address to fetch transaction history for.
   * @returns An array of TransactionHistoryItem.
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
      // Fetch transaction history using Electrum service
      history = await ElectrumService.getTransactionHistory(address);

      // Validate the fetched history
      if (!Array.isArray(history)) {
        throw new Error('Invalid transaction history format');
      }

      const timestamp = new Date().toISOString();

      // Begin a database transaction for batch operations
      db.exec('BEGIN TRANSACTION');

      // Prepare the upsert statement using the UNIQUE constraint
      const upsertStmt = db.prepare(`
        INSERT INTO transactions (wallet_id, tx_hash, height, timestamp, amount)
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
          height = excluded.height,
          timestamp = excluded.timestamp
      `);

      // Iterate through each transaction and perform upsert
      for (const tx of history) {
        upsertStmt.run([walletId, tx.tx_hash, tx.height, timestamp]);
      }

      // Finalize the prepared statement
      upsertStmt.free();

      // Commit the transaction after successful operations
      db.exec('COMMIT');

      console.log(
        `Fetched and stored transaction history for address ${address}`
      );
    } catch (error) {
      // Rollback the transaction in case of any errors
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
   *
   * @param rawTX - The raw transaction hex string.
   * @returns An object containing the transaction ID and any error message.
   */
  async function sendTransaction(rawTX: string) {
    const txBuilder = TransactionBuilderHelper();
    let txid: string | null = null;
    let errorMessage: string | null = null;
    try {
      txid = await txBuilder.sendTransaction(rawTX);
      console.log('Sent Transaction:', txid);
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
   * @param recipientAddress - The address of the transaction recipient.
   * @param transferAmount - The amount to transfer in satoshis.
   * @param tokenAmount - The amount of tokens to transfer.
   * @param selectedTokenCategory - The category of the selected token.
   * @param selectedUtxos - The selected UTXOs for the transaction.
   * @param addresses - An array of addresses with optional token addresses.
   * @returns The newly created TransactionOutput or undefined if inputs are invalid.
   */
  function addOutput(
    recipientAddress: string,
    transferAmount: number,
    tokenAmount: number,
    selectedTokenCategory: string = '',
    selectedUtxos: UTXO[] = [],
    addresses: { address: string; tokenAddress?: string }[] = []
  ): TransactionOutput | undefined {
    // Validate inputs
    if (!recipientAddress || (!transferAmount && !tokenAmount)) {
      console.warn(
        'addOutput: Invalid inputs. recipientAddress and at least one amount required.'
      );
      return undefined;
    }

    // Initialize the new output
    const newOutput: TransactionOutput = {
      recipientAddress,
      amount: transferAmount || 0,
    };

    // Handle token transfers if a category is selected
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

        // Update the recipient address to the token address if available
        const tokenAddress = addresses.find(
          (addr) => addr.address === recipientAddress
        )?.tokenAddress;
        if (tokenAddress) {
          newOutput.recipientAddress = tokenAddress;
        }
      } else {
        console.warn(
          'addOutput: No matching token UTXO found for selected category.'
        );
      }
    }

    // Dispatch the new output to the Redux store
    store.dispatch(addTxOutput(newOutput));
    console.log('TransactionManager: Added new output:', newOutput);
    return newOutput;
  }

  /**
   * Builds a transaction using the provided outputs, contract function inputs, change address, and selected UTXOs.
   *
   * @param outputs - An array of TransactionOutput objects.
   * @param contractFunctionInputs - The inputs for the contract function.
   * @param changeAddress - The address to send any remaining funds.
   * @param selectedUtxos - An array of selected UTXOs for the transaction.
   * @returns An object containing bytecode size, final transaction, final outputs, and any error message.
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
    console.log(
      `TransactionManager: txOutputs: ${JSON.stringify(outputs, null, 2)}`
    );
    console.log(
      `TransactionManager" functionInputs: ${JSON.stringify(contractFunctionInputs)}`
    );
    console.log('TransactionManager: Change Address:', changeAddress);
    console.log('TransactionManager: Selected UTXOs:', selectedUtxos);
    // Fetch the latest state
    // const state = store.getState();
    // const selectedFunction = state.contract.selectedFunction;
    const txBuilder = TransactionBuilderHelper();
    const returnObj = {
      bytecodeSize: 0,
      finalTransaction: '',
      finalOutputs: [] as TransactionOutput[],
      errorMsg: '',
    };

    try {
      // Add a placeholder output for change to calculate bytecode size
      const placeholderOutput: TransactionOutput = {
        recipientAddress: changeAddress,
        amount: 546, // Dust amount to ensure proper transaction formatting
      };
      const txOutputsWithPlaceholder = [...outputs, placeholderOutput];
      console.log(
        'Transaction Outputs with Placeholder:',
        txOutputsWithPlaceholder
      );

      // First build to get bytecode size
      const transaction = await txBuilder.buildTransaction(
        selectedUtxos,
        txOutputsWithPlaceholder
        // selectedFunction,
        // contractFunctionInputs
      );
      console.log('Transaction after first build:', transaction);

      if (transaction) {
        // Calculate bytecode size based on transaction length
        const bytecodeSize = transaction.length / 2;
        returnObj.bytecodeSize = bytecodeSize;

        // Calculate total input and output amounts
        const totalUtxoAmount = selectedUtxos.reduce(
          (sum, utxo) => sum + BigInt(utxo.amount),
          BigInt(0)
        );
        console.log(`Total UTXO Amount: ${totalUtxoAmount}`);

        const totalOutputAmount = outputs.reduce(
          (sum, output) => sum + BigInt(output.amount),
          BigInt(0)
        );
        console.log(`Total Output Amount: ${totalOutputAmount}`);

        // Calculate the remaining amount after outputs and bytecode
        const remainder =
          totalUtxoAmount - totalOutputAmount - BigInt(bytecodeSize);
        console.log(`Bytecode Size: ${bytecodeSize}`);
        console.log(`Remainder: ${remainder}`);

        // Remove the placeholder output
        const txOutputs = [...outputs];
        console.log('Transaction Outputs before adding change:', txOutputs);

        // Add the change output if there's a remainder
        if (changeAddress && remainder > BigInt(0)) {
          const changeAmount = Number(remainder);
          console.log(`Calculated Change Amount: ${changeAmount}`);

          if (changeAmount > 0) {
            const changeOutput: TransactionOutput = {
              recipientAddress: changeAddress,
              amount: changeAmount,
              // Optionally, mark this as a change output
              // isChange: true,
            };
            txOutputs.push(changeOutput);
            console.log('Added Change Output:', changeOutput);
          } else {
            console.warn('No sufficient remainder to add a change output.');
          }
        } else {
          console.warn('No remainder to add a change output.');
        }

        console.log('Final Transaction Outputs:', txOutputs);

        // Build the final transaction with the updated outputs
        const finalTransaction = await txBuilder.buildTransaction(
          selectedUtxos,
          txOutputs
          // selectedFunction,
          // contractFunctionInputs
        );
        console.log('Final Transaction:', finalTransaction);

        returnObj.finalTransaction = finalTransaction;
        returnObj.finalOutputs = txOutputs;

        console.log('Final Transaction Outputs:', txOutputs);

        returnObj.errorMsg = '';
      }
    } catch (err: any) {
      console.error('Error building transaction:', err);
      returnObj.errorMsg = err.message || 'Unknown error';
    }
    return returnObj;
  };

  /**
   * Fetches the private key for a given address using the KeyService.
   *
   * @param address - The address to fetch the private key for.
   * @returns A Uint8Array representing the private key or null if not found.
   */
  const fetchPrivateKey = async (
    address: string
  ): Promise<Uint8Array | null> => {
    return await KeyService.fetchAddressPrivateKey(address);
  };

  return {
    fetchAndStoreTransactionHistory,
    sendTransaction,
    addOutput,
    buildTransaction,
    fetchPrivateKey,
  };
}

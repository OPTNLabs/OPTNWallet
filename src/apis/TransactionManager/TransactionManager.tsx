import DatabaseService from '../DatabaseManager/DatabaseService';
import {
  TransactionHistoryItem,
  TransactionOutput,
  UTXO,
} from '../../types/types'; // Assuming TransactionHistoryItem is defined in the types file
import ElectrumService from '../../services/ElectrumService';
import TransactionBuilderHelper from './TransactionBuilderHelper';
import { addTxOutput } from '../../redux/transactionBuilderSlice';
import { store } from '../../redux/store';
import KeyService from '../../services/KeyService';

export default function TransactionManager() {
  const state = store.getState();

  const dbService = DatabaseService();

  // Fetch and store transaction history in the database
  async function fetchAndStoreTransactionHistory(
    walletId: string,
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

      // Check if history is an array
      if (!Array.isArray(history)) {
        throw new Error('Invalid transaction history format');
      }

      const timestamp = new Date().toISOString();

      // Start a database transaction
      db.exec('BEGIN TRANSACTION');

      for (const tx of history) {
        // Query for existing transactions by wallet_id and tx_hash
        const existingTransaction = db.exec(`
          SELECT tx_hash, height FROM transactions WHERE wallet_id = ${walletId} AND tx_hash = '${tx.tx_hash}'
        `);

        if (existingTransaction.length > 0) {
          // Get the existing height
          const existingHeight = existingTransaction[0].values[0][1] as number;

          // Update the transaction if needed
          if (
            existingHeight === -1 ||
            existingHeight === 0 ||
            existingHeight !== tx.height
          ) {
            db.exec(`
              UPDATE transactions SET height = ${tx.height}, timestamp = '${timestamp}' WHERE wallet_id = ${walletId} AND tx_hash = '${tx.tx_hash}'
            `);
          }
        } else {
          // Insert the transaction if it doesn't already exist
          db.exec(`
            INSERT OR IGNORE INTO transactions (wallet_id, tx_hash, height, timestamp, amount)
            VALUES (${walletId}, '${tx.tx_hash}', ${tx.height}, '${timestamp}', 0)
          `);
        }
      }

      // Commit the transaction after processing
      db.exec('COMMIT');

      console.log(
        `Fetched and stored transaction history for address ${address}`
      );
    } catch (error) {
      // Rollback the transaction in case of errors
      db.exec('ROLLBACK');
      console.error(
        `Failed to fetch and store transaction history for address ${address}:`,
        error
      );
    }

    return history;
  }

  // Send a raw transaction to the network
  async function sendTransaction(rawTX: string) {
    const txBuilder = TransactionBuilderHelper();
    let txid = null;
    let errorMessage = null;
    try {
      txid = await txBuilder.sendTransaction(rawTX);
      console.log('Sent Transaction:', txid);
    } catch (error) {
      console.error('Error sending transaction:', error);
      errorMessage = 'Error sending transaction: ' + error.message;
    }
    return {
      txid,
      errorMessage,
    };
  }

  // Add a new output to the transaction builder
  async function addOutput(
    recipientAddress: string,
    transferAmount: number,
    tokenAmount: number,
    selectedTokenCategory: string = '',
    selectedUtxos: UTXO[] = [],
    addresses: { address: string; tokenAddress?: string }[] = []
  ) {
    if (recipientAddress && (transferAmount || tokenAmount)) {
      const newOutput: TransactionOutput = {
        recipientAddress,
        amount: Number(transferAmount) || 0,
      };

      if (selectedTokenCategory) {
        const tokenUTXO = selectedUtxos.find(
          (utxo) =>
            utxo.token_data &&
            utxo.token_data.category === selectedTokenCategory
        );

        if (tokenUTXO && tokenUTXO.token_data) {
          newOutput.token = {
            amount: Number(tokenAmount),
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
  }

  // Build a transaction using provided inputs and outputs
  const buildTransaction = async (
    outputs: TransactionOutput[],
    contractFunctionInputs: any,
    changeAddress: string,
    selectedUtxos: UTXO[]
  ) => {
    const selectedFunction = state.contract.selectedFunction;
    const txBuilder = TransactionBuilderHelper();
    const returnObj = {
      bytecodeSize: 0,
      finalTransaction: '',
      finalOutputs: null as TransactionOutput[] | null,
      errorMsg: '',
    };

    console.log(`txOutputs: ${JSON.stringify(outputs, null, 2)}`);
    console.log(`functionInputs: ${JSON.stringify(contractFunctionInputs)}`);

    try {
      const placeholderOutput: TransactionOutput = {
        recipientAddress: changeAddress,
        amount: 546,
      };
      const txOutputs = [...outputs, placeholderOutput];

      const transaction = await txBuilder.buildTransaction(
        selectedUtxos,
        txOutputs,
        selectedFunction,
        contractFunctionInputs
      );

      if (transaction) {
        const bytecodeSize = transaction.length / 2;
        returnObj.bytecodeSize = bytecodeSize;

        const totalUtxoAmount = selectedUtxos.reduce(
          (sum, utxo) => sum + BigInt(utxo.amount),
          BigInt(0)
        );

        const totalOutputAmount = outputs.reduce(
          (sum, output) => sum + BigInt(output.amount),
          BigInt(0)
        );

        // Convert bytecodeSize to BigInt for arithmetic operation
        const remainder =
          totalUtxoAmount - totalOutputAmount - BigInt(bytecodeSize);

        txOutputs.pop();

        if (changeAddress && remainder > BigInt(0)) {
          txOutputs.push({
            recipientAddress: changeAddress,
            amount: Number(remainder),
          });
        }

        console.log('txbuilder: ', txBuilder);

        const finalTransaction = await txBuilder.buildTransaction(
          selectedUtxos,
          txOutputs,
          selectedFunction,
          contractFunctionInputs
        );
        returnObj.finalTransaction = finalTransaction;
        returnObj.finalOutputs = txOutputs;

        returnObj.errorMsg = '';
      }
    } catch (err) {
      throw new Error(err);
    }
    return returnObj;
  };

  // Fetch private key using KeyService (refactored to avoid direct DB access)
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

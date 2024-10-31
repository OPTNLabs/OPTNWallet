//@ts-nocheck
import DatabaseService from '../DatabaseManager/DatabaseService';
import { TransactionHistoryItem } from '../../types/types'; // Assuming TransactionHistoryItem is defined in the types file
import ElectrumService from '../../services/ElectrumService';
import TransactionBuilderHelper from './TransactionBuilderHelper';
import { addTxOutput } from '../../redux/transactionBuilderSlice';
import { store } from '../../redux/store';
// import { TransactionOutput } from '../../types/types';

export default function TransactionManager() {
  const state = store.getState();

  const dbService = DatabaseService();

  // Define the function with proper return type and parameter types
  async function fetchAndStoreTransactionHistory(
    walletId: string,
    address: string
  ): Promise<void> {
    const db = dbService.getDatabase();
    if (!db) {
      throw new Error('Could not get database');
    }

    try {
      // Fetch transaction history using Electrum service
      const history: TransactionHistoryItem[] =
        await ElectrumService.getTransactionHistory(address);

      // Check if history is an array
      if (!Array.isArray(history)) {
        throw new Error('Invalid transaction history format');
      }

      const timestamp = new Date().toISOString();

      // Start a database transaction
      db.exec('BEGIN TRANSACTION');

      for (const tx of history) {
        console.log('TX:', tx);

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
  }
  async function sendTransaction(rawTX) {
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
  async function addOutput(
    recipientAddress, //mandatory
    transferAmount, //mandatory
    tokenAmount = '',
    selectedTokenCategory = '',
    selectedUtxos = [],
    addresses = []
  ) {
    if (recipientAddress && (transferAmount || tokenAmount)) {
      const newOutput = {
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
  const buildTransaction = async (
    outputs,
    contractFunctionInputs,
    changeAddress,
    selectedUtxos
  ) => {
    const selectedFunction = state.contract.selectedFunction;
    const txBuilder = TransactionBuilderHelper();
    const returnObj = {
      bytecodeSize: 0,
      finalTransaction: '',
      finalOutputs: null,
      errorMsg: '',
    };

    console.log(`txOutputs: ${JSON.stringify(outputs, null, 2)}`);
    console.log(`functionInputs: ${JSON.stringify(contractFunctionInputs)}`);

    try {
      // setLoading(true); // Show the loader
      const placeholderOutput = {
        recipientAddress: changeAddress,
        amount: 546,
      };
      const txOutputs = [...outputs, placeholderOutput];

      const transaction = await txBuilder.buildTransaction(
        selectedUtxos,
        txOutputs,
        selectedFunction,
        contractFunctionInputs // Pass contract function inputs here
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
          contractFunctionInputs // Ensure inputs are passed again here
        );
        returnObj.finalTransaction = finalTransaction;
        returnObj.finalOutputs = txOutputs;

        returnObj.errorMsg = '';
        // setShowRawTxPopup(true); // Show raw TX pop-up
      }
    } catch (err) {
      throw new Error(err);
    }
    return returnObj;
  };
  const fetchPrivateKey = async (
    address: string
  ): Promise<Uint8Array | null> => {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    const privateKeyQuery = `SELECT private_key FROM keys WHERE wallet_id = ? AND address = ?`;
    const privateKeyStatement = db.prepare(privateKeyQuery);
    privateKeyStatement.bind([state.wallet_id.currentWalletId, address]);
    let privateKey = new Uint8Array();
    while (privateKeyStatement.step()) {
      const row = privateKeyStatement.getAsObject();
      if (row.private_key) {
        privateKey = new Uint8Array(row.private_key);
      }
    }
    privateKeyStatement.free();
    return privateKey.length > 0 ? privateKey : null;
  };
  return {
    fetchAndStoreTransactionHistory,
    sendTransaction,
    addOutput,
    buildTransaction,
    fetchPrivateKey,
  };
}

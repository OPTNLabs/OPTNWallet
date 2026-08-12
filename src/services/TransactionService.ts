// src/services/TransactionService.ts

import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { Token, TransactionOutput, UTXO } from '../types/types';
import ContractManager from '../apis/ContractManager/ContractManager';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import {
  optimisticRemoveSpentByOutpoints,
  requestUTXORefreshForMany,
} from '../workers/UTXOWorkerService';

/**
 * TransactionService encapsulates all transaction-related business logic.
 */
class TransactionService {
  private dbService = DatabaseService();
  private contractManager = ContractManager();
  private transactionManager = TransactionManager();

  /**
   * Fetches addresses and UTXOs for a given walletId.
   *
   * @param walletId - The ID of the wallet.
   * @returns An object containing addresses, utxos, and contractAddresses.
   */
  async fetchAddressesAndUTXOs(walletId: number): Promise<{
    addresses: { address: string; tokenAddress: string }[];
    utxos: UTXO[];
    contractAddresses: {
      address: string;
      tokenAddress: string;
      contractName: string;
      abi: any[];
    }[];
  }> {
    await this.dbService.ensureDatabaseStarted();
    const db = this.dbService.getDatabase();

    if (!db) {
      throw new Error('Unable to get DB');
    }

    // Fetch addresses from keys table
    const addressesQuery = `SELECT address, token_address FROM keys WHERE wallet_id = ?`;
    const addressesStatement = db.prepare(addressesQuery);
    addressesStatement.bind([walletId]);

    const fetchedAddresses: { address: string; tokenAddress: string }[] = [];
    while (addressesStatement.step()) {
      const row = addressesStatement.getAsObject();
      if (
        typeof row.address === 'string' &&
        typeof row.token_address === 'string'
      ) {
        fetchedAddresses.push({
          address: row.address,
          tokenAddress: row.token_address,
        });
      }
    }
    addressesStatement.free();

    // Fetch UTXOs from UTXOs table, but only those that belong to addresses
    // present in the keys table for this wallet (no private key loading required).
    const utxosQuery = `
      SELECT u.*
      FROM UTXOs u
      JOIN keys k
        ON k.wallet_id = u.wallet_id
       AND k.address = u.address
      WHERE u.wallet_id = ?
    `;
    const utxosStatement = db.prepare(utxosQuery);
    utxosStatement.bind([walletId]);

    const fetchedUTXOs: UTXO[] = [];
    while (utxosStatement.step()) {
      const row = utxosStatement.getAsObject();

      // Convert row fields to appropriate types
      const address =
        typeof row.address === 'string' ? row.address : String(row.address);
      const amount =
        typeof row.amount === 'number' ? row.amount : Number(row.amount);
      const txHash =
        typeof row.tx_hash === 'string' ? row.tx_hash : String(row.tx_hash);
      const txPos =
        typeof row.tx_pos === 'number' ? row.tx_pos : Number(row.tx_pos);
      const height =
        typeof row.height === 'number' ? row.height : Number(row.height);

      const tokenData = row.token
        ? (JSON.parse(String(row.token)) as Token)
        : undefined;

      const contractFunction =
        typeof row.contractFunction === 'string' &&
        row.contractFunction.length > 0
          ? row.contractFunction
          : undefined;

      const contractFunctionInputs =
        typeof row.contractFunctionInputs === 'string' &&
        row.contractFunctionInputs.length > 0
          ? JSON.parse(row.contractFunctionInputs)
          : undefined;

      // Validate data (no private key validation here; keys are only needed at signing time)
      if (!isNaN(amount) && !isNaN(txPos) && !isNaN(height)) {
        const addressInfo = fetchedAddresses.find(
          (addr) => addr.address === address
        );

        fetchedUTXOs.push({
          id: `${txHash}:${txPos}`,
          address: address,
          tokenAddress: addressInfo ? addressInfo.tokenAddress : '',
          amount: amount,
          tx_hash: txHash,
          tx_pos: txPos,
          height: height,
          token: tokenData,
          value: amount,
          // **Assign New Fields**
          contractFunction,
          contractFunctionInputs,
        });
      } else {
        console.error('Invalid data in row:', row);
      }
    }
    utxosStatement.free();

    // Fetch contract instances
    const contractInstances =
      await this.contractManager.fetchContractInstances();

    // Fetch contract UTXOs
    const contractUTXOs = await Promise.all(
      contractInstances.map(async (contract) => {
        const contractUTXOs = contract.utxos;
        return contractUTXOs.map((utxo) => ({
          ...utxo,
          id: `${utxo.tx_hash}:${utxo.tx_pos}`,
          address: contract.address,
          tokenAddress: contract.token_address,
          contractName: contract.contract_name,
          abi: contract.abi,
        }));
      })
    ).then((results) => results.flat());

    const allUTXOs = [...fetchedUTXOs, ...contractUTXOs];

    // Fetch contractAddresses
    const contractAddressList = contractInstances.map((contract) => ({
      address: contract.address,
      tokenAddress: contract.token_address,
      contractName: contract.contract_name,
      abi: contract.abi,
    }));

    return {
      addresses: fetchedAddresses,
      utxos: allUTXOs,
      contractAddresses: contractAddressList,
    };
  }

  /**
   * Adds a new transaction output.
   *
   * @param recipientAddress - The recipient address.
   * @param transferAmount - The amount to transfer.
   * @param tokenAmount - The token amount to transfer.
   * @param selectedTokenCategory - The selected token category.
   * @param selectedUtxos - The selected UTXOs.
   * @param addresses - The list of addresses.
   * @returns The newly created TransactionOutput or undefined.
   */
  addOutput(
    recipientAddress: string,
    transferAmount: number,
    tokenAmount: number | bigint,
    selectedTokenCategory: string,
    selectedUtxos: UTXO[],
    addresses: { address: string; tokenAddress: string }[],
    nftCapability?: undefined | 'none' | 'mutable' | 'minting',
    nftCommitment?: string
  ): TransactionOutput | undefined {
    return this.transactionManager.addOutput(
      recipientAddress,
      transferAmount,
      tokenAmount,
      selectedTokenCategory,
      selectedUtxos,
      addresses,
      nftCapability,
      nftCommitment
    );
  }

  /**
   * Builds a transaction.
   *
   * @param outputs - The transaction outputs.
   * @param contractFunctionInputs - The contract function inputs.
   * @param changeAddress - The change address.
   * @param selectedUtxos - The selected UTXOs.
   * @returns An object containing bytecode size, final transaction, final outputs, and any error message.
   */
  async buildTransaction(
    outputs: TransactionOutput[],
    contractFunctionInputs: any,
    changeAddress: string,
    selectedUtxos: UTXO[]
  ): Promise<{
    bytecodeSize: number;
    finalTransaction: string;
    finalOutputs: TransactionOutput[] | null;
    errorMsg: string;
  }> {
    return await this.transactionManager.buildTransaction(
      outputs,
      contractFunctionInputs,
      changeAddress,
      selectedUtxos
    );
  }

  /**
   * Sends a transaction.
   *
   * @param rawTX - The raw transaction hex string.
   * @returns An object containing the transaction ID and any error message.
   */
  async sendTransaction(
    rawTX: string,
    spentInputs?: UTXO[]
  ): Promise<{
    txid: string | null;
    errorMessage: string | null;
  }> {
    const res = await this.transactionManager.sendTransaction(rawTX);

    // If broadcast succeeded, optimistically drop spent UTXOs and refresh those addresses
    if (res?.txid && spentInputs?.length) {
      const outpoints = spentInputs.map((u) => ({
        tx_hash: u.tx_hash,
        tx_pos: u.tx_pos,
      }));
      optimisticRemoveSpentByOutpoints(outpoints);

      const addrs = Array.from(
        new Set(spentInputs.map((u) => u.address).filter(Boolean))
      );
      requestUTXORefreshForMany(addrs, 0);
    }

    return res;
  }
}

// Export a singleton instance
const instance = new TransactionService();
export default instance;

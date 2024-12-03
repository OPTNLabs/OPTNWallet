// src/services/TransactionService.ts

import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { TransactionOutput, UTXO } from '../types/types';
import ContractManager from '../apis/ContractManager/ContractManager';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import KeyService from '../services/KeyService';

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

    console.log('Fetched addresses from DB:', fetchedAddresses);

    // Fetch UTXOs from UTXOs table
    const utxosQuery = `SELECT * FROM UTXOs WHERE wallet_id = ?`;
    const utxosStatement = db.prepare(utxosQuery);
    utxosStatement.bind([walletId]);
    const fetchedUTXOs: UTXO[] = [];
    while (utxosStatement.step()) {
      const row = utxosStatement.getAsObject();
      console.log('Fetched UTXO row:', row);

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
      const tokenData = row.token_data
        ? JSON.parse(String(row.token_data))
        : undefined;

      // Fetch the private key
      const privateKey = await KeyService.fetchAddressPrivateKey(address);

      // Validate data
      if (privateKey && !isNaN(amount) && !isNaN(txPos) && !isNaN(height)) {
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
          privateKey: privateKey,
          token_data: tokenData,
          value: amount,
        });
      } else {
        console.error('Invalid data in row or private key not found:', row);
      }
    }
    utxosStatement.free();
    console.log('Fetched UTXOs:', fetchedUTXOs);

    // Fetch contract instances
    const contractInstances =
      await this.contractManager.fetchContractInstances();
    console.log('Fetched contract instances:', contractInstances);

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

    console.log('Fetched contract UTXOs:', contractUTXOs);

    const allUTXOs = [...fetchedUTXOs, ...contractUTXOs];

    const addressesWithUTXOs = fetchedAddresses.filter((addressObj) =>
      allUTXOs.some((utxo) => utxo.address === addressObj.address)
    );

    // Fetch contractAddresses
    const contractAddressList = contractInstances.map((contract) => ({
      address: contract.address,
      tokenAddress: contract.token_address,
      contractName: contract.contract_name,
      abi: contract.abi,
    }));

    return {
      addresses: addressesWithUTXOs,
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
    tokenAmount: number,
    selectedTokenCategory: string,
    selectedUtxos: UTXO[],
    addresses: { address: string; tokenAddress: string }[]
  ): TransactionOutput | undefined {
    return this.transactionManager.addOutput(
      recipientAddress,
      transferAmount,
      tokenAmount,
      selectedTokenCategory,
      selectedUtxos,
      addresses
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
  async sendTransaction(rawTX: string): Promise<{
    txid: string | null;
    errorMessage: string | null;
  }> {
    return await this.transactionManager.sendTransaction(rawTX);
  }

  /**
   * Fetches the private key for a given address.
   *
   * @param address - The address to fetch the private key for.
   * @returns A Uint8Array representing the private key or null if not found.
   */
  async fetchPrivateKey(address: string): Promise<Uint8Array | null> {
    return await KeyService.fetchAddressPrivateKey(address);
  }
}

// Export a singleton instance
const instance = new TransactionService();
export default instance;

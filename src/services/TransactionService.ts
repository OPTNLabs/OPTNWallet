// src/services/TransactionService.ts

import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import {
  ContractAddressRecord,
  Token,
  TransactionOutput,
  UTXO,
} from '../types/types';
import ContractManager from '../apis/ContractManager/ContractManager';
import type { ContractInstanceRow } from '../apis/ContractManager/ContractManager';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import {
  optimisticRemoveSpentByOutpoints,
  requestUTXORefreshForMany,
} from '../workers/UTXOWorkerService';
import KeyService from './KeyService';
import { store } from '../redux/store';
import { logError } from '../utils/errorHandling';
import OutboundTransactionTracker, {
  deriveTrackedTxid,
} from './OutboundTransactionTracker';

export type BroadcastState = 'broadcasted' | 'submitted';
export type BroadcastResult = {
  txid: string | null;
  errorMessage: string | null;
  broadcastState?: BroadcastState;
};

export type SendTransactionOptions = {
  source?: string;
  sourceLabel?: string | null;
  recipientSummary?: string | null;
  amountSummary?: string | null;
  sessionTopic?: string | null;
  dappName?: string | null;
  dappUrl?: string | null;
  requestId?: string | null;
  userPrompt?: string | null;
};

export type BatchedTransactionRequest = {
  rawTX: string;
  spentInputs?: UTXO[];
  options?: SendTransactionOptions;
};

/**
 * TransactionService encapsulates all transaction-related business logic.
 */
class TransactionService {
  private dbService = DatabaseService();
  private contractManager = ContractManager();
  private transactionManager = TransactionManager();

  private schedulePostBroadcastRefresh(addresses: string[]): void {
    const unique = Array.from(new Set(addresses.filter(Boolean)));
    if (unique.length === 0) return;

    // Refresh immediately, then once more after propagation delay so
    // wallet and contract UTXO views converge even if Electrum lags briefly.
    requestUTXORefreshForMany(unique, 0);
    requestUTXORefreshForMany(unique, 1500);
  }

  private async enrichTrackedAttempt(
    rawTX: string,
    spentInputs?: UTXO[],
    options?: SendTransactionOptions
  ): Promise<void> {
    const currentWalletId = store.getState().wallet_id.currentWalletId ?? null;
    await OutboundTransactionTracker.trackAttempt({
      rawTx: rawTX,
      walletId: currentWalletId,
      source: options?.source ?? 'wallet',
      sourceLabel: options?.sourceLabel ?? null,
      recipientSummary: options?.recipientSummary ?? null,
      amountSummary: options?.amountSummary ?? null,
      sessionTopic: options?.sessionTopic ?? null,
      dappName: options?.dappName ?? null,
      dappUrl: options?.dappUrl ?? null,
      requestId: options?.requestId ?? null,
      userPrompt: options?.userPrompt ?? null,
      spentInputs,
    });
  }

  private async collectRefreshAddresses(spentInputs?: UTXO[]): Promise<string[]> {
    const currentWalletId = store.getState().wallet_id.currentWalletId ?? null;
    const addrs = new Set<string>(
      spentInputs?.map((u) => u.address).filter(Boolean) ?? []
    );
    if (currentWalletId) {
      try {
        const keyPairs = await KeyService.retrieveKeys(currentWalletId);
        for (const key of keyPairs ?? []) {
          if (key.address) addrs.add(key.address);
        }
      } catch (error) {
        logError(
          'TransactionService.collectRefreshAddresses.retrieveKeysAfterBroadcast',
          error,
          { walletId: currentWalletId }
        );
      }
    }
    return Array.from(addrs);
  }

  /**
   * Fetches addresses and UTXOs for a given walletId.
   *
   * @param walletId - The ID of the wallet.
   * @returns An object containing addresses, utxos, and contractAddresses.
   */
  async fetchAddressesAndUTXOs(walletId: number): Promise<{
    addresses: { address: string; tokenAddress: string }[];
    utxos: UTXO[];
    contractAddresses: ContractAddressRecord[];
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
    const tokenAddressByAddress = new Map(
      fetchedAddresses.map((item) => [item.address, item.tokenAddress])
    );

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
        fetchedUTXOs.push({
          id: `${txHash}:${txPos}`,
          address: address,
          tokenAddress: tokenAddressByAddress.get(address) ?? '',
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
        logError('TransactionService.fetchAddressesAndUTXOs.invalidRow', row, {
          walletId,
        });
      }
    }
    utxosStatement.free();

    // Fetch contract instances
    const contractInstances: ContractInstanceRow[] =
      await this.contractManager.fetchContractInstances();

    // Fetch contract UTXOs
    const contractUTXOs: UTXO[] = contractInstances.flatMap((contract) =>
      contract.utxos.map((utxo) => {
        const txHash = String(utxo.tx_hash);
        const txPos = Number(utxo.tx_pos);
        const amountNum = Number(utxo.amount);
        const heightNum =
          typeof utxo.height === 'number'
            ? utxo.height
            : Number(utxo.height ?? 0);
        const contractFunctionInputs =
          utxo.contractFunctionInputs &&
          typeof utxo.contractFunctionInputs === 'object'
            ? utxo.contractFunctionInputs
            : undefined;

        return {
          id: `${txHash}:${txPos}`,
          tx_hash: txHash,
          tx_pos: txPos,
          amount: amountNum,
          value: amountNum,
          height: heightNum,
          address: contract.address,
          tokenAddress: contract.token_address,
          contractName: contract.contract_name,
          abi: contract.abi,
          token:
            utxo.token && typeof utxo.token === 'object'
              ? (utxo.token as Token)
              : undefined,
          contractFunction: utxo.contractFunction || undefined,
          contractFunctionInputs,
        } as UTXO;
      })
    );

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
    contractFunctionInputs: Record<string, unknown> | null,
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
    spentInputs?: UTXO[],
    options?: SendTransactionOptions
  ): Promise<BroadcastResult> {
    const currentWalletId = store.getState().wallet_id.currentWalletId ?? null;
    const currentTxid = deriveTrackedTxid(rawTX);
    const activeOutbound = currentWalletId
      ? await OutboundTransactionTracker.listActive(currentWalletId)
      : [];
    const conflictingPending = activeOutbound.find(
      (record) => !currentTxid || record.txid !== currentTxid
    );

    if (conflictingPending) {
      return {
        txid: null,
        errorMessage:
          'Another outgoing transaction is still syncing. Wait for it to appear in history before sending a new one.',
      };
    }

    const res: BroadcastResult =
      await this.transactionManager.sendTransaction(rawTX);
    const trackedTxid = deriveTrackedTxid(rawTX);

    if (res?.errorMessage || !res?.txid) {
      if (trackedTxid) {
        await OutboundTransactionTracker.remove(trackedTxid);
      }
      return res;
    }

    if (res?.txid) {
      await this.enrichTrackedAttempt(rawTX, spentInputs, options);
    }

    // Refresh wallet addresses after any successful hand-off, but only
    // remove spendable UTXOs optimistically when broadcast was definite.
    if (res?.txid) {
      if (spentInputs?.length && res.broadcastState === 'broadcasted') {
        const outpoints = spentInputs.map((u) => ({
          tx_hash: u.tx_hash,
          tx_pos: u.tx_pos,
        }));
        optimisticRemoveSpentByOutpoints(outpoints);
      }

      this.schedulePostBroadcastRefresh(
        await this.collectRefreshAddresses(spentInputs)
      );
    }

    return res;
  }

  async sendTransactionBatch(
    requests: BatchedTransactionRequest[]
  ): Promise<BroadcastResult[]> {
    const currentWalletId = store.getState().wallet_id.currentWalletId ?? null;
    const activeOutbound = currentWalletId
      ? await OutboundTransactionTracker.listActive(currentWalletId)
      : [];
    const reserved = new Set(
      activeOutbound.flatMap((record) =>
        record.spentOutpoints.map((outpoint) => `${outpoint.tx_hash}:${outpoint.tx_pos}`)
      )
    );
    const seenBatchOutpoints = new Set<string>();

    for (const request of requests) {
      for (const utxo of request.spentInputs ?? []) {
        const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
        if (reserved.has(outpointKey) || seenBatchOutpoints.has(outpointKey)) {
          return [
            {
              txid: null,
              errorMessage:
                'Another outgoing transaction is already using one of these UTXOs.',
            },
          ];
        }
        seenBatchOutpoints.add(outpointKey);
      }
    }

    const results: BroadcastResult[] = [];
    const refreshAddresses = new Set<string>();

    for (const request of requests) {
      const result = await this.transactionManager.sendTransaction(request.rawTX);
      results.push(result);

      const trackedTxid = deriveTrackedTxid(request.rawTX);
      if (result?.errorMessage || !result?.txid) {
        if (trackedTxid) {
          await OutboundTransactionTracker.remove(trackedTxid);
        }
        break;
      }

      await this.enrichTrackedAttempt(
        request.rawTX,
        request.spentInputs,
        request.options
      );

      if (request.spentInputs?.length && result.broadcastState === 'broadcasted') {
        optimisticRemoveSpentByOutpoints(
          request.spentInputs.map((u) => ({
            tx_hash: u.tx_hash,
            tx_pos: u.tx_pos,
          }))
        );
      }

      const addresses = await this.collectRefreshAddresses(request.spentInputs);
      for (const address of addresses) {
        refreshAddresses.add(address);
      }
    }

    if (refreshAddresses.size > 0) {
      this.schedulePostBroadcastRefresh(Array.from(refreshAddresses));
    }

    return results;
  }
}

// Export a singleton instance
const instance = new TransactionService();
export default instance;
